// SPDX-License-Identifier: GPL-3.0-or-later
// What each readout prints, from its source's data. No St, so it loads in
// plain gjs tests.
//
// A value is {text, kind, styleClass, color, asleep}, all but text optional:
// kind names the width class in the stylesheet, styleClass or color the
// colour. Null means it cannot be read here (printed as "?").

import {levelClass} from '../features/sysmon/level.js';
import {panicLoad, panicTemperature, temperatureColor} from '../features/sysmon/panicMetrics.js';

const KILO = 1000;

const known = value => typeof value === 'number' && Number.isFinite(value);

/**
 * A city's name on the pill: "Dublin" gives "Dub", "New York" gives "NY".
 *
 * @param {string} name
 * @returns {string}
 */
export function shortCityName(name) {
    const words = name.trim().split(/\s+/);
    if (words.length > 1)
        return words.map(word => [...word][0].toUpperCase()).join('');
    return [...words[0]].slice(0, 3).join('');
}

function percent(value) {
    if (!known(value))
        return null;
    const rounded = Math.round(value);
    return {text: `${rounded}%`, kind: 'percent', styleClass: levelClass(rounded)};
}

function degrees(value) {
    if (!known(value))
        return null;
    return {text: `${Math.round(value)}°C`, kind: 'degrees', color: temperatureColor(value)};
}

// Short enough for the pill: 850K, 1.2M, 12M.
export function compactSpeed(bytesPerSecond) {
    if (!known(bytesPerSecond))
        return null;
    const kilo = bytesPerSecond / KILO;
    if (kilo < KILO)
        return {text: `${Math.round(kilo)}K`, kind: 'speed'};
    const mega = kilo / KILO;
    if (mega < 10)
        return {text: `${mega.toFixed(1)}M`, kind: 'speed'};
    if (mega < KILO)
        return {text: `${Math.round(mega)}M`, kind: 'speed'};
    return {text: `${(mega / KILO).toFixed(1)}G`, kind: 'speed'};
}

// Every card asleep is not "unknown": it is normal on a hybrid laptop.
function gpu(snapshot, value) {
    const gpus = snapshot?.gpus ?? [];
    if (gpus.length > 0 && gpus.every(card => card.asleep))
        return {text: '–', asleep: true};
    return value;
}

function diskPercent(snapshot) {
    const {used, total} = snapshot?.disks?.root ?? {};
    return known(used) && known(total) && total > 0 ? percent(used * 100 / total) : null;
}

// The readouts read from the system sampler: the sections each needs, and
// whether it needs per-core temperatures.
export const METRICS = {
    'cpu-load': {sections: ['cpu'], read: s => percent(panicLoad(s, 'cpu'))},
    'gpu-load': {sections: ['gpu'], read: s => gpu(s, percent(panicLoad(s, 'gpu')))},
    'ram-usage': {sections: ['memory'], read: s => percent(panicLoad(s, 'memory'))},
    'cpu-temp': {
        sections: ['cpu'],
        cores: true,
        read: s => degrees(panicTemperature(s, 'average-cpu')),
    },
    'cpu-temp-max': {
        sections: ['cpu'],
        cores: true,
        read: s => degrees(panicTemperature(s, 'max-cpu')),
    },
    'gpu-temp': {sections: ['gpu'], read: s => gpu(s, degrees(panicTemperature(s, 'gpu')))},
    'net-down': {sections: ['network'], read: s => compactSpeed(s?.network?.down)},
    'net-up': {sections: ['network'], read: s => compactSpeed(s?.network?.up)},
    'disk-used': {sections: ['disks'], read: diskPercent},
};

/**
 * What the chosen readouts ask of the sampler.
 *
 * @param {string[]} ids
 * @returns {{sections: string[], cores: boolean}}
 */
export function metricNeeds(ids) {
    const chosen = ids.map(id => METRICS[id]).filter(Boolean);
    return {
        sections: [...new Set(chosen.flatMap(metric => metric.sections))],
        cores: chosen.some(metric => metric.cores),
    };
}

/**
 * One Claude usage window, by the Claude tab's rules: unknown offline, or
 * once the window renewed after the reading.
 *
 * @param {?object} usage ClaudeService's usage
 * @param {boolean} online
 * @param {string} kind SESSION or WEEKLY (features/claude/usage.js)
 * @param {number} now ms since the epoch
 */
export function claudeUsage(usage, online, kind, now) {
    const window = usage?.windows.find(w => w.kind === kind);
    if (!online || !window || (window.resetsAt !== null && window.resetsAt <= now))
        return null;
    return {text: `${Math.min(100, Math.round(window.percent))}%`, kind: 'percent'};
}
