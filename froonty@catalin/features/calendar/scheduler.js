// SPDX-License-Identifier: GPL-3.0-or-later
// Calendar tab: shares the compositor's main loop between the EDS views'
// expansion work (eds.js), so a large calendar never stalls a frame
// (docs/features/calendar.md §B.6, "Expansion off the frame path").
//
// One idle for every view of the tab, at the default idle priority (below
// the Shell's redraws). Each turn runs steps, from one view after the
// other, until its time budget is spent; a step its view expects to be
// long runs alone in its turn. While paused (the tab is not on screen)
// no turn runs; the views keep what they were sent until it resumes.
//
// No St, no Shell and no EDS imports: plain-gjs unit tests drive it with
// a fake clock and a fake idle.

import GLib from 'gi://GLib';

/** Work per main-loop turn, in microseconds: well under a 60 Hz frame. */
export const TURN_BUDGET_US = 3000;

const defaultIdle = {
    add: fn => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => fn() ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE),
    cancel: id => GLib.source_remove(id),
};

/**
 * One main-loop turn's budget, handed to each worker in turn.
 * A worker calls `step(long)` before each step and stops when it returns
 * false; `done(long)` after it.
 */
class Turn {
    constructor(now, budget) {
        this._now = now;
        this._deadline = now() + budget;
        this._spent = false;
        this._closed = false;
    }

    get over() {
        return this._closed || this._now() >= this._deadline;
    }

    /**
     * Whether a step may run now: not once the budget is spent, and a long
     * one only as the turn's first.
     */
    step(long = false) {
        if (this.over)
            return false;
        if (long && this._spent) {
            this._closed = true;
            return false;
        }
        return true;
    }

    /** After a step; a long one closes the turn. */
    done(long = false) {
        this._spent = true;
        if (long)
            this._closed = true;
    }
}

/**
 * Workers: objects with `work(turn)`, which runs steps while
 * `turn.step(long)` allows and returns whether work is left.
 */
export class Scheduler {
    /**
     * @param {object} [options]
     * @param {number} [options.budget] microseconds per turn
     * @param {Function} [options.now] monotonic microseconds
     * @param {object} [options.idle] {add(fn) → id, cancel(id)}; fn returns
     *   whether to run again
     */
    constructor({budget = TURN_BUDGET_US, now = () => GLib.get_monotonic_time(), idle = defaultIdle} = {}) {
        this._budget = budget;
        this._now = now;
        this._idle = idle;
        this._workers = [];
        this._idleId = 0;
        this._paused = false;
        this._stopped = false;
        this._inTurn = false;
        /** Turns run so far, and the longest one in microseconds (tests). */
        this.turns = 0;
        this.longestTurn = 0;
    }

    get paused() {
        return this._paused;
    }

    /** Whether a turn is scheduled (tests and the lifecycle checks). */
    get pending() {
        return this._idleId !== 0;
    }

    setPaused(paused) {
        this._paused = paused;
        if (paused)
            this._cancel();
        else
            this._arm();
    }

    /** A worker has work: it gets turns until it says it is done. */
    want(worker) {
        if (this._stopped)
            return;
        if (!this._workers.includes(worker))
            this._workers.push(worker);
        this._arm();
    }

    forget(worker) {
        const i = this._workers.indexOf(worker);
        if (i >= 0)
            this._workers.splice(i, 1);
        if (this._workers.length === 0)
            this._cancel();
    }

    stop() {
        this._stopped = true;
        this._workers = [];
        this._cancel();
    }

    // During a turn its own idle is the one in use: the turn's end keeps
    // or removes it.
    _arm() {
        if (this._idleId || this._inTurn || this._paused || this._stopped || this._workers.length === 0)
            return;
        this._idleId = this._idle.add(() => this._turn());
    }

    _cancel() {
        if (!this._idleId || this._inTurn)
            return;
        this._idle.cancel(this._idleId);
        this._idleId = 0;
    }

    // Round robin: a worker with work left goes to the back.
    _turn() {
        const started = this._now();
        const turn = new Turn(this._now, this._budget);
        this._inTurn = true;
        try {
            while (this._workers.length && !turn.over && !this._paused && !this._stopped) {
                const worker = this._workers.shift();
                if (worker.work(turn) && !this._workers.includes(worker))
                    this._workers.push(worker);
            }
        } finally {
            this._inTurn = false;
        }
        this.turns++;
        this.longestTurn = Math.max(this.longestTurn, this._now() - started);
        if (this._workers.length && !this._paused && !this._stopped)
            return true;
        this._idleId = 0;
        return false;
    }
}
