// SPDX-License-Identifier: GPL-3.0-or-later
// One nvidia-smi for every sampler that reads an NVIDIA card that cannot
// sleep anyway (docs/features/sysmon.md): started with -lms, it writes a
// line per card each interval, and samples take the latest line instead of
// spawning nvidia-smi each time (about 19 ms of CPU and a fork of the Shell
// per run). It runs while at least one sampler holds it, at the shortest
// interval they ask for, and is killed when the last one lets go. Cards
// that can runtime-suspend are never followed: an NVML client keeps a card
// awake. No St.

import GLib from 'gi://GLib';

import {NVIDIA_FIELDS, parseNvidiaSmi} from './parse.js';

// How long a sample waits for a new process's first lines, as for one run.
const WAIT_MS = 5000;
// The wait before starting again after an exit nobody asked for, doubling
// from the first to the last.
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 60000;

export class NvidiaLoop {
    /**
     * @param {object} io SYSTEM_IO (io.js) or a fake: its follow()
     * @param {object} [options] for tests: `now` in ms, and the waits
     */
    constructor(io, {
        now = () => GLib.get_monotonic_time() / 1000,
        waitMs = WAIT_MS,
        firstRetryMs = FIRST_RETRY_MS,
        maxRetryMs = MAX_RETRY_MS,
    } = {}) {
        this._io = io;
        this._now = now;
        this._waitMs = waitMs;
        this._firstRetryMs = firstRetryMs;
        this._maxRetryMs = maxRetryMs;
        // Holder -> {path, addresses, intervalMs}.
        this._holds = new Map();
        this._config = null;
        this._key = null;
        this._process = null;
        // Whether the running process has written yet, and when it last did
        // (or started).
        this._started = false;
        this._lastWrite = 0;
        this._retryId = 0;
        this._retryMs = firstRetryMs;
        // Lower-case PCI address -> {values, time}.
        this._latest = new Map();
        this._waiters = new Set();
    }

    /** Whether nvidia-smi runs (for tests). */
    get running() {
        return this._process !== null;
    }

    /**
     * Keeps nvidia-smi running for `holder` until release(holder). Called
     * again, it replaces what the holder asked for; a new set of cards or a
     * new shortest interval starts it again.
     *
     * @param {object} holder any object, once per sampler
     * @param {{path: string, addresses: string[], intervalMs: number}} request
     */
    hold(holder, request) {
        this._holds.set(holder, request);
        this._sync();
    }

    release(holder) {
        if (this._holds.delete(holder))
            this._sync();
    }

    /** Drops a card found able to sleep from every holder, not only the one that found it. */
    forget(address) {
        const lower = address.toLowerCase();
        let changed = false;
        for (const [holder, request] of this._holds) {
            const addresses = request.addresses.filter(a => a.toLowerCase() !== lower);
            if (addresses.length === request.addresses.length)
                continue;
            changed = true;
            if (addresses.length)
                this._holds.set(holder, {...request, addresses});
            else
                this._holds.delete(holder);
        }
        if (changed)
            this._sync();
    }

    /**
     * The latest readings of `addresses` (see parseNvidiaSmi), by lower-case
     * address, each at most two intervals old. Right after a start it waits
     * for the first lines, at most WAIT_MS or until `cancellable` cancels.
     *
     * @returns {Promise<Map<string, object>>}
     */
    read(addresses, cancellable = null) {
        this._restartIfStalled();
        const fresh = this._fresh(addresses);
        if (fresh.size === addresses.length || !this._process || this._started ||
            cancellable?.is_cancelled())
            return Promise.resolve(fresh);
        return new Promise(resolve => {
            let timeoutId = 0;
            let cancelId = 0;
            const waiter = fromCancel => {
                this._waiters.delete(waiter);
                if (timeoutId)
                    GLib.source_remove(timeoutId);
                timeoutId = 0;
                // Disconnecting inside the cancellable's own handler deadlocks.
                if (cancelId && !fromCancel)
                    cancellable.disconnect(cancelId);
                cancelId = 0;
                resolve(this._fresh(addresses));
            };
            this._waiters.add(waiter);
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._waitMs, () => {
                timeoutId = 0;
                waiter(false);
                return GLib.SOURCE_REMOVE;
            });
            cancelId = cancellable?.connect(() => waiter(true)) ?? 0;
        });
    }

    // One that stopped writing (a wedged driver, say) is started again, as
    // a run that hung used to be given up after WAIT_MS.
    _restartIfStalled() {
        if (!this._process ||
            this._now() - this._lastWrite <= Math.max(3 * this._config.intervalMs, this._waitMs))
            return;
        this._stop();
        this._wake();
        this._retry();
    }

    _fresh(addresses) {
        const limit = 2 * (this._config?.intervalMs ?? 0);
        const now = this._now();
        const fresh = new Map();
        for (const address of addresses.map(a => a.toLowerCase())) {
            const latest = this._latest.get(address);
            if (latest && now - latest.time <= limit)
                fresh.set(address, latest.values);
        }
        return fresh;
    }

    _sync() {
        const holds = [...this._holds.values()];
        const config = holds.length ? {
            path: holds[0].path,
            addresses: [...new Set(holds.flatMap(hold => hold.addresses))].sort(),
            intervalMs: Math.min(...holds.map(hold => hold.intervalMs)),
        } : null;
        const key = config && JSON.stringify(config);
        if (key === this._key)
            return;
        this._key = key;
        this._config = config;
        this._stop();
        this._retryMs = this._firstRetryMs;
        if (config) {
            this._start();
        } else {
            this._latest.clear();
            this._wake();
        }
    }

    _start() {
        const {path, addresses, intervalMs} = this._config;
        const argv = [path, `--query-gpu=${NVIDIA_FIELDS.join(',')}`, '--format=csv,noheader,nounits',
            '-i', addresses.join(','), '-lms', String(intervalMs)];
        const child = this._io.follow(argv, lines => {
            if (child === this._process)
                this._onLines(lines);
        }, () => {
            if (child === this._process)
                this._onEnd();
        });
        this._process = child;
        this._started = false;
        this._lastWrite = this._now();
        if (!child) {
            // Reads still waiting for the process this one replaced.
            this._wake();
            this._retry();
        }
    }

    _stop() {
        if (this._retryId)
            GLib.source_remove(this._retryId);
        this._retryId = 0;
        this._process?.stop();
        this._process = null;
    }

    _onLines(lines) {
        const time = this._now();
        const rows = parseNvidiaSmi(lines.join('\n'));
        for (const [address, values] of rows)
            this._latest.set(address, {values, time});
        this._started = true;
        this._lastWrite = time;
        // Only a reading proves it works; an error message is a line too.
        if (rows.size)
            this._retryMs = this._firstRetryMs;
        this._wake();
    }

    _onEnd() {
        this._process = null;
        this._wake();
        this._retry();
    }

    _retry() {
        const delay = this._retryMs;
        this._retryMs = Math.min(2 * this._retryMs, this._maxRetryMs);
        this._retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._retryId = 0;
            this._start();
            return GLib.SOURCE_REMOVE;
        });
    }

    _wake() {
        for (const waiter of [...this._waiters])
            waiter(false);
    }
}

const loops = new WeakMap();

/** The one NvidiaLoop per io object, so SYSTEM_IO's is the Shell's. */
export function nvidiaLoop(io) {
    let loop = loops.get(io);
    if (!loop) {
        loop = new NvidiaLoop(io);
        loops.set(io, loop);
    }
    return loop;
}
