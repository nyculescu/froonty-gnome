// SPDX-License-Identifier: GPL-3.0-or-later
// Kill Process tab (docs/features/kill-process.md): lists the user's
// processes while its tab is on screen, and not at all otherwise, and
// kills the ones the user confirms.
//
// Like the Btop tab's, its timer runs only while the tab is on screen
// (DESIGN.md §2 and §8): CPU use is only worth anything live, and no
// event tells when it changes. The interval is the user's
// (killprocess-interval), but the timer's readings are spaced at least
// PACE times as long as the previous reading took: a reading costs the
// Shell's main thread more the more processes there are.
//
// A kill is SIGTERM first: the process may save and quit. One still
// running FORCE_AFTER_S later is offered "Force quit" (SIGKILL). Right
// before each signal the process is read again (ProcessSampler.verify):
// same start time (not a reused process id), this user's, not protected.
//
// Emits 'changed' after each sample, each step of a kill, and when the
// settings change. No St.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Emitter} from '../../core/emitter.js';
import {currentProcess, PROCESS_IO} from './io.js';
import {KILL_PATHS, killArgv} from './kill.js';
import {SORTS} from './rules.js';
import {ProcessSampler} from './sampler.js';

export const INTERVAL_KEY = 'killprocess-interval';
export const SORT_KEY = 'killprocess-sort';
// CPU shares need two samples: the second of a visit comes this soon.
const FOLLOW_UP_MS = 500;
// After a signal, the list shows its effect this soon...
const CHECK_MS = 500;
// ...and is read this often while a process is being killed, for at most
// FOLLOW_KILL_S (one stuck in the kernel may never end); then the
// interval goes on.
const PENDING_MS = 1000;
const FOLLOW_KILL_S = 10;
// A timer reading is skipped while less than PACE times the previous
// reading's duration has passed since it ended (see the file comment).
const PACE = 10;
/** A process still running this long after SIGTERM is offered "Force quit". */
export const FORCE_AFTER_S = 3;

export class KillProcessService extends Emitter {
    /**
     * @param {Gio.Settings} settings
     * @param {object} [deps] for tests: `io` (see io.js), `self` ({pid,
     *   uid} of GNOME Shell), `now` (seconds)
     */
    constructor(settings, {
        io = PROCESS_IO,
        self = null,
        now = () => GLib.get_monotonic_time() / 1e6,
    } = {}) {
        super();
        this._settings = settings;
        this._io = io;
        this._sampler = new ProcessSampler(io, self ?? currentProcess());
        this._now = now;
        this._active = false;
        this._timerId = 0;
        this._followUpId = 0;
        this._cancellable = null;
        this._sampling = false;
        // The latest reading: when it ended and how long it took (seconds).
        this._sampled = {end: -Infinity, took: 0};
        this._warned = false;
        this._settingsIds = [];
        this._killPath = null;
        // Kills in progress, by process key: {phase, since, name, pid}.
        this._kills = new Map();
        /** The latest sample (ProcessSampler.sample), or null before the first. */
        this.processes = null;
        /** How the latest kill ended, {outcome, name, pid}, or null. */
        this.lastResult = null;
        this._readSettings();
    }

    start() {
        this._settingsIds = [INTERVAL_KEY, SORT_KEY].map(key =>
            this._settings.connect(`changed::${key}`, () => this._onSettingsChanged(key)));
    }

    stop() {
        this.setActive(false);
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
    }

    /** Reads the processes while `active` (the tab on screen), every interval. */
    setActive(active) {
        if (active === this._active)
            return;
        this._active = active;
        if (active) {
            this._cancellable = new Gio.Cancellable();
            // A new visit: CPU use over the time away is not what the tab shows.
            this._sampler.reset();
            this._schedule();
            this._tick();
            this._followUp(FOLLOW_UP_MS);
        } else {
            if (this._followUpId)
                GLib.source_remove(this._followUpId);
            this._followUpId = 0;
            this._unschedule();
            this._cancellable.cancel();
            this._cancellable = null;
            // A new visit starts with no kill in progress and no old news.
            this._kills.clear();
            this.lastResult = null;
        }
    }

    /** Whether the timer runs (for tests and the design budget). */
    get polling() {
        return this._timerId !== 0;
    }

    setSort(sort) {
        if (SORTS.includes(sort))
            this._settings.set_string(SORT_KEY, sort);
    }

    /**
     * The kill in progress for a process key, or null: {phase, since}
     * with phase 'sending' (being checked and signalled), 'ending'
     * (SIGTERM sent), 'stuck' (still running FORCE_AFTER_S after it) or
     * 'forcing' (SIGKILL sent).
     */
    killState(key) {
        return this._kills.get(key) ?? null;
    }

    /** Asks a listed process to quit (SIGTERM). */
    kill(process) {
        return this._signal(process, 'TERM');
    }

