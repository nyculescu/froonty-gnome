// SPDX-License-Identifier: GPL-3.0-or-later
// The CPU/GPU/RAM load and temperature readings of the panic bar and of the
// Readouts. Each has one sampler, running only while it is on screen.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Emitter} from '../../core/emitter.js';
import {SYSTEM_IO} from './io.js';
import {Sampler} from './sampler.js';
import {FOLLOW_UP_MS, INTERVAL_KEY} from './service.js';

export const PANIC_LOAD_KEY = 'sysmon-panic-load-source';
export const PANIC_TEMP_KEY = 'sysmon-panic-temp-source';
export const READOUTS_INTERVAL_KEY = 'readouts-interval';
const LOAD_SOURCES = ['cpu', 'gpu', 'memory'];
const TEMP_SOURCES = ['average-cpu', 'max-cpu', 'gpu', 'load-source'];

const validNumber = value => typeof value === 'number' && Number.isFinite(value);
const maximum = values => values.length ? Math.max(...values) : null;

export function panicLoad(snapshot, source) {
    if (source === 'cpu')
        return validNumber(snapshot?.cpu?.load) ? snapshot.cpu.load : null;
    if (source === 'gpu')
        return maximum((snapshot?.gpus ?? []).map(gpu => gpu.load).filter(validNumber));
    if (source === 'memory') {
        const {used, total} = snapshot?.memory ?? {};
        return validNumber(used) && validNumber(total) && total > 0
            ? Math.min(100, Math.max(0, used * 100 / total)) : null;
    }
    return null;
}

// One reading per physical core: the threads of a core share its sensor,
// and a P-core's two would otherwise count twice against an E-core's one.
function cpuTemperature(snapshot, mode) {
    const seen = new Set();
    const coreTemps = [];
    for (const {core, temp} of snapshot?.cpu?.cores ?? []) {
        if (typeof core === 'number' && seen.has(core))
            continue;
        seen.add(core);
        if (validNumber(temp))
            coreTemps.push(temp);
    }
    if (coreTemps.length) {
        return mode === 'max-cpu'
            ? Math.max(...coreTemps)
            : coreTemps.reduce((sum, value) => sum + value, 0) / coreTemps.length;
    }
    return validNumber(snapshot?.cpu?.temp) ? snapshot.cpu.temp : null;
}

// Always °C. Following the load button, RAM (no general-purpose sensor)
// falls back to the average CPU temperature.
function temperatureSource(source, loadSource) {
    if (source !== 'load-source')
        return source;
    return loadSource === 'gpu' ? 'gpu' : 'average-cpu';
}

export function panicTemperature(snapshot, source, loadSource) {
    const selected = temperatureSource(source, loadSource);
    if (selected === 'gpu')
        return maximum((snapshot?.gpus ?? []).map(gpu => gpu.temp).filter(validNumber));
    return cpuTemperature(snapshot, selected);
}

export function temperatureColor(value) {
    const stops = [
        {at: 50, rgb: [51, 209, 122]},
        {at: 75, rgb: [246, 211, 45]},
        {at: 100, rgb: [224, 27, 36]},
    ];
    const temperature = Math.max(50, Math.min(100, value));
    const upper = stops.findIndex(stop => temperature <= stop.at);
    if (upper <= 0)
        return `rgb(${stops[0].rgb.join(', ')})`;
    const before = stops[upper - 1];
    const after = stops[upper];
    const share = (temperature - before.at) / (after.at - before.at);
    const rgb = before.rgb.map((channel, i) =>
        Math.round(channel + (after.rgb[i] - channel) * share));
    return `rgb(${rgb.join(', ')})`;
}

// One sampling loop: a reading at once, a quick second one (load and speeds
// are the change between two readings), then one each `interval` seconds,
// only while active. Subclasses set sections, cores and interval.
export class SystemSampling extends Emitter {
    constructor({io = SYSTEM_IO, now = () => GLib.get_monotonic_time() / 1e6} = {}) {
        super();
        this._io = io;
        this._now = now;
        this._sampler = new Sampler(io);
        this._active = false;
        this._timeoutId = 0;
        this._cancellable = null;
        this._warned = false;
        this.snapshot = null;
        /** Readings since the loop started; load needs two. */
        this.samples = 0;
        this.sections = new Set();
        this.cores = false;
        this.interval = 2;
    }

