// SPDX-License-Identifier: GPL-3.0-or-later
// A screen GNOME cannot dim, added to GNOME's own brightness model for
// Software brightness (docs/features/brightness.md §8): GNOME's slider then
// moves it with the backlit screens, keeping their ratio, its menu gets a
// slider for it, and the brightness keys, the OSD and idle dimming reach it.
//
// PRIVATE / INTERNAL API: Main.brightnessManager (misc/brightnessManager.js,
// 50.1) keeps each screen's scale in its private _monitorScales map and
// recomputes the ratios and the global slider in its private _sync(). This
// is the only place that touches them.

import GObject from 'gi://GObject';

import {BrightnessScale} from 'resource:///org/gnome/shell/misc/brightnessManager.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// What _sync() calls on a screen's scale, as MonitorBrightnessScale has it.
const SoftwareScale = GObject.registerClass(
class FroontySoftwareScale extends BrightnessScale {
    constructor(name, value, monitor, apply) {
        super(name, value);
        this._monitor = monitor;
        this._applyBrightness = apply;
        this._scaleFactor = 1.0;
    }

    get monitor() {
        return this._monitor;
    }

    // Only a backlight changes behind GNOME's back.
    syncWithBacklight() {
        return false;
    }

    syncWithScale(globalScale) {
        this.value = globalScale.value * this._scaleFactor;
    }

    updateScaleFactor(max) {
        this._scaleFactor = this.value / max;
    }

    // The scale's value, lowered while GNOME dims an idle screen.
    setBacklight(brightness) {
        this._applyBrightness(brightness);
    }
});

// GNOME's manager, if it is as this module expects.
function manager() {
    const m = Main.brightnessManager;
    return m?._monitorScales instanceof Map && typeof m._sync === 'function' ? m : null;
}

/**
 * Adds a screen with no backlight to GNOME's brightness slider, while
 * GNOME shows one.
 *
 * @param {Meta.LogicalMonitor} monitor the screen, for the keys that dim
 *   the current screen and for the OSD
 * @param {string} name its slider's label in GNOME's brightness menu
 * @param {number} value its level, 0-1
 * @param {object} handlers
 * @param {Function} handlers.changed (value 0-1): its level moved
 * @param {Function} handlers.apply (brightness 0-1): the brightness to show
 * @returns {{scale: BrightnessScale, leave: Function}|null} null when GNOME
 *   shows no slider or already has a scale for the screen
 */
export function joinBrightness(monitor, name, value, {changed, apply}) {
    const m = manager();
    if (!m?.globalScale || m._monitorScales.has(monitor))
        return null;
    const scale = new SoftwareScale(name, value, monitor, apply);
    // As GNOME's handler for its own screens' scales (_monitorsChanged).
    const id = scale.connect('notify::value', () => {
        changed(scale.value);
        if (m._inhibitUpdates)
            return;
        scale._scaleChanged = true;
        m._sync();
        m.emit('user-update');
    });
    scale._scaleChanged = true;
    m._monitorScales.set(monitor, scale);
    m._sync({showOSD: false});
    m.emit('changed');
    return {
        scale,
        leave() {
            scale.disconnect(id);
            // GNOME rebuilds its scales when monitors change, without this one.
            if (m._monitorScales.get(monitor) !== scale)
                return;
            m._monitorScales.delete(monitor);
            // The slider then stands for the brightest backlit screen, as
            // after GNOME's own rebuild.
            for (const other of m._monitorScales.values())
                other._scaleChanged = true;
            m._sync({showOSD: false});
            m.emit('changed');
        },
    };
}