    /** Ends a process that did not quit when asked (SIGKILL): 'stuck' only. */
    forceQuit(process) {
        return this._signal(process, 'KILL');
    }

    _readSettings() {
        const sort = this._settings.get_string(SORT_KEY);
        /** 'cpu', 'memory' or 'threads' (rules.js SORTS): what the list is sorted by. */
        this.sort = SORTS.includes(sort) ? sort : SORTS[0];
        this._interval = this._settings.get_int(INTERVAL_KEY);
    }

    _onSettingsChanged(key) {
        this._readSettings();
        this.emit('changed');
        if (this._active && key === INTERVAL_KEY)
            this._schedule();
    }

    _schedule() {
        this._unschedule();
        // Whole seconds, so GLib can wake the Shell for it together with
        // other timers.
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._interval, () => {
            this._tick(true);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _unschedule() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = 0;
    }

    // One early sample, unless one is due already.
    _followUp(ms) {
        if (!this._active || this._followUpId)
            return;
        this._followUpId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._followUpId = 0;
            this._tick();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** @param {boolean} [timer] the interval's reading (paced), not an early one */
    _tick(timer = false) {
        // A slow read never piles up behind itself.
        if (this._sampling)
            return;
        const start = this._now();
        if (timer && start - this._sampled.end < PACE * this._sampled.took)
            return;
        this._sampling = true;
        const cancellable = this._cancellable;
        this._sampler.sample(cancellable).then(async processes => {
            if (cancellable.is_cancelled() || !processes)
                return;
            const end = this._now();
            this._sampled = {end, took: end - start};
            // The view's refresh (sorting, filling the rows) gets a turn of
            // the main loop of its own, after the reading's last batch.
            await this._io.pause(cancellable);
            if (cancellable.is_cancelled())
                return;
            this.processes = processes;
            this._followKills(processes);
            this.emit('changed');
            const now = this._now();
            if ([...this._kills.values()].some(kill =>
                kill.phase !== 'stuck' && now - kill.since < FOLLOW_KILL_S))
                this._followUp(PENDING_MS);
        }).catch(e => {
            // Once per Shell session, not every interval.
            if (!this._warned)
                console.warn(`Froonty: reading processes failed: ${e.message}`);
            this._warned = true;
        }).finally(() => {
            this._sampling = false;
        });
    }

    // A killed process that is no longer listed has ended; one still
    // running FORCE_AFTER_S after SIGTERM may be force quit.
    _followKills(processes) {
        const listed = new Set(processes.map(process => process.key));
        const now = this._now();
        for (const [key, kill] of this._kills) {
            if (kill.phase === 'sending')
                continue;
            if (!listed.has(key)) {
                this._kills.delete(key);
                this.lastResult = {outcome: 'ended', name: kill.name, pid: kill.pid};
            } else if (kill.phase === 'ending' && now - kill.since >= FORCE_AFTER_S) {
                kill.phase = 'stuck';
            }
        }
    }

    async _signal(process, signal) {
        if (!process)
            return;
        const {key, pid, name} = process;
        const current = this._kills.get(key);
        // SIGTERM once, and SIGKILL only after SIGTERM did not do.
        const allowed = signal === 'TERM' ? !current : current?.phase === 'stuck';
        if (!this._active || !allowed)
            return;
        const kill = {phase: 'sending', since: this._now(), name, pid};
        this._kills.set(key, kill);
        this.lastResult = null;
        this.emit('changed');

        let outcome;
        try {
            outcome = await this._send(process, signal);
        } catch (e) {
            console.warn(`Froonty: could not signal process ${pid}: ${e.message}`);
            outcome = 'failed';
        }
        // The visit ended meanwhile; nobody to tell.
        if (this._kills.get(key) !== kill)
            return;
        if (outcome === 'sent') {
            this._kills.set(key, {
                phase: signal === 'KILL' ? 'forcing' : 'ending',
                since: this._now(),
                name,
                pid,
            });
        } else {
            this._kills.delete(key);
            this.lastResult = {outcome, name, pid};
        }
        this.emit('changed');
        this._followUp(CHECK_MS);
    }

    // 'sent', or why not (ProcessSampler.verify's answers, 'no-tool' or
    // 'failed').
    async _send(process, signal) {
        const verdict = await this._sampler.verify(process);
        if (verdict !== 'ok')
            return verdict;
        this._killPath ??= await this._findKill();
        if (!this._killPath)
            return 'no-tool';
        const output = await this._io.run(killArgv(this._killPath, process.pid, signal));
        if (output !== null)
            return 'sent';
        // kill(1) failed: the process may have ended just now.
        return await this._sampler.verify(process) === 'gone' ? 'gone' : 'failed';
    }

    async _findKill() {
        for (const path of KILL_PATHS) {
            // eslint-disable-next-line no-await-in-loop
            if (await this._io.executable(path))
                return path;
        }
        return null;
    }
}
