// SPDX-License-Identifier: GPL-3.0-or-later
// llano pad speed slider with the noise stages as dots on its track (a
// tooltip names each on hover; a click goes there). The speed moves in the
// pad's own 50 RPM steps.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickSlider} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {Tooltip} from '../../core/tooltip.js';

import {fanIcon} from '../fan/icon.js';
import * as Pad from '../fan/pad.js';
import {SYSTEM_IO} from '../sysmon/io.js';
import {addUnderBrightness} from '../../shell/quickSettings.js';
import {
    NOISE_STAGES, rpmToSlider, sliderToRpm, snapRpm,
} from './noiseStages.js';

const POLL_S = 5;
const APPLY_DELAY_MS = 250;

function stageText(stage) {
    return _('%s · %d RPM').format(_(stage.name), stage.rpm);
}

function prioritizeSliderHandle(slider, dots) {
    const width = slider.get_width();
    if (!width)
        return;
    const radius = slider.get_stage()
        ? slider.get_theme_node().get_length('-slider-handle-radius') : 0;
    const trackWidth = Math.max(0, width - 2 * radius);
    const handleX = radius + trackWidth * slider.value;
    for (const dot of dots) {
        const dotX = radius + trackWidth * dot._fraction;
        // Let the slider receive presses on its knob, even when a stage dot
        // is directly underneath it. The slider then owns the drag sequence.
        dot.reactive = Math.abs(dotX - handleX) > radius + 6;
    }
}

// Puts each dot where the slider's knob is drawn for its value: GNOME's
// Slider centres the knob at radius + (width - 2 radius) x value.
const DotsLayout = GObject.registerClass(
class DotsLayout extends Clutter.LayoutManager {
    _init(slider) {
        super._init();
        this._slider = slider;
    }

    vfunc_get_preferred_width() {
        return [0, 0];
    }

    vfunc_get_preferred_height() {
        return [0, 0];
    }

    vfunc_allocate(container, box) {
        const width = box.get_width();
        const height = box.get_height();
        const radius = this._slider.get_stage()
            ? this._slider.get_theme_node().get_length('-slider-handle-radius') : 0;
        for (const dot of container.get_children()) {
            const [, w] = dot.get_preferred_width(-1);
            const [, h] = dot.get_preferred_height(w);
            const x = radius + (width - 2 * radius) * dot._fraction - w / 2;
            const y = (height - h) / 2;
            const child = new Clutter.ActorBox();
            child.set_origin(Math.round(x), Math.round(y));
            child.set_size(w, h);
            dot.allocate(child);
        }
    }
});

const PadNoiseSlider = GObject.registerClass(
class PadNoiseSlider extends QuickSlider {
    _init(openSettings) {
        super._init({
            // The bundled icon works where weather-wind is missing.
            gicon: fanIcon(),
            iconLabel: _('llano pad speed'),
            style_class: 'quick-slider froonty-pad-noise-slider',
        });
        this._openSettings = openSettings;
        this.icon_reactive = true;
        this.connect('icon-clicked', () => this._openSettings('fan'));
        this.accessible_name = _('llano pad speed');
        this.slider.accessible_name = _('Pad speed');

        const sliderRow = this.get_child();
        sliderRow.x_expand = true;
        const content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.set_child(content);
        this._sliderRow = sliderRow;
        content.add_child(sliderRow);

        // The slider and, over it, a layer with one dot per noise stage, in
        // the QuickSlider's slider-bin (an St.Bin around the slider: focus
        // ring, events passed on), where the slider was.
        const slider = this.slider;
        const sliderBin = slider.get_parent();
        const stack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
        });
        sliderBin.set_child(null);
        stack.add_child(slider);
        this._dots = new St.Widget({
            layout_manager: new DotsLayout(slider),
            x_expand: true,
            y_expand: true,
        });
        stack.add_child(this._dots);
        sliderBin.set_child(stack);

        // In the top-level UI group: the Quick Settings menu clips its content.
        this._tooltip = new Tooltip();
        Main.layoutManager.uiGroup.add_child(this._tooltip.actor);
        for (const stage of NOISE_STAGES) {
            const dot = new St.Widget({
                style_class: 'froonty-pad-noise-dot',
                style: `background-color: ${stage.color};`,
                reactive: true,
                track_hover: true,
                accessible_name: stageText(stage),
            });
            dot._fraction = rpmToSlider(stage.rpm);
            this._tooltip.attach(dot, () => stageText(stage), 'above');
            // Over the track, a click goes to that stage (the slider below never sees it).
            dot.connect('button-press-event', () => {
                if (slider.reactive)
                    slider.value = dot._fraction;
                return Clutter.EVENT_STOP;
            });
            this._dots.add_child(dot);
        }
        const updateDotInput = () => prioritizeSliderHandle(slider, this._dots.get_children());
        slider.connect('notify::value', updateDotInput);
        slider.connect('notify::width', updateDotInput);
        updateDotInput();
        this.connect('destroy', () => {
            this._tooltip.actor.destroy();
            this._tooltip = null;
        });
        this._statusLabel = new St.Label({
            style_class: 'dim-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        content.add_child(this._statusLabel);
    }
});

