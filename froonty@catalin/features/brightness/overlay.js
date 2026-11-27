// SPDX-License-Identifier: GPL-3.0-or-later
// Software display brightness (docs/features/brightness.md): a neutral
// dimming layer and a slider in Quick Settings under GNOME's. No DDC/CI and no backlight: for monitors GNOME cannot dim. No
// pointer tracking or cursor clone: the layers take no input and are left
// out of picking, so GNOME's own pointer stays the only one, on top. With a
// laptop open and joined to the monitors it dims, they join GNOME's
// slider instead (§8), and this one hides.
//
// An extension part (extension.js): it lives while Froonty runs and
// follows brightness-enabled itself.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {InjectionManager, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickSlider} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {joinBrightness} from '../../shell/brightnessManager.js';
import {addUnderBrightness} from '../../shell/quickSettings.js';
import {
    TARGETS, appliedLevel, levelFromSlider, mergedMonitors, overlayOpacity, sliderValue, targetMonitors,
} from './levels.js';
import {setSoftwareSlider} from './nightLightMenu.js';

// Shell.Screenshot paints the stage itself, layer included, so it is hidden
// while one of these runs. screenshot_window paints only the window.
const CAPTURES = ['screenshot', 'screenshot_area', 'screenshot_stage_to_content', 'pick_color'];

// A monitor, not GNOME's sun, so it does not look like the backlight slider above it.
const MONITOR_ICONS = {
    'external': 'video-display-symbolic',
    'built-in': 'computer-symbolic',
    'all': 'video-joined-displays-symbolic',
};

// A labelled slider in a menu, as GNOME's brightness menu has them.
function addMenuSlider(menu, label) {
    menu.addMenuItem(new PopupMenu.PopupMenuItem(label, {reactive: false}));
    const slider = new Slider(0);
    slider.accessible_name = label;
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false});
    item.add_child(new St.Bin({
        style_class: 'slider-bin',
        child: slider,
        reactive: true,
        can_focus: true,
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    }));
    menu.addMenuItem(item);
    return slider;
}

const BrightnessSlider = GObject.registerClass(
class BrightnessSlider extends QuickSlider {
    _init(openSettings) {
        super._init({
            iconName: MONITOR_ICONS.external,
            menuButtonAccessibleName: _('Open software brightness menu'),
        });
        this.slider.accessible_name = _('Software brightness');
        this.menuEnabled = true;
        this.menu.setHeader(MONITOR_ICONS.external, _('Software brightness'));

        this.level = addMenuSlider(this.menu, _('Brightness'));

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.settingsItem = this.menu.addAction(_('Brightness Settings'), () => openSettings());
    }

    // For Night Light where GNOME has no brightness slider to hold it
    // (nightLightMenu.js): above the last two items, the separator and
    // Brightness Settings.
    insertBeforeSettings(items) {
        const position = this.menu.numMenuItems - 2;
        items.forEach((item, i) => this.menu.addMenuItem(item, position + i));
    }

    showMonitors(monitors) {
        const icon = MONITOR_ICONS[monitors] ?? MONITOR_ICONS.external;
        const names = [_('External monitors'), _('Built-in screen'), _('All monitors')];
        this.iconName = icon;
        this.menu.setHeader(icon, _('Software brightness'), names[TARGETS.indexOf(monitors)] ?? names[0]);
    }
});

const logicalMonitors = () => global.backend.get_monitor_manager().get_logical_monitors();

// Indices, as in Main.layoutManager.monitors, of the monitors with a
// screen that passes the test.
function monitorsWhere(test) {
    return new Set(logicalMonitors()
        .filter(logical => logical.get_monitors().some(test))
        .map(logical => logical.get_number()));
}

export class SoftwareBrightness {
    constructor(settings, openSettings) {
        this._settings = settings;
        this._openSettings = openSettings;
        this._layer = null;
        this._dimLayer = null;
        this._overlays = [];
        this._slider = null;
        this._cancelPlace = null;
        this._injections = null;
        this._captures = 0;
        // Set while the slider is moved to the setting, not by the user.
        this._following = false;
        // While the dimmed monitors are part of GNOME's slider: its handle,
        // those monitors and the brightness GNOME last applied (0-1).
        this._joined = null;
        this._merged = null;
        this._brightness = 1;
        settings.connectObject(
            'changed::brightness-enabled', () => this._sync(),
            'changed::brightness-monitors', () => this._sync(),
            'changed::brightness-level', () => this._update(),
            'changed::brightness-min', () => this._update(),
            this);
        this._sync();
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._hide();
        this._settings = null;
        this._openSettings = null;
    }

    // On, off, the monitors setting, or monitors added, removed or rearranged.
    _sync() {
        if (!this._settings.get_boolean('brightness-enabled')) {
            this._hide();
            return;
        }
        this._show();
        this._merge();
        this._apply();
    }

    // The level or the minimum.
    _update() {
        if (this._layer)
            this._apply();
    }

    // Built-in panels and backlit screens (a headless check fakes them).
    _monitorKinds() {
        return {
            builtIn: monitorsWhere(monitor => monitor.is_builtin()),
            // As GNOME picks the screens its slider dims (misc/brightnessManager.js).
            backlit: monitorsWhere(monitor => monitor.get_backlight() && monitor.is_active()),
        };
    }

