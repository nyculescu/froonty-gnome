// SPDX-License-Identifier: GPL-3.0-or-later
// Panic button "CPU load": the whole processor's load (0-100, no "%"), as
// large as the button allows, over a faint processor chip, as the Claude
// session button draws its number. The number takes the Btop tab's level
// colours: green under 20%, then lime, yellow, orange, and red from 80%.
// Not an action: a click opens the Btop tab. Its name (the tooltip) spells
// the number out.
//
// Read from /proc/stat only while the island is open: a first sample when
// it opens, a reading a second later, then one every Btop refresh interval
// (sysmon-interval). Nothing is read while it is collapsed.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {cpuIcon} from '../features/sysmon/icon.js';
import {SYSTEM_IO} from '../features/sysmon/io.js';
import {levelClass} from '../features/sysmon/level.js';
import {loadPercent, parseStat} from '../features/sysmon/parse.js';
import {INTERVAL_KEY} from '../features/sysmon/service.js';

const FIRST_READING_MS = 1000;

export class CpuLoadButton {
    /**
     * @param {string} title
     * @param {object} actions
     * @param {Function} actions.selectTab
     * @param {Gio.Settings} [actions.settings] for the refresh interval
     * @param {object} [io] SYSTEM_IO's shape (tests hand a fake one)
     */
    constructor(title, {selectTab, settings = null}, io = SYSTEM_IO) {
        this._title = title;
        this._settings = settings;
        this._io = io;
        this._timeoutId = 0;
        this._previous = null;
        // A reading in flight when the island closes or the button goes is
        // dropped: each start() takes a new generation.
        this._generation = 0;

        this._number = new St.Label({
            style_class: 'froonty-sysmon-cpu-number',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const stack = new St.Widget({
            style_class: 'froonty-sysmon-cpu-stack',
            layout_manager: new Clutter.BinLayout(),
        });
        stack.add_child(new St.Icon({
            style_class: 'froonty-sysmon-cpu-icon',
            gicon: cpuIcon(),
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        stack.add_child(this._number);

        this.actor = new St.Button({
            style_class: 'froonty-icon-button froonty-panic-button froonty-sysmon-cpu',
            accessible_name: title,
            can_focus: true,
            track_hover: true,
            child: stack,
        });
        this.actor.connect('clicked', () => selectTab('sysmon'));
        this._show(null);
    }

    destroy() {
        this._stop();
        this.actor.destroy();
        this.actor = null;
    }

    setActive(active) {
        if (active)
            this._start();
        else
            this._stop();
    }

    _start() {
        if (this._timeoutId)
            return;
        const generation = ++this._generation;
        this._previous = null;
        this._read(generation, FIRST_READING_MS);
    }

    _stop() {
        this._generation++;
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
    }

    // Samples /proc/stat, shows the load since the last sample, and plans
    // the next sample after `delayMs`.
    async _read(generation, delayMs) {
        const text = await this._io.read('/proc/stat');
        if (generation !== this._generation)
            return;
        const current = text === null ? null : parseStat(text).all;
        if (this._previous)
            this._show(loadPercent(this._previous, current));
        this._previous = current;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._timeoutId = 0;
            this._read(generation, this._intervalMs());
            return GLib.SOURCE_REMOVE;
        });
    }

    _intervalMs() {
        return (this._settings?.get_int(INTERVAL_KEY) ?? 2) * 1000;
    }

    _show(percent) {
        for (let cell = 1; cell <= 5; cell++)
            this._number.remove_style_class_name(`froonty-sysmon-cell-${cell}`);
        if (percent === null) {
            this._number.text = '?';
            this.actor.accessible_name = _('%s: unknown').format(this._title);
            return;
        }
        const rounded = Math.round(percent);
        this._number.text = `${rounded}`;
        this._number.add_style_class_name(levelClass(rounded));
        this.actor.accessible_name = _('%s: %d%%').format(this._title, rounded);
    }
}
