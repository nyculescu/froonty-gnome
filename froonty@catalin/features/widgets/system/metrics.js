// SPDX-License-Identifier: GPL-3.0-or-later
// The System widget's metrics (Btop's readings): what each reads from a
// sampler snapshot (features/sysmon/sampler.js), how it is printed, the
// history behind its graph (widgets-system-period minutes), its moving
// average, and the order of a row's parts. Pure, so it loads in plain
// gjs tests and in the settings window.

import {levelClass} from '../../sysmon/level.js';
import {panicLoad, panicTemperature, temperatureColor} from '../../sysmon/panicMetrics.js';

export const MINUTE_MS = 60 * 1000;

// A row's parts, left to right (widgets-system-layout): the value now, the
// name with its low and high, the graph.
export const PARTS = ['value', 'name', 'graph'];
export const LAYOUTS = [
    'value-name-graph', 'value-graph-name', 'name-value-graph',
    'name-graph-value', 'graph-value-name', 'graph-name-value',
];

/** A layout's parts, in order; the default for an unknown one. */
export function layoutParts(layout) {
    return (LAYOUTS.includes(layout) ? layout : LAYOUTS[0]).split('-');
}

/**
 * The trailing moving average of `points` over `windowMs`: each point the
 * mean of the readings in the window that ends at it.
 *
 * @param {Array<{t, v}>} points in time order
 * @param {number} windowMs 0 leaves them as they are
 * @returns {Array<{t, v}>}
 */
export function movingAverage(points, windowMs) {
    if (!(windowMs > 0))
        return points;
    const averaged = [];
    let sum = 0;
    let first = 0;
    points.forEach((point, i) => {
        sum += point.v;
        while (points[first].t <= point.t - windowMs) {
            sum -= points[first].v;
            first++;
        }
        averaged.push({t: point.t, v: sum / (i - first + 1)});
    });
    return averaged;
}

const known = value => typeof value === 'number' && Number.isFinite(value);
const maximum = values => {
    const numbers = values.filter(known);
    return numbers.length ? Math.max(...numbers) : null;
};
const share = (used, total) => known(used) && known(total) && total > 0 ? used * 100 / total : null;

// Every card asleep reads as nothing to draw, not as zero.
const awakeGpus = s => (s?.gpus ?? []).filter(gpu => !gpu.asleep);

function speedText(bytesPerSecond) {
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let value = bytesPerSecond;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit++;
    }
    return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const PERCENT = {
    format: v => ({text: `${Math.round(v)}%`, styleClass: levelClass(Math.round(v))}),
    scale: () => [0, 100],
};
const DEGREES = {
    format: v => ({text: `${Math.round(v)}°C`, color: temperatureColor(v)}),
    scale: values => [Math.min(30, ...values), Math.max(90, ...values)],
};
// From zero up to the highest reading, so a quiet half hour stays flat.
const fromZero = values => [0, Math.max(...values, 0) || 1];

/**
 * In the order Settings offers them. `sections` and `cores` are what the
 * sampler has to read for it; `gpu` marks those that may run nvidia-smi.
 */
export const SYSTEM_METRICS = [
    {id: 'cpu-load', title: _ => _('CPU load'), sections: ['cpu'], ...PERCENT,
        value: s => panicLoad(s, 'cpu')},
    {id: 'cpu-temp', title: _ => _('CPU temperature'), sections: ['cpu'], cores: true, ...DEGREES,
        value: s => panicTemperature(s, 'average-cpu')},
    {id: 'cpu-temp-max', title: _ => _('Hottest CPU core'), sections: ['cpu'], cores: true, ...DEGREES,
        value: s => panicTemperature(s, 'max-cpu')},
    {id: 'cpu-clock', title: _ => _('CPU clock'), sections: ['cpu'],
        value: s => known(s?.cpu?.ghz) ? s.cpu.ghz : null,
        format: v => ({text: `${v.toFixed(1)} GHz`}), scale: fromZero},
    {id: 'ram-usage', title: _ => _('RAM usage'), sections: ['memory'], ...PERCENT,
        value: s => panicLoad(s, 'memory')},
    {id: 'swap-usage', title: _ => _('Swap usage'), sections: ['disks'], ...PERCENT,
        value: s => share(s?.disks?.swap?.used, s?.disks?.swap?.total)},
    {id: 'gpu-load', title: _ => _('GPU load'), sections: ['gpu'], gpu: true, ...PERCENT,
        value: s => maximum(awakeGpus(s).map(gpu => gpu.load))},
    {id: 'gpu-temp', title: _ => _('GPU temperature'), sections: ['gpu'], gpu: true, ...DEGREES,
        value: s => maximum(awakeGpus(s).map(gpu => gpu.temp))},
    {id: 'gpu-memory', title: _ => _('GPU memory'), sections: ['gpu'], gpu: true, ...PERCENT,
        value: s => maximum(awakeGpus(s).map(gpu => share(gpu.memUsed, gpu.memTotal)))},
    {id: 'gpu-power', title: _ => _('GPU power'), sections: ['gpu'], gpu: true,
        value: s => maximum(awakeGpus(s).map(gpu => gpu.power)),
        format: v => ({text: `${Math.round(v)} W`}), scale: fromZero},
    {id: 'net-down', title: _ => _('Download speed'), sections: ['network'],
        value: s => known(s?.network?.down) ? s.network.down : null,
        format: v => ({text: speedText(v)}), scale: fromZero},
    {id: 'net-up', title: _ => _('Upload speed'), sections: ['network'],
        value: s => known(s?.network?.up) ? s.network.up : null,
        format: v => ({text: speedText(v)}), scale: fromZero},
    {id: 'disk-used', title: _ => _('Disk used'), sections: ['disks'], ...PERCENT,
        value: s => share(s?.disks?.root?.used, s?.disks?.root?.total)},
];

export const DEFAULT_METRICS = ['cpu-load', 'cpu-temp', 'ram-usage', 'net-down', 'net-up'];

export function metricById(id) {
    return SYSTEM_METRICS.find(metric => metric.id === id) ?? null;
}

/** The chosen ids that exist, in the catalog's order, each once. */
export function chosenMetrics(ids) {
    const wanted = new Set(ids);
    return SYSTEM_METRICS.filter(metric => wanted.has(metric.id));
}

/** What the sampler has to read for these metrics. */
export function systemNeeds(metrics) {
    return {
        sections: [...new Set(metrics.flatMap(metric => metric.sections))],
        cores: metrics.some(metric => metric.cores),
    };
}

/**
 * One metric's readings of the last period, [{t, v}] with t in ms of wall
 * time (so a suspend shows as a gap, not as time that never passed).
 */
export class History {
    constructor() {
        this.points = [];
    }

    add(t, v, periodMs) {
        if (known(v))
            this.points.push({t, v});
        this.prune(t, periodMs);
    }

    prune(now, periodMs) {
        const from = now - periodMs;
        const first = this.points.findIndex(point => point.t >= from);
        this.points.splice(0, first < 0 ? this.points.length : first);
    }

    /** {min, max} of the readings kept, or null without any. */
    range() {
        if (!this.points.length)
            return null;
        const values = this.points.map(point => point.v);
        return {min: Math.min(...values), max: Math.max(...values)};
    }
}
