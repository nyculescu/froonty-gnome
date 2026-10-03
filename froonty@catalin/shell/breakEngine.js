// SPDX-License-Identifier: GPL-3.0-or-later
// A thin wrapper over GNOME's BreakManager (misc/breakManager.js, GNOME
// Shell 50.1), the engine behind Settings → Wellbeing's break reminders.
// GNOME times the breaks; Froonty reads its times and calls its own
// methods (docs/features/break.md). Shell-free: unit tests run it against
// GNOME's real class loaded from the installed Shell, with a fake clock.
//
// PRIVATE / INTERNAL API (docs/DESIGN.md §6.3):
//   getters    state, currentBreakType, nextBreakDueTime,
//              getNextBreakDue(t), getCurrentTime(), getDurationForBreakType(t)
//   methods    delayBreak(), skipBreak(), takeBreak()
//   signals    the six in SIGNALS
//   _breakLastEnd  a private Map of break type → last end (wall-clock s).
//              The public getters give only the earliest next break; the
//              map gives each type's. Without it (renamed), read() returns
//              lastEnd: null and the tab falls back to the next break only.
// Never used: get_property('next-break-due-time') (it throws in GJS), and
// the D-Bus org.gnome.Shell.ScreenTime (other state numbers, no due time).

import {Emitter} from '../core/emitter.js';

// Mirror misc/breakManager.js (GNOME Shell 50.1); a unit test compares
// them with the installed Shell.
export const STATE = {DISABLED: 0, ACTIVE: 1, IDLE: 2, IN_BREAK: 3, BREAK_DUE: 4};
export const BREAK_TYPES = ['eyesight', 'movement'];
export const IDLE_WATCH_SECONDS = 10;   // MIN_BREAK_LENGTH_SECONDS
export const UPCOMING_SECONDS = 120;    // BREAK_UPCOMING_NOTIFICATION_TIME_SECONDS
export const OVERDUE_SECONDS = 60;      // BREAK_OVERDUE_TIME_SECONDS

export const SIGNALS = ['notify::state', 'notify::next-break-due-time',
    'notify::last-break-end-time', 'break-due', 'break-finished', 'take-break'];

/** Emits 'changed' (signal name) for each of GNOME's signals while started. */
export class BreakEngine extends Emitter {
    /** @param {?object} manager GNOME's BreakManager, or null */
    constructor(manager) {
        super();
        this._manager = manager;
        this._ids = [];
        this._ownAction = null;
    }

    /** Whether this Shell has an engine Froonty knows how to drive. */
    get available() {
        const m = this._manager;
        return Boolean(m) && typeof m.state === 'number' &&
            ['getNextBreakDue', 'getCurrentTime', 'delayBreak', 'skipBreak', 'takeBreak']
                .every(name => typeof m[name] === 'function');
    }

    start() {
        if (!this.available || this._ids.length)
            return;
        this._ids = SIGNALS.map(signal =>
            this._manager.connect(signal, () => this.emit('changed', signal)));
    }

    stop() {
        for (const id of this._ids)
            this._manager.disconnect(id);
        this._ids = [];
    }

    /** Whether start() connected the signals (for tests and the budget). */
    get connected() {
        return this._ids.length > 0;
    }

    /**
     * GNOME's times, in wall-clock seconds.
     *
     * @returns {{state: number, now: number, currentType: ?string,
     *   nextDue: number, nextType: ?string, lastEnd: ?object}}
     */
    read() {
        const m = this._manager;
        const now = m.getCurrentTime();
        const state = m.state;
        const [nextType, nextDue] = m.getNextBreakDue(now);
        const map = m._breakLastEnd;
        return {
            state,
            now,
            // Only meaningful while a break is due or in progress.
            currentType: state === STATE.BREAK_DUE || state === STATE.IN_BREAK
                ? m.currentBreakType ?? null : null,
            nextDue,
            nextType: nextType ?? null,
            lastEnd: map instanceof Map ? Object.fromEntries(map) : null,
        };
    }

    /** 'delay' or 'skip' while Froonty's own call runs (GNOME emits synchronously). */
    get ownAction() {
        return this._ownAction;
    }

    delay() {
        this._call('delay', () => this._manager.delayBreak());
    }

    skip() {
        this._call('skip', () => this._manager.skipBreak());
    }

    // GNOME only emits 'take-break'; its dispatcher then dims or locks, and
    // only when a break type is current.
    take() {
        this._manager.takeBreak();
    }

    _call(action, fn) {
        this._ownAction = action;
        try {
            fn();
        } finally {
            this._ownAction = null;
        }
    }
}
