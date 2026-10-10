// SPDX-License-Identifier: GPL-3.0-or-later
// Fan tab (docs/features/fan.md): the cooling pad's state and the CPU and
// GPU temperatures, read while the tab is on screen and not at all
// otherwise, as the Btop tab does (same Sampler, so a sleeping NVIDIA GPU
// is not woken up). The temperature history outlives a visit, with a gap
// for the time away, and keeps the last HISTORY_S.
//
// Pad commands run one at a time (pad.js spawns llano.py). A new speed
// replaces one still waiting, so dragging the slider sends only the
// latest; a status poll only runs when nothing waits.
//
// The recommended speed comes from llano-v12-linux's fan_lut.json (lut.js),
// read again on each visit, so a new sweep shows without a restart.
//
// Emits 'changed' after each sample or command, and when the settings
// change. No St.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Emitter} from '../../core/emitter.js';
import {SYSTEM_IO} from '../sysmon/io.js';
import {Sampler} from '../sysmon/sampler.js';
import {parseLut, recommend} from './lut.js';
import * as Pad from './pad.js';

export const INTERVAL_KEY = 'fan-interval';
export const SCRIPT_KEY = 'fan-llano-path';
export const LUT_KEY = 'fan-lut-path';
export const HISTORY_S = 300;

export class FanService extends Emitter {
    /**
     * @param {Gio.Settings} settings
     * @param {object} [deps] for tests: `pad` (pad.js's functions), `io`
     *   (sysmon/io.js), `now` (seconds)
     */
    constructor(settings, {pad = Pad, io = SYSTEM_IO, now = () => GLib.get_monotonic_time() / 1e6} = {}) {
        super();
        this._settings = settings;
        this._pad = pad;
        this._io = io;
        this._sampler = new Sampler(io);
        this._now = now;
        this._active = false;
        this._timerId = 0;
        this._cancellable = null;
        this._sampling = false;
        this._busy = false;
        this._pending = null;
        this._released = false;
        this._settingsIds = [];

        /** The pad's last state (pad.js parseStatus), or null. */
        this.status = null;
        /** Why the last command failed (pad.js failureKind), or null. */
        this.error = null;
        this.errorMessage = '';
        /** Active units that drive the pad by themselves (pad.js CONTROLLER_UNITS). */
        this.controllers = [];
        /** The panic lock's record (pad.js parseLock), or null when unlocked. */
        this.lock = null;
        /** Who drove the pad last (pad.js parseLastControl), or null. */
        this.lastControl = null;
        /** The speed's rpm, dB at the ears, band and the noise limit (pad.js parseNoise), or null. */
        this.noise = null;
        /** Latest temperatures: {cpu, gpus: [{id, name, temp, asleep}], cores: [{core, temp, threads}]}. */
        this.temps = null;
        /** [{t, cpu, gpus: {id: temp}, fan}], oldest first, t in seconds. */
        this.history = [];
        /** GPU id -> name, for the chart's legend, as they appeared. */
        this.gpuNames = new Map();
        /** fan_lut.json (lut.js parseLut), or null; lutError 'missing' or 'invalid' then. */
        this.lut = null;
        this.lutError = null;
        /** {fan, device, temp} from the LUT and the latest temperatures, or null. */
        this.recommendation = null;
        this._readSettings();
    }

    start() {
        this._settingsIds = [INTERVAL_KEY, SCRIPT_KEY, LUT_KEY].map(key =>
            this._settings.connect(`changed::${key}`, () => this._onSettingsChanged(key)));
    }

    stop() {
        this.setActive(false);
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
    }

    setActive(active) {
        if (active === this._active)
            return;
        this._active = active;
        if (active) {
            this._cancellable = new Gio.Cancellable();
            this._sampler.reset();
            this._loadLut();
            this._schedule();
            this._tick();
        } else {
            this._unschedule();
            this._cancellable.cancel();
            this._cancellable = null;
        }
    }

    /** The control shown: 'software', 'pad', 'released' (see release()) or null. */
    get control() {
        if (!this.status)
            return null;
        if (this.status.control === 'software' && this._released && !this.controllers.length)
            return 'released';
        return this.status.control;
    }

    /** Whether a command runs or waits (the view leaves the slider alone meanwhile). */
    get busy() {
        return this._busy || this._pending !== null;
    }

    /** Takes software control and sets the fan to `percent` (0-100). */
    setSpeed(percent) {
        const speed = Math.round(Math.min(100, Math.max(0, percent)));
        this._released = false;
        this._queue({args: ['speed', String(speed)]});
    }

    /**
     * Hands speed control back to the pad's roller. The pad keeps its speed,
     * and its status still says software until the roller is next turned
     * (llano-v12-linux README), so the tab says "released" until then.
     */
    release() {
        this._queue({args: ['release'], released: true});
    }

    /** The panic lock: fan off and llano.py refusing every write, or back. */
    setLocked(locked) {
        this._released = false;
        this._queue({args: [locked ? 'lock' : 'unlock']});
    }

    /** Lifts the noise limits until quiet hours end (llano.py loud), or puts them back. */
    setLoud(loud) {
        this._queue({args: [loud ? 'loud' : 'quiet']});
    }

    async stopController(unit) {
        await this._pad.stopUnit(unit);
        this._released = true;
        this.controllers = await this._pad.controllers();
        this._queue({args: ['status']});
    }

