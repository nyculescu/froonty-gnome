// SPDX-License-Identifier: GPL-3.0-or-later
// The panic bar's CPU/GPU/RAM load and temperature readings. One sampler is
// shared by both indicators and runs only while the bar is on screen.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Emitter} from '../../core/emitter.js';
import {SYSTEM_IO} from './io.js';
import {Sampler} from './sampler.js';

export const PANIC_LOAD_KEY = 'sysmon-panic-load-source';
export const PANIC_TEMP_KEY = 'sysmon-panic-temp-source';
const INTERVAL_KEY = 'sysmon-interval';
const FOLLOW_UP_MS = 500;
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

function cpuTemperature(snapshot, mode) {
    const coreTemps = (snapshot?.cpu?.cores ?? [])
        .map(core => core.temp).filter(validNumber);
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

export class PanicMetricsService extends Emitter {
    constructor(settings, {io = SYSTEM_IO, now = () => GLib.get_monotonic_time() / 1e6} = {}) {
        super();
        this._settings = settings;
        this._io = io;
        this._now = now;
        this._sampler = new Sampler(io);
        this._active = false;
        this._timeoutId = 0;
        this._cancellable = null;
        this._generation = 0;
        this._samplingGeneration = null;
        this._settingsIds = [];
        this._warned = false;
        this.snapshot = null;
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

    setActive(active) {
        if (active === this._active)
            return;
        this._active = active;
        this._restart();
    }

    _readSettings() {
        const load = this._settings.get_string(PANIC_LOAD_KEY);
        const temperature = this._settings.get_string(PANIC_TEMP_KEY);
        this.loadSource = LOAD_SOURCES.includes(load) ? load : 'cpu';
        this.temperatureSource = TEMP_SOURCES.includes(temperature) ? temperature : 'load-source';
        this.interval = this._settings.get_int(INTERVAL_KEY);
        this.sections = new Set();

        this.sections.add(this.loadSource);
        this.sections.add(
            temperatureSource(this.temperatureSource, this.loadSource) === 'gpu' ? 'gpu' : 'cpu');
    }

    _restart() {
        this._generation++;
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        this._cancellable?.cancel();
        this._cancellable = null;
        this._samplingGeneration = null;
        this.snapshot = null;
        this._sampler = new Sampler(this._io);
        this.emit('changed');
        if (!this._active)
            return;
        this._cancellable = new Gio.Cancellable();
        this._tick(this._generation, true);
    }

    async _tick(generation, first) {
        if (!this._active || generation !== this._generation ||
            this._samplingGeneration === generation)
            return;
        this._samplingGeneration = generation;
        const cancellable = this._cancellable;
        const sampler = this._sampler;
        try {
            const snapshot = await sampler.sample([...this.sections], {
                cores: this.sections.has('cpu'),
                now: this._now(),
                cancellable,
            });
            if (!cancellable.is_cancelled() && generation === this._generation && snapshot) {
                this.snapshot = snapshot;
                this.emit('changed');
            }
        } catch (error) {
            if (!cancellable.is_cancelled() && !this._warned) {
                console.warn(`Froonty: panic system metrics sample failed: ${error.message}`);
                this._warned = true;
            }
        } finally {
            if (this._samplingGeneration === generation)
                this._samplingGeneration = null;
            if (this._active && generation === this._generation && !cancellable.is_cancelled()) {
                const delay = first ? FOLLOW_UP_MS : this.interval * 1000;
                this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                    this._timeoutId = 0;
                    this._tick(generation, false);
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
    }
}