export class PadNoiseSliderPart {
    constructor(settings, openSettings) {
        this._settings = settings;
        this._openSettings = openSettings;
        this._slider = null;
        this._cancelPlace = null;
        this._timerId = 0;
        this._applyTimerId = 0;
        this._refreshing = false;
        this._applying = false;
        this._padPresent = false;
        this._following = false;
        this._pendingRpm = null;
        this._changeGeneration = 0;
        this._rpm = 600;
        this._error = '';
        this._settings.connectObject(
            'changed::cooling-slider-enabled', () => this._sync(), this);
        this._settings.connectObject(
            'changed::fan-llano-path', () => this._refresh(), this);
        this._sync();
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._hide();
        this._settings = null;
    }

    _sync() {
        if (this._settings.get_boolean('cooling-slider-enabled'))
            this._show();
        else
            this._hide();
    }

    _show() {
        if (!this._slider) {
            this._slider = new PadNoiseSlider(this._openSettings);
            this._slider.slider.value = rpmToSlider(this._rpm);
            this._slider.slider.connectObject('notify::value', () => this._onSliderValue(), this);
            this._cancelPlace = addUnderBrightness(this._slider);
        }
        if (!this._timerId) {
            this._refresh();
            this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_S, () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    _hide() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = 0;
        if (this._applyTimerId)
            GLib.source_remove(this._applyTimerId);
        this._applyTimerId = 0;
        this._pendingRpm = null;
        this._cancelPlace?.();
        this._cancelPlace = null;
        if (this._slider) {
            this._slider.menu.destroy();
            this._slider.destroy();
        }
        this._slider = null;
        this._padPresent = false;
    }

    async _refresh() {
        if (this._refreshing || this._applying || !this._slider)
            return;
        const generation = this._changeGeneration;
        this._refreshing = true;
        try {
            this._padPresent = await this._padConnected();
            if (!this._padPresent) {
                this._error = '';
                this._syncSlider();
                return;
            }
            const result = await Pad.llano(this._settings.get_string('fan-llano-path'), ['status']);
            if (result.error) {
                this._error = result.message || result.error;
            } else {
                this._error = '';
                if (result.noise?.rpm !== undefined &&
                    generation === this._changeGeneration &&
                    this._pendingRpm === null && !this._applying) {
                    this._rpm = snapRpm(result.noise.rpm);
                    this._following = true;
                    this._slider.slider.value = rpmToSlider(this._rpm);
                    this._following = false;
                }
            }
            this._syncSlider();
        } catch (e) {
            this._error = e.message;
            logError(e, 'Froonty pad noise slider');
            this._syncSlider();
        } finally {
            this._refreshing = false;
        }
    }

    async _padConnected() {
        const root = '/sys/bus/hid/devices';
        const devices = await SYSTEM_IO.list(root);
        const events = await Promise.all(devices.map(device =>
            SYSTEM_IO.read(`${root}/${device}/uevent`)));
        return events.some(text => /^HID_ID=0003:0000374A:0000B101$/im.test(text ?? ''));
    }

    _onSliderValue() {
        if (this._following)
            return;
        this._changeGeneration++;
        this._rpm = sliderToRpm(this._slider.slider.value);
        // The knob moves in the pad's 50 RPM steps, not freely.
        this._following = true;
        this._slider.slider.value = rpmToSlider(this._rpm);
        this._following = false;
        this._error = '';
        this._syncSlider();
        if (!this._padPresent)
            return;
        this._pendingRpm = this._rpm;
        if (this._applyTimerId)
            GLib.source_remove(this._applyTimerId);
        this._applyTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, APPLY_DELAY_MS, () => {
            this._applyTimerId = 0;
            this._applyPending();
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncSlider() {
        if (!this._slider)
            return;
        this._slider.slider.reactive = this._padPresent && !this._error;
        this._slider.slider.can_focus = this._padPresent && !this._error;
        // Only something to act on: an error, or no pad to adjust.
        const status = this._error
            ? _('Pad unavailable: %s').format(this._error)
            : this._padPresent ? '' : _('Connect the llano pad to adjust its speed');
        this._slider._statusLabel.text = status;
        this._slider._statusLabel.visible = Boolean(status);
    }

    async _applyPending() {
        if (this._applying || this._pendingRpm === null || !this._padPresent)
            return;
        this._applying = true;
        try {
            while (this._pendingRpm !== null && this._padPresent) {
                const rpm = this._pendingRpm;
                this._pendingRpm = null;
                const result = await Pad.llano(this._settings.get_string('fan-llano-path'),
                    ['rpm', String(rpm)]);
                if (result.error) {
                    this._error = result.message || result.error;
                    this._pendingRpm = null;
                    break;
                }
                this._changeGeneration++;
                this._error = '';
            }
        } catch (e) {
            this._error = e.message;
            logError(e, 'Froonty pad noise slider');
        } finally {
            this._applying = false;
            this._syncSlider();
        }
    }
}
