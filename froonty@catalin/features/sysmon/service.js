// SPDX-License-Identifier: GPL-3.0-or-later
// Btop tab (docs/features/sysmon.md): samples the machine while its
// tab is on screen, and not at all otherwise. This is Froonty's one
// periodic timer (DESIGN.md §2 and §8): readings are only worth anything
// live, and no event tells when a CPU's load or a GPU's temperature has
// changed. The interval is the user's (sysmon-interval); sections that
// are turned off are not read.
//
// Emits 'changed' after each sample and when the settings change. No St.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Emitter} from '../../core/emitter.js';
import {SYSTEM_IO} from './io.js';
import {Sampler, SECTIONS} from './sampler.js';

export const INTERVAL_KEY = 'sysmon-interval';
// Load and speed need two samples: the second of a visit comes this soon,
// so the tab does not show "—" for a whole interval.
const FOLLOW_UP_MS = 500;
export const CORES_KEY = 'sysmon-cores-expanded';
// The island's width while the tab is shown; the view lays out by it.
export const WIDTH_KEY = 'sysmon-width';
export const sectionKey = section => `sysmon-show-${section}`;

export class SysmonService extends Emitter {
    /**
     * @param {Gio.Settings} settings
     * @param {object} [deps] for tests: `io` (see io.js), `now` (seconds)
     */
    constructor(settings, {io = SYSTEM_IO, now = () => GLib.get_monotonic_time() / 1e6} = {}) {
        super();
        this._settings = settings;
        this._sampler = new Sampler(io);
        this._now = now;
        this._active = false;
        this._timerId = 0;
        this._followUpId = 0;
        this._cancellable = null;
        this._sampling = false;
        this._warned = false;
        this._settingsIds = [];
        /** The latest sample (see Sampler.sample), or null before the first. */
        this.snapshot = null;
        this._readSettings();
    }

    start() {
        const keys = [INTERVAL_KEY, CORES_KEY, WIDTH_KEY, ...SECTIONS.map(sectionKey)];
        this._settingsIds = keys.map(key =>
            this._settings.connect(`changed::${key}`, () => this._onSettingsChanged(key)));
    }

    stop() {
        this.setActive(false);
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
    }

    /** Samples while `active` (the tab on screen), every interval. */
    setActive(active) {
        if (active === this._active)
            return;
        this._active = active;
        if (active) {
            this._cancellable = new Gio.Cancellable();
            // A new visit: hardware may have changed (a GPU plugged in), and
            // load over the time away is not what the tab shows.
            this._sampler.reset();
            this._schedule();
            this._tick();
            this._followUpId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FOLLOW_UP_MS, () => {
                this._followUpId = 0;
                this._tick();
                return GLib.SOURCE_REMOVE;
            });
        } else {
            if (this._followUpId)
                GLib.source_remove(this._followUpId);
            this._followUpId = 0;
            this._unschedule();
            this._cancellable.cancel();
            this._cancellable = null;
        }
    }

    /** Whether the timer runs (for tests and the design budget). */
    get polling() {
        return this._timerId !== 0;
    }

    setCoresExpanded(expanded) {
        this._settings.set_boolean(CORES_KEY, expanded);
    }

    _readSettings() {
        /** The SECTIONS values turned on, in display order. */
        this.sections = SECTIONS.filter(section => this._settings.get_boolean(sectionKey(section)));
        this.coresExpanded = this._settings.get_boolean(CORES_KEY);
        this._interval = this._settings.get_int(INTERVAL_KEY);
        /** The island's width (logical px) while the tab is shown. */
        this.width = this._settings.get_int(WIDTH_KEY);
    }

    _onSettingsChanged(key) {
        this._readSettings();
        this.emit('changed');
        if (!this._active)
            return;
        if (key === INTERVAL_KEY || key.startsWith('sysmon-show-'))
            this._schedule();
        // Show a new section, or the cores, without waiting an interval.
        if (key !== INTERVAL_KEY && key !== WIDTH_KEY)
            this._tick();
    }

    _schedule() {
        this._unschedule();
        // Nothing to show, nothing to read.
        if (!this.sections.length)
            return;
        // Whole seconds, so GLib can wake the Shell for it together with
        // other timers.
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._interval, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _unschedule() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = 0;
    }

    _tick() {
        // A slow read (e.g. nvidia-smi) never piles up behind itself.
        if (this._sampling || !this.sections.length)
            return;
        this._sampling = true;
        const cancellable = this._cancellable;
        this._sampler.sample(this.sections, {
            cores: this.coresExpanded,
            now: this._now(),
            cancellable,
        }).then(snapshot => {
            if (cancellable.is_cancelled() || !snapshot)
                return;
            this.snapshot = snapshot;
            this.emit('changed');
        }).catch(e => {
            // Once per Shell session, not every interval.
            if (!this._warned)
                console.warn(`Froonty: system monitor sample failed: ${e.message}`);
            this._warned = true;
        }).finally(() => {
            this._sampling = false;
        });
    }
}