    setActive(active) {
        if (active === this._active)
            return;
        this._active = active;
        this._restart();
    }

    _restart() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        this._cancellable?.cancel();
        this._cancellable = null;
        // Kept while a GPU is still read: letting go and holding it again
        // would start nvidia-smi anew for nothing.
        if (!this._active || !this.sections.has('gpu'))
            this._sampler.release();
        this.snapshot = null;
        this.samples = 0;
        this._sampler.reset();
        this.emit('changed');
        if (!this._active || this.sections.size === 0)
            return;
        this._cancellable = new Gio.Cancellable();
        this._tick(true);
    }

    // _restart cancels the tick under way and removes the next one.
    async _tick(first) {
        const cancellable = this._cancellable;
        try {
            const snapshot = await this._sampler.sample([...this.sections], {
                cores: this.cores,
                now: this._now(),
                interval: this.interval,
                cancellable,
            });
            if (!cancellable.is_cancelled() && snapshot) {
                this.snapshot = snapshot;
                this.samples++;
                this.emit('changed');
            }
        } catch (error) {
            if (!cancellable.is_cancelled() && !this._warned) {
                console.warn(`Froonty: system metrics sample failed: ${error.message}`);
                this._warned = true;
            }
        } finally {
            if (!cancellable.is_cancelled()) {
                const delay = first ? FOLLOW_UP_MS : this.interval * 1000;
                this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                    this._timeoutId = 0;
                    this._tick(false);
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
    }
}

export class PanicMetricsService extends SystemSampling {
    constructor(settings, options = {}) {
        super(options);
        this._settings = settings;
        this._settingsIds = [];
        this._readSettings();
    }

    start() {
        for (const key of [PANIC_LOAD_KEY, PANIC_TEMP_KEY, INTERVAL_KEY]) {
            this._settingsIds.push(this._settings.connect(`changed::${key}`, () => {
                this._readSettings();
                this._restart();
            }));
        }
    }

    stop() {
        this.setActive(false);
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
    }

    _readSettings() {
        const load = this._settings.get_string(PANIC_LOAD_KEY);
        const temperature = this._settings.get_string(PANIC_TEMP_KEY);
        this.loadSource = LOAD_SOURCES.includes(load) ? load : 'cpu';
        this.temperatureSource = TEMP_SOURCES.includes(temperature) ? temperature : 'load-source';
        this.interval = this._settings.get_int(INTERVAL_KEY);
        const selected = temperatureSource(this.temperatureSource, this.loadSource);
        this.sections = new Set([this.loadSource, selected === 'gpu' ? 'gpu' : 'cpu']);
        // Per-core temperatures only for a CPU temperature shown.
        this.cores = selected !== 'gpu';
    }
}

// The Readouts' loop (ui/readoutBar.js): only the sections the chosen ones
// need, at an interval of their own, since it also runs while the island is
// collapsed.
export class ReadoutMetricsService extends SystemSampling {
    constructor(settings, options = {}) {
        super(options);
        this._settings = settings;
        this.interval = settings.get_int(READOUTS_INTERVAL_KEY);
        this._settingsId = settings.connect(`changed::${READOUTS_INTERVAL_KEY}`, () => {
            this.interval = settings.get_int(READOUTS_INTERVAL_KEY);
            this._restart();
        });
    }

    stop() {
        this.setActive(false);
        this._settings.disconnect(this._settingsId);
    }

    /**
     * @param {string[]} sections what the chosen readouts read
     * @param {boolean} cores whether one needs per-core temperatures
     */
    setNeeds(sections, cores) {
        this.sections = new Set(sections);
        this.cores = cores;
        this._restart();
    }
}
