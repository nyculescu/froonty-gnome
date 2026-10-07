// SPDX-License-Identifier: GPL-3.0-or-later
// Software display brightness (docs/features/brightness.md): a black layer
// over the chosen monitors, and its slider in Quick Settings under GNOME's.
// No DDC/CI and no backlight: for monitors GNOME cannot dim. No pointer
// tracking or cursor clone either: the layer takes no input and is left
// out of picking, so GNOME's own pointer stays the only one, on top.
//
// An extension part (extension.js): it lives while Froonty runs and
// follows brightness-enabled itself.

import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickSlider} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {addUnderBrightness} from '../../shell/quickSettings.js';
import {appliedLevel, levelFromSlider, overlayOpacity, sliderValue, targetMonitors} from './levels.js';

const KEYS = ['brightness-enabled', 'brightness-level', 'brightness-min', 'brightness-monitors'];

const BrightnessSlider = GObject.registerClass(
class BrightnessSlider extends QuickSlider {
    _init() {
        super._init({iconName: 'display-brightness-symbolic'});
        this.slider.accessible_name = _('Software brightness');
    }
});

/** Indices of the built-in panels, as in Main.layoutManager.monitors. */
function builtInMonitors() {
    return new Set(global.backend.get_monitor_manager().get_logical_monitors()
        .filter(logical => logical.get_monitors().some(monitor => monitor.is_builtin()))
        .map(logical => logical.get_number()));
}

export class SoftwareBrightness {
    constructor(settings) {
        this._settings = settings;
        this._layer = null;
        this._overlays = [];
        this._slider = null;
        this._cancelPlace = null;
        // Set while the slider is moved to the setting, not by the user.
        this._following = false;
        for (const key of KEYS)
            settings.connectObject(`changed::${key}`, () => this._sync(), this);
        this._sync();
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._hide();
        this._settings = null;
    }

    _sync() {
        if (!this._settings.get_boolean('brightness-enabled')) {
            this._hide();
            return;
        }
        this._show();
        this._apply();
    }

    _show() {
        if (this._layer)
            return;
        this._layer = new St.Widget({name: 'froonty-brightness', reactive: false});
        Shell.util_set_hidden_from_pick(this._layer, true);
        global.stage.add_child(this._layer);
        // Above everything else on the stage, as long as it is on.
        global.stage.connectObject('child-added', () => this._raise(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._apply(), this);

        this._slider = new BrightnessSlider();
        this._slider.slider.connectObject('notify::value', () => {
            if (this._following)
                return;
            const minimum = this._settings.get_int('brightness-min');
            this._settings.set_int('brightness-level',
                levelFromSlider(this._slider.slider.value, minimum));
        }, this);
        this._cancelPlace = addUnderBrightness(this._slider);
    }

    _hide() {
        this._cancelPlace?.();
        this._cancelPlace = null;
        if (this._slider) {
            // Quick Settings put the slider's (unused) menu in an overlay
            // of its own (ui/quickSettings.js, _completeAddItem): it goes too.
            this._slider.menu.destroy();
            this._slider.destroy();
            this._slider = null;
        }
        global.stage.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._layer?.destroy();
        this._layer = null;
        this._overlays = [];
    }

    _apply() {
        const level = appliedLevel(this._settings.get_int('brightness-level'),
            this._settings.get_int('brightness-min'));
        const monitors = Main.layoutManager.monitors;
        const dimmed = level < 100
            ? targetMonitors(this._settings.get_string('brightness-monitors'),
                monitors.length, builtInMonitors()).map(i => monitors[i])
            : [];

        while (this._overlays.length < dimmed.length) {
            const overlay = new St.Widget({reactive: false, style: 'background-color: black;'});
            Shell.util_set_hidden_from_pick(overlay, true);
            this._layer.add_child(overlay);
            this._overlays.push(overlay);
        }
        for (const overlay of this._overlays.splice(dimmed.length))
            overlay.destroy();
        dimmed.forEach(({x, y, width, height}, i) => {
            this._overlays[i].set({x, y, width, height, opacity: overlayOpacity(level)});
        });
        this._raise();

        // The slider follows the setting unless it already stands for it
        // (while it is dragged, each step is written as it comes).
        const minimum = this._settings.get_int('brightness-min');
        const slider = this._slider.slider;
        if (levelFromSlider(slider.value, minimum) !== level) {
            this._following = true;
            slider.value = sliderValue(level, minimum);
            this._following = false;
        }
    }

    _raise() {
        global.stage.set_child_above_sibling(this._layer, null);
    }
}
