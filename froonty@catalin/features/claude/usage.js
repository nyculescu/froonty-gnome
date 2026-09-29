// SPDX-License-Identifier: GPL-3.0-or-later
// Claude plan usage, as Claude Code caches it in its config file
// (docs/features/claude.md). Pure: parsing and reset arithmetic, no Gio, no
// St, so it is unit-tested with plain gjs.
//
// The cache is Claude Code's own, undocumented format: an entry this reader
// does not know is left out rather than guessed.

export const SESSION = 'session';
export const WEEKLY = 'weekly';
// A weekly allowance for one model, such as Fable.
export const MODEL = 'model';

// Below this, a reset reads "in 3 h 5 min"; from it on, "Sat 22:59".
export const RELATIVE_RESET_MS = 24 * 3600 * 1000;

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The plan's usage windows from a parsed Claude Code config file.
 *
 * @param {object} config
 * @returns {{fetchedAt: number, windows: object[]}|null} windows in display
 *   order (session, weekly, then one per model), each {id, kind, model,
 *   percent, resetsAt, severity}; times in ms since the epoch. Null when the
 *   file holds no usage for the signed-in account.
 */
export function usageFromConfig(config) {
    const cache = config?.cachedUsageUtilization;
    if (!isObject(cache) || !isObject(cache.utilization))
        return null;
    const fetchedAt = cache.fetchedAtMs;
    if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt) || fetchedAt <= 0)
        return null;
    // Claude Code drops a cache another account left behind; so does this.
    if (cache.accountUuid !== config.oauthAccount?.accountUuid)
        return null;

    const usage = cache.utilization;
    const windows = [];
    const add = window => {
        if (window && !windows.some(w => w.id === window.id))
            windows.push(window);
    };
    // The server's rows, in its order. The older top-level fields fill in
    // what they lack.
    if (Array.isArray(usage.limits))
        usage.limits.forEach(row => add(fromLimitRow(row)));
    add(fromLegacy(usage.five_hour, SESSION));
    add(fromLegacy(usage.seven_day, WEEKLY));
    add(fromLegacy(usage.seven_day_opus, MODEL, 'Opus'));
    add(fromLegacy(usage.seven_day_sonnet, MODEL, 'Sonnet'));

    if (!windows.length)
        return null;
    const rank = w => [SESSION, WEEKLY, MODEL].indexOf(w.kind);
    // Array.prototype.sort is stable: models keep the server's order.
    windows.sort((a, b) => rank(a) - rank(b));
    return {fetchedAt, windows};
}

// {kind: 'session' | 'weekly_all' | 'weekly_scoped', percent, resets_at,
//  severity, scope: {model: {display_name}, surface}}
function fromLimitRow(row) {
    if (!isObject(row) || !isPercent(row.percent))
        return null;
    const common = {
        percent: row.percent,
        resetsAt: parseTime(row.resets_at),
        severity: typeof row.severity === 'string' ? row.severity : null,
    };
    switch (row.kind) {
    case 'session':
        return {id: SESSION, kind: SESSION, model: null, ...common};
    case 'weekly_all':
        return {id: WEEKLY, kind: WEEKLY, model: null, ...common};
    case 'weekly_scoped': {
        // Only per-model allowances; one for a product (a "surface", like
        // Cowork) is not what this tab shows.
        const model = row.scope?.model?.display_name;
        if (typeof model !== 'string' || !model.trim() || row.scope?.surface)
            return null;
        return {id: modelId(model), kind: MODEL, model: model.trim(), ...common};
    }
    default:
        return null;
    }
}

// {utilization: 0-100, resets_at}
function fromLegacy(entry, kind, model = null) {
    if (!isObject(entry) || !isPercent(entry.utilization))
        return null;
    return {
        id: kind === MODEL ? modelId(model) : kind,
        kind,
        model,
        percent: entry.utilization,
        resetsAt: parseTime(entry.resets_at),
        severity: null,
    };
}

const modelId = model => `${MODEL}:${model.trim().toLowerCase()}`;

// Above 100 is possible (use past the cap, e.g. at lower priority).
const isPercent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function parseTime(value) {
    if (typeof value !== 'string')
        return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}

/** The share of the bar to fill, 0-1. */
export function fillFraction(percent) {
    return Math.min(1, Math.max(0, percent / 100));
}

/**
 * When a window renews, relative to `now`.
 *
 * @returns {{kind: 'in', hours: number, minutes: number}
 *         | {kind: 'at', time: number}
 *         | {kind: 'renewed', time: number}
 *         | {kind: 'unknown'}}
 *   'renewed': the window renewed after the reading, so what was used since
 *   is unknown.
 */
export function describeReset(resetsAt, now) {
    if (resetsAt === null)
        return {kind: 'unknown'};
    const left = resetsAt - now;
    if (left <= 0)
        return {kind: 'renewed', time: resetsAt};
    // Rounded up: "in 1 min" until the moment it renews, never "in 0 min".
    // Compared after rounding, so never "in 24 h 0 min" either.
    const minutes = Math.ceil(left / 60000);
    if (minutes * 60000 >= RELATIVE_RESET_MS)
        return {kind: 'at', time: resetsAt};
    return {kind: 'in', hours: Math.floor(minutes / 60), minutes: minutes % 60};
}

/** Whole minutes since the reading (0 for one from the future). */
export function minutesSince(time, now) {
    return Math.max(0, Math.floor((now - time) / 60000));
}
