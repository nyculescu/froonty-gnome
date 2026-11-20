// SPDX-License-Identifier: GPL-3.0-or-later
// Software display brightness (docs/features/brightness.md): a neutral
// dimming layer, optional warm tint, and a slider in Quick Settings under
// GNOME's. No DDC/CI and no backlight: for monitors GNOME cannot dim. No
// pointer tracking or cursor clone: the layers take no input and are left
// out of picking, so GNOME's own pointer stays the only one, on top.
//
// An extension part (extension.js): it lives while Froonty runs and
// follows brightness-enabled itself.

import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {InjectionManager, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickSlider} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {addUnderBrightness} from '../../shell/quickSettings.js';
import {
    appliedLevel, levelFromSlider, overlayOpacity, sliderValue, targetMonitors, warmthOpacity,
} from './levels.js';

// Shell.Screenshot paints the stage itself, layer included, so it is hidden
// while one of these runs. screenshot_window paints only the window.
const CAPTURES = ['screenshot', 'screenshot_area', 'screenshot_stage_to_content', 'pick_color'];

const KEYS = [
    'brightness-enabled', 'brightness-level', 'brightness-min', 'brightness-monitors',
    'brightness-warmth',
];

// A monitor, not GNOME's sun, so it does not look like the backlight slider above it.
const MONITOR_ICONS = {
    'external': 'video-display-symbolic',
    'built-in': 'computer-symbolic',
    'all': 'video-joined-displays-symbolic',
};

const BrightnessSlider = GObject.registerClass(
class BrightnessSlider extends QuickSlider {
    _init(openSettings) {
        super._init({iconName: MONITOR_ICONS.external});
        this.slider.accessible_name = _('Software brightness');
        this._settingsButton = new St.Button({
            child: new St.Icon({icon_name: 'go-next-symbolic'}),
            style_class: 'icon-button flat',
            can_focus: true,
            y_expand: true,
            accessible_name: _('Brightness settings'),
        });
        this._settingsButton.connect('clicked', openSettings);
        this.get_child().add_child(this._settingsButton);
    }

    showMonitors(monitors) {
        this.iconName = MONITOR_ICONS[monitors] ?? MONITOR_ICONS.external;
    }
});

/** Indices of the built-in panels, as in Main.layoutManager.monitors. */
function builtInMonitors() {
    return new Set(global.backend.get_monitor_manager().get_logical_monitors()
        .filter(logical => logical.get_monitors().some(monitor => monitor.is_builtin()))
        .map(logical => logical.get_number()));
}

export class SoftwareBrightness {
    constructor(settings, openSettings) {
        this._settings = settings;
        this._openSettings = openSettings;
        this._layer = null;
        this._tintLayer = null;
        this._dimLayer = null;
        this._tints = [];
        this._overlays = [];
        this._slider = null;
        this._cancelPlace = null;
        this._injections = null;
        this._captures = 0;
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
        this._openSettings = null;
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
        this._tintLayer = new St.Widget({
            name: 'froonty-brightness-tint-layer',
            reactive: false,
        });
        this._dimLayer = new St.Widget({
            name: 'froonty-brightness-dim-layer',
            reactive: false,
        });
        Shell.util_set_hidden_from_pick(this._tintLayer, true);
        Shell.util_set_hidden_from_pick(this._dimLayer, true);
        this._layer.add_child(this._tintLayer);
        this._layer.add_child(this._dimLayer);
        global.stage.add_child(this._layer);
        // Above everything else on the stage, as long as it is on.
        global.stage.connectObject('child-added', () => this._raise(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._apply(), this);

        this._slider = new BrightnessSlider(() => this._openSettings('brightness'));
        this._slider.slider.connectObject('notify::value', () => {
            if (this._following)
                return;
            const minimum = this._settings.get_int('brightness-min');
            this._settings.set_int('brightness-level',
                levelFromSlider(this._slider.slider.value, minimum));
        }, this);
        this._cancelPlace = addUnderBrightness(this._slider);
        this._hideFromScreenshots();
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
        this._injections?.clear();
        this._injections = null;
        this._captures = 0;
        global.stage.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._layer?.destroy();
        this._layer = null;
        this._tintLayer = null;
        this._dimLayer = null;
        this._tints = [];
        this._overlays = [];
    }

    _apply() {
        const level = appliedLevel(this._settings.get_int('brightness-level'),
            this._settings.get_int('brightness-min'));
        const warmth = this._settings.get_int('brightness-warmth');
        const monitors = Main.layoutManager.monitors;
        this._slider.showMonitors(this._settings.get_string('brightness-monitors'));
        const affected = level < 100 || warmth > 0
            ? targetMonitors(this._settings.get_string('brightness-monitors'),
                monitors.length, builtInMonitors()).map(i => monitors[i])
            : [];

        const tinted = warmth > 0 ? affected : [];
        while (this._tints.length < tinted.length) {
            const tint = new St.Widget({
                reactive: false,
                style: 'background-color: rgb(255, 166, 90);',
            });
            Shell.util_set_hidden_from_pick(tint, true);
            this._tintLayer.add_child(tint);
            this._tints.push(tint);
        }
        for (const tint of this._tints.splice(tinted.length))
            tint.destroy();
        tinted.forEach(({x, y, width, height}, i) => {
            this._tints[i].set({x, y, width, height, opacity: warmthOpacity(warmth)});
        });

        const dimmed = level < 100 ? affected : [];
        while (this._overlays.length < dimmed.length) {
            const overlay = new St.Widget({reactive: false, style: 'background-color: black;'});
            Shell.util_set_hidden_from_pick(overlay, true);
            this._dimLayer.add_child(overlay);
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

    _hideFromScreenshots() {
        this._injections = new InjectionManager();
        const brightness = this;
        for (const name of CAPTURES) {
            this._injections.overrideMethod(Shell.Screenshot.prototype, name, original => function (...args) {
                const end = brightness._beginCapture();
                // Gio._promisify: a promise, or the callback when one is given.
                const callback = args.at(-1);
                if (typeof callback === 'function') {
                    args[args.length - 1] = (...results) => {
                        end();
                        return callback(...results);
                    };
                }
                let result;
                try {
                    result = original.apply(this, args);
                } catch (e) {
                    end();
                    throw e;
                }
                if (typeof result?.then === 'function')
                    result.then(end, end);
                else if (typeof callback !== 'function')
                    end();
                return result;
            });
        }
    }

    // Hidden until the last capture under way ends; the returned function ends this one.
    _beginCapture() {
        const layer = this._layer;
        if (this._captures++ === 0)
            layer?.hide();
        let ended = false;
        return () => {
            // A capture from before the feature was turned off and on again.
            if (ended || this._layer !== layer)
                return;
            ended = true;
            if (--this._captures === 0)
                this._layer?.show();
        };
    }

    _raise() {
        global.stage.set_child_above_sibling(this._layer, null);
    }
}
