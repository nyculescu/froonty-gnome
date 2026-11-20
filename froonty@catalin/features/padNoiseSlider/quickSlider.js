// SPDX-License-Identifier: GPL-3.0-or-later
// llano pad speed slider in Quick Settings. The speed moves in the pad's
// own 50 RPM steps: dragging the knob, or pressing beside it, which steps
// toward the pointer while held. Hovering shows the speed; the fan icon
// switches the pad off and on, and the arrow opens the Fan settings.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickSlider} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {Tooltip} from '../../core/tooltip.js';
import {fanIcon, fanOffIcon} from '../fan/icon.js';
import * as Pad from '../fan/pad.js';
import {SYSTEM_IO} from '../sysmon/io.js';
import {addUnderBrightness} from '../../shell/quickSettings.js';
import {RPM_STEP, rpmToSlider, sliderToRpm, snapRpm} from './noiseStages.js';

const POLL_S = 5;
const APPLY_DELAY_MS = 250;
// Pressing beside the knob: one step at once, then more while held.
const STEP_DELAY_MS = 400;
const STEP_REPEAT_MS = 100;

const PadNoiseSlider = GObject.registerClass(
class PadNoiseSlider extends QuickSlider {
    _init(openSettings, describe) {
        super._init({
            gicon: fanIcon(),
            iconLabel: _('Turn the pad off'),
        });
        this.accessible_name = _('llano pad speed');
        this.slider.accessible_name = _('Pad speed');

        // GNOME's own menu arrow opens this.menu; this one opens the Fan page.
        const sliderRow = this.get_child();
        sliderRow.x_expand = true;
        // GNOME spaces the row as `.quick-slider > StBoxLayout`, which it no
        // longer is once wrapped in `content` below.
        sliderRow.add_style_class_name('froonty-pad-slider-row');
        this._settingsButton = new St.Button({
            child: new St.Icon({icon_name: 'go-next-symbolic'}),
            style_class: 'icon-button flat',
            can_focus: true,
            y_expand: true,
            accessible_name: _('Fan settings'),
        });
        this._settingsButton.connect('clicked', () => openSettings('fan'));
        sliderRow.add_child(this._settingsButton);

        const content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.set_child(content);
        content.add_child(sliderRow);
        this._statusLabel = new St.Label({
            style_class: 'dim-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        content.add_child(this._statusLabel);

        // In the top-level UI group: the Quick Settings menu clips its content.
        this._describe = describe;
        this._tooltip = new Tooltip();
        Main.layoutManager.uiGroup.add_child(this._tooltip.actor);
        this._tooltip.attach(this.slider, describe, 'above');
        this.slider.connect('notify::value', () => this.updateTooltip());

        // Private: GNOME's Slider jumps to the pointer through this gesture;
        // it now takes only presses on the knob, the rest step.
        this._stepTimerId = 0;
        const pan = this.slider._panGesture;
        pan?.connect('may-recognize', () => this._onKnob(pan.get_centroid().x));
        this.slider.connect('button-press-event', (_slider, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY || !this.slider.reactive ||
                this._onKnob(this._localX(...event.get_coords())))
                return Clutter.EVENT_PROPAGATE;
            this._startStepping();
            return Clutter.EVENT_STOP;
        });
        this.connect('destroy', () => {
            this._stopStepping();
            this._tooltip.actor.destroy();
            this._tooltip = null;
        });
    }

    updateTooltip() {
        if (this._tooltip && this.slider.hover)
            this._tooltip.show(this.slider, this._describe(), 'above');
    }

    _localX(stageX, stageY) {
        return this.slider.transform_stage_point(stageX, stageY)[1];
    }

    // Where the knob's centre is drawn, and the span it moves over.
    _geometry() {
        const radius = this.slider.get_theme_node().get_length('-slider-handle-radius');
        const span = Math.max(1, this.slider.width - 2 * radius);
        return {radius, span, knob: radius + span * this.slider.value};
    }

    _onKnob(x) {
        const {radius, knob} = this._geometry();
        return Math.abs(x - knob) <= radius + 2;
    }

    // One 50 RPM step toward the pointer; false once the knob is there.
    _stepTowardPointer() {
        const [stageX, stageY] = global.get_pointer();
        const {radius, span} = this._geometry();
        const target = sliderToRpm((this._localX(stageX, stageY) - radius) / span);
        const current = sliderToRpm(this.slider.value);
        if (target === current)
            return false;
        this.slider.value = rpmToSlider(current + (target > current ? RPM_STEP : -RPM_STEP));
        return true;
    }

    _startStepping() {
        this._stopStepping();
        this._stepTowardPointer();
        this._stepTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, STEP_DELAY_MS, () => {
            this._stepTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, STEP_REPEAT_MS, () => {
                const [, , mods] = global.get_pointer();
                if (!(mods & Clutter.ModifierType.BUTTON1_MASK) || !this.slider.reactive) {
                    this._stepTimerId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                // Held still at the knob, it waits there for the pointer to move on.
                this._stepTowardPointer();
                return GLib.SOURCE_CONTINUE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopStepping() {
        if (this._stepTimerId)
            GLib.source_remove(this._stepTimerId);
        this._stepTimerId = 0;
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
        // The next llano.py command to send (['rpm', N] or ['off']), or null.
        this._pending = null;
        this._changeGeneration = 0;
        this._rpm = 600;
        // The whole pad off (llano.py off or lock); the slider keeps the speed to go back to.
        this._off = false;
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
            this._slider = new PadNoiseSlider(this._openSettings, () => this._describe());
            this._slider.slider.value = rpmToSlider(this._rpm);
            this._slider.slider.connectObject('notify::value', () => this._onSliderValue(), this);
            this._slider.connectObject('icon-clicked', () => this._onIconClicked(), this);
            this._cancelPlace = addUnderBrightness(this._slider, 1);
            // The pad is polled only while the slider can be seen.
            const menu = Main.panel.statusArea.quickSettings.menu;
            menu.connectObject('open-state-changed', (_menu, open) => this._poll(open), this);
            this._refresh();
            this._poll(menu.isOpen);
        }
    }

    _poll(on) {
        if (on && !this._timerId) {
            this._refresh();
            this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_S, () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!on && this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }

    _hide() {
        Main.panel.statusArea.quickSettings.menu.disconnectObject(this);
        this._poll(false);
        if (this._applyTimerId)
            GLib.source_remove(this._applyTimerId);
        this._applyTimerId = 0;
        this._pending = null;
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
            const present = await this._padConnected();
            // Hidden or destroyed meanwhile.
            if (!this._slider)
                return;
            this._padPresent = present;
            if (!this._padPresent) {
                // A command the pad never got must not stop following it later.
                this._pending = null;
                this._error = '';
                this._syncSlider();
                return;
            }
            const result = await Pad.llano(this._settings.get_string('fan-llano-path'), ['status']);
            if (!this._slider)
                return;
            if (result.error) {
                this._error = result.message || result.error;
            } else {
                this._error = '';
                if (generation === this._changeGeneration &&
                    this._pending === null && !this._applying)
                    this._follow(result);
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

    // Takes the pad's state from llano.py's output; while it is off, the
    // knob stays at the speed it was turned off from.
    _follow(result) {
        this._off = result.status.off;
        if (this._off || result.noise?.rpm === undefined)
            return;
        this._rpm = snapRpm(result.noise.rpm);
        this._following = true;
        this._slider.slider.value = rpmToSlider(this._rpm);
        // Private: GNOME's base for the next scroll or arrow key, still the
        // last dragged position otherwise.
        this._slider.slider._unsnappedValue = null;
        this._following = false;
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
        this._rpm = sliderToRpm(this._slider.slider.value);
        // The knob moves in the pad's 50 RPM steps, not freely.
        this._following = true;
        this._slider.slider.value = rpmToSlider(this._rpm);
        // Private, as above: the next step starts from the snapped speed.
        this._slider.slider._unsnappedValue = null;
        this._following = false;
        // Any speed switches the pad back on.
        this._send(['rpm', String(this._rpm)], APPLY_DELAY_MS);
    }

    _onIconClicked() {
        this._send(this._off ? ['rpm', String(this._rpm)] : ['off'], 0);
    }

    _send(args, delayMs) {
        this._changeGeneration++;
        this._off = args[0] === 'off';
        this._error = '';
        this._syncSlider();
        if (!this._padPresent)
            return;
        this._pending = args;
        if (this._applyTimerId)
            GLib.source_remove(this._applyTimerId);
        this._applyTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._applyTimerId = 0;
            this._applyPending();
            return GLib.SOURCE_REMOVE;
        });
    }

    _describe() {
        if (!this._padPresent)
            return _('Pad not connected');
        return this._off ? _('Off') : _('%d RPM').format(this._rpm);
    }

    _syncSlider() {
        if (!this._slider)
            return;
        this._slider.updateTooltip();
        const usable = this._padPresent && !this._error;
        this._slider.slider.reactive = usable;
        this._slider.slider.can_focus = usable;
        this._slider.iconReactive = usable;
        if (this._slider._shownOff !== this._off) {
            this._slider._shownOff = this._off;
            this._slider.gicon = this._off ? fanOffIcon() : fanIcon();
            this._slider.iconLabel = this._off ? _('Turn the pad on') : _('Turn the pad off');
        }
        // Only something to act on: an error, or no pad to adjust.
        const status = this._error
            ? _('Pad unavailable: %s').format(this._error)
            : this._padPresent ? '' : _('Connect the llano pad to adjust its speed');
        this._slider._statusLabel.text = status;
        this._slider._statusLabel.visible = Boolean(status);
    }

    async _applyPending() {
        if (this._applying || this._pending === null || !this._padPresent)
            return;
        this._applying = true;
        try {
            while (this._pending !== null && this._padPresent) {
                const args = this._pending;
                this._pending = null;
                const result = await Pad.llano(this._settings.get_string('fan-llano-path'), args);
                if (!this._slider)
                    return;
                if (result.error) {
                    this._error = result.message || result.error;
                    this._pending = null;
                    break;
                }
                this._changeGeneration++;
                this._error = '';
                if (this._pending === null)
                    this._off = result.status.off;
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