    // The dimmed monitors join GNOME's slider when levels.js says so, and
    // this slider hides; otherwise both sliders show.
    _merge() {
        this._joined?.leave();
        this._joined = null;
        this._merged = null;
        const {builtIn, backlit} = this._monitorKinds();
        const merged = mergedMonitors(this._settings.get_string('brightness-monitors'),
            Main.layoutManager.monitors.length, builtIn, backlit);
        const logical = merged?.map(i => logicalMonitors().find(l => l.get_number() === i));
        if (merged && logical.every(Boolean)) {
            const name = logical.length === 1
                ? logical[0].get_monitors()[0].get_display_name()
                : _('External monitors');
            const minimum = this._settings.get_int('brightness-min');
            const value = sliderValue(this._settings.get_int('brightness-level'), minimum);
            // Set first: GNOME applies the level while the screen joins.
            this._merged = merged;
            this._brightness = value;
            this._joined = joinBrightness(logical[0], name, value, {
                changed: moved => this._storeLevel(moved),
                apply: brightness => this._applyJoined(brightness),
            });
            if (!this._joined)
                this._merged = null;
        }
        this._slider.visible = !this._joined;
    }

    // GNOME's slider or the screen's own in its menu moved the level.
    _storeLevel(value) {
        if (!this._layer)
            return;
        const minimum = this._settings.get_int('brightness-min');
        const level = levelFromSlider(value, minimum);
        if (level !== appliedLevel(this._settings.get_int('brightness-level'), minimum))
            this._settings.set_int('brightness-level', level);
    }

    _applyJoined(brightness) {
        if (!this._layer || !this._merged)
            return;
        this._brightness = brightness;
        this._paint(levelFromSlider(brightness, this._settings.get_int('brightness-min')), this._merged);
    }

    _show() {
        if (this._layer)
            return;
        this._layer = new St.Widget({name: 'froonty-brightness', reactive: false});
        Shell.util_set_hidden_from_pick(this._layer, true);
        this._dimLayer = new St.Widget({
            name: 'froonty-brightness-dim-layer',
            reactive: false,
        });
        Shell.util_set_hidden_from_pick(this._dimLayer, true);
        this._layer.add_child(this._dimLayer);
        global.stage.add_child(this._layer);
        // Above everything else on the stage, as long as it is on.
        global.stage.connectObject('child-added', () => this._raise(), this);
        // Connected after GNOME's layout and brightness managers, so both
        // have the new monitors when this runs.
        global.backend.get_monitor_manager().connectObject('monitors-changed', () => this._sync(), this);

        this._slider = new BrightnessSlider(() => this._openSettings('brightness'));
        // The menu's brightness slider is the same setting as the main one.
        for (const levelSlider of [this._slider.slider, this._slider.level]) {
            levelSlider.connectObject('notify::value', () => {
                if (this._following)
                    return;
                const minimum = this._settings.get_int('brightness-min');
                this._settings.set_int('brightness-level', levelFromSlider(levelSlider.value, minimum));
            }, this);
        }
        this._cancelPlace = addUnderBrightness(this._slider);
        setSoftwareSlider(this._slider);
        this._hideFromScreenshots();
    }

    _hide() {
        this._joined?.leave();
        this._joined = null;
        this._merged = null;
        this._cancelPlace?.();
        this._cancelPlace = null;
        if (this._slider) {
            // Night Light leaves its menu first, if it is there.
            setSoftwareSlider(null);
            // Quick Settings put the slider's menu in an overlay of its own
            // (ui/quickSettings.js, _completeAddItem): it goes too.
            this._slider.menu.destroy();
            this._slider.destroy();
            this._slider = null;
        }
        this._injections?.clear();
        this._injections = null;
        this._captures = 0;
        global.stage.disconnectObject(this);
        global.backend.get_monitor_manager().disconnectObject(this);
        this._layer?.destroy();
        this._layer = null;
        this._dimLayer = null;
        this._overlays = [];
    }

    _apply() {
        const target = this._settings.get_string('brightness-monitors');
        const minimum = this._settings.get_int('brightness-min');
        const level = appliedLevel(this._settings.get_int('brightness-level'), minimum);
        this._slider.showMonitors(target);
        if (this._joined) {
            // GNOME's model holds the level while joined: a new one moves
            // the screen's scale, and what GNOME applies comes back to
            // _applyJoined. Only a new minimum changes nothing there.
            const {scale} = this._joined;
            if (levelFromSlider(scale.value, minimum) !== level)
                scale.value = sliderValue(level, minimum);
            else
                this._applyJoined(this._brightness);
        } else {
            this._paint(level, targetMonitors(target, Main.layoutManager.monitors.length,
                this._monitorKinds().builtIn));
        }

        // The slider follows the setting unless it already stands for it
        // (while it is dragged, each step is written as it comes).
        this._following = true;
        for (const slider of [this._slider.slider, this._slider.level]) {
            if (levelFromSlider(slider.value, minimum) !== level)
                slider.value = sliderValue(level, minimum);
        }
        this._following = false;
    }

    // A black layer for a level over each of the monitors (indices).
    _paint(level, indices) {
        const monitors = Main.layoutManager.monitors;
        const dimmed = level < 100 ? indices.map(i => monitors[i]).filter(Boolean) : [];
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