    _readSettings() {
        this._interval = this._settings.get_int(INTERVAL_KEY);
        this._script = this._settings.get_string(SCRIPT_KEY);
        this._lutPath = this._settings.get_string(LUT_KEY);
    }

    _onSettingsChanged(key) {
        this._readSettings();
        if (this._active && key === INTERVAL_KEY)
            this._schedule();
        if (this._active && key === SCRIPT_KEY)
            this._queue({args: ['status']}, {poll: true});
        if (this._active && key === LUT_KEY)
            this._loadLut();
        this.emit('changed');
    }

    _schedule() {
        this._unschedule();
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

    async _readState() {
        const dir = this._pad.stateDir();
        const [lock, log] = await Promise.all([
            this._io.read(`${dir}/lock`, this._cancellable),
            this._io.read(`${dir}/control.log`, this._cancellable),
        ]);
        this.lock = this._pad.parseLock(lock);
        this.lastControl = this._pad.parseLastControl(log);
    }

    _tick() {
        this._queue({args: ['status']}, {poll: true});
        this._pad.controllers(this._cancellable).then(units => {
            this.controllers = units;
        }).catch(() => {});
        this._sample();
    }

    // A poll never replaces a command the user asked for.
    _queue(command, {poll = false} = {}) {
        if (poll && this.busy)
            return;
        this._pending = command;
        this._drain();
    }

    async _drain() {
        if (this._busy || !this._pending)
            return;
        const command = this._pending;
        this._pending = null;
        this._busy = true;
        try {
            const {status, noise, error, message} = await this._pad.llano(this._script, command.args);
            // A write refused by the lock leaves the pad as it was.
            this.status = status ?? (error === 'locked' ? this.status : null);
            this.noise = status ? noise : error === 'locked' ? this.noise : null;
            this.error = error;
            this.errorMessage = message;
            if (command.released)
                this._released = true;
            // Turning the roller after a release: the pad is in charge again.
            if (status?.control === 'pad')
                this._released = false;
            // Before the command counts as done, so no poll slips in between.
            await this._readState();
        } catch (e) {
            this.status = null;
            this.error = 'failed';
            this.errorMessage = e.message;
        } finally {
            this._busy = false;
        }
        this.emit('changed');
        this._drain();
    }

    async _loadLut() {
        const text = await this._io.read(this._lutPath, this._cancellable);
        if (this._cancellable?.is_cancelled())
            return;
        this.lut = text === null ? null : parseLut(text);
        this.lutError = text === null ? 'missing' : this.lut ? null : 'invalid';
        this._recommend();
        this.emit('changed');
    }

    // The NVIDIA (or hottest) GPU stands for 'gpu', as in the sweep.
    // Capped to the noise limit in force (llano.py would cap it anyway);
    // `wanted` keeps what the table asks for.
    _recommend() {
        const gpuTemps = (this.temps?.gpus ?? []).map(gpu => gpu.temp).filter(t => t !== null && t !== undefined);
        const rec = this.lut && this.temps
            ? recommend(this.lut, {cpu: this.temps.cpu, gpu: gpuTemps.length ? Math.max(...gpuTemps) : null})
            : null;
        const cap = this.noise?.limit?.max_percent ?? 100;
        this.recommendation = rec && {...rec, wanted: rec.fan, fan: Math.min(rec.fan, cap)};
    }

    async _sample() {
        // A slow nvidia-smi never piles up behind itself.
        if (this._sampling)
            return;
        this._sampling = true;
        const cancellable = this._cancellable;
        const now = this._now();
        try {
            const snapshot = await this._sampler.sample(['cpu', 'gpu'], {cores: true, now, cancellable});
            if (!snapshot || cancellable?.is_cancelled())
                return;
            this._record(snapshot, now);
            this.emit('changed');
        } catch (e) {
            console.warn(`Froonty: Fan tab sample failed: ${e.message}`);
        } finally {
            this._sampling = false;
        }
    }

    _record(snapshot, now) {
        const gpus = (snapshot.gpus ?? []).map(gpu => ({
            id: gpu.id, name: gpu.name, temp: gpu.temp, asleep: gpu.asleep,
        }));
        for (const gpu of gpus)
            this.gpuNames.set(gpu.id, gpu.name);
        this.temps = {cpu: snapshot.cpu?.temp ?? null, gpus, cores: physicalCores(snapshot.cpu?.cores)};
        this._recommend();
        this.history.push({
            t: now,
            cpu: this.temps.cpu,
            gpus: Object.fromEntries(gpus.map(gpu => [gpu.id, gpu.temp])),
            fan: this.status?.speed ?? null,
        });
        while (this.history.length && this.history[0].t < now - HISTORY_S)
            this.history.shift();
    }

    /** The sampling interval in seconds (the chart breaks its lines over longer gaps). */
    get interval() {
        return this._interval;
    }
}

/**
 * One entry per physical core, in core id order: its temperature and how
 * many threads it runs (2 on a P-core, 1 on an E-core of a hybrid Intel).
 */
export function physicalCores(threads) {
    const cores = new Map();
    for (const thread of threads ?? []) {
        if (thread.core === null || thread.core === undefined)
            continue;
        const core = cores.get(thread.core) ?? {core: thread.core, temp: thread.temp, threads: 0};
        core.threads++;
        cores.set(thread.core, core);
    }
    return [...cores.values()].sort((a, b) => a.core - b.core);
}
