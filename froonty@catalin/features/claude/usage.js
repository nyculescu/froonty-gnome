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
// Cloud session credits: a dollar allowance that renews monthly.
export const CREDITS = 'credits';

// The cache's name for the cloud session credits. A codename, not a label:
// matched by the user against claude.ai's Settings → Usage on 2026-09-30
// (its remaining_dollars is what claude.ai shows as left).
const CREDITS_KEY = 'iguana_necktie';

// Below this, a reset reads "in 3 h 5 min"; from it on, "Sat 22:59".
export const RELATIVE_RESET_MS = 24 * 3600 * 1000;

// A reading older than this is marked as such. Claude Code itself stops
// trusting its cache after an hour.
export const STALE_MS = 3600 * 1000;

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The plan's usage windows from a parsed Claude Code config file.
 *
 * @param {object} config
 * @returns {{fetchedAt: number, windows: object[]}|null} windows in display
 *   order (session, weekly, then one per model), each {id, kind, model,
 *   percent, resetsAt, severity, fetchedAt}; times in ms since the epoch. The credits
 *   window also has {limit, used, remaining}, in dollars. Null when the
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
    add(fromCredits(usage[CREDITS_KEY]));

    if (!windows.length)
        return null;
    windows.forEach(w => (w.fetchedAt = fetchedAt));
    return {fetchedAt, windows: sorted(windows)};
}

const sorted = windows => {
    const rank = w => [SESSION, WEEKLY, MODEL, CREDITS].indexOf(w.kind);
    // Array.prototype.sort is stable: models keep the server's order.
    return windows.sort((a, b) => rank(a) - rank(b));
};

/**
 * What Froonty's Claude Code status line script (statusline.py) last saved:
 * Claude Code's `rate_limits` for the status line, documented at
 * code.claude.com/docs/en/statusline, plus when it was saved.
 *
 * @param {object} data the parsed file:
 *   {writtenAtMs, rate_limits: {five_hour: {used_percentage, resets_at}, seven_day}}
 *   with resets_at in seconds since the epoch
 * @returns {{writtenAt: number, windows: object[]}|null} Session and Weekly
 *   windows shaped as usageFromConfig's; null when there is nothing usable
 */
export function statusLineFromFile(data) {
    const writtenAt = data?.writtenAtMs;
    if (typeof writtenAt !== 'number' || !Number.isFinite(writtenAt) || writtenAt <= 0 ||
        !isObject(data.rate_limits))
        return null;
    const windows = [];
    for (const [key, kind] of [['five_hour', SESSION], ['seven_day', WEEKLY]]) {
        const entry = data.rate_limits[key];
        if (!isObject(entry) || !isPercent(entry.used_percentage))
            continue;
        const resets = entry.resets_at;
        windows.push({
            id: kind,
            kind,
            model: null,
            percent: entry.used_percentage,
            resetsAt: typeof resets === 'number' && Number.isFinite(resets) && resets > 0
                ? resets * 1000 : null,
            severity: null,
            fetchedAt: writtenAt,
        });
    }
    return windows.length ? {writtenAt, windows} : null;
}

// Reset times from the two sources differ by a fraction of a second (the
// cache has microseconds, the status line whole seconds).
const SAME_WINDOW_MS = 60 * 1000;

/**
 * Whether `fresh` (the status line's) is the better reading of a window
 * than `old` (the cache's). Saved later is not enough: an idle session's
 * status line can save numbers it got hours ago. So a later window wins,
 * an earlier one loses, and within the same window the higher use wins
 * (use only grows until the window resets).
 */
export function isNewerReading(fresh, old) {
    if (fresh.resetsAt !== null && old.resetsAt !== null) {
        const d = fresh.resetsAt - old.resetsAt;
        if (Math.abs(d) >= SAME_WINDOW_MS)
            return d > 0;
        if (fresh.percent !== old.percent)
            return fresh.percent > old.percent;
    }
    return fresh.fetchedAt > old.fetchedAt;
}

/**
 * Claude Code's cached usage with the status line's newer Session and
 * Weekly in place of older ones (isNewerReading). Rows only the cache has
 * (per model, credits) keep their own, older `fetchedAt`.
 *
 * @param {?object} usage from usageFromConfig
 * @param {?object} status from statusLineFromFile
 * @returns {?object} {fetchedAt (the newest reading), windows}
 */
export function mergeStatusLine(usage, status) {
    if (!status)
        return usage;
    const windows = (usage?.windows ?? []).map(w => ({...w}));
    for (const fresh of status.windows) {
        const i = windows.findIndex(w => w.id === fresh.id);
        if (i < 0)
            windows.push(fresh);
        else if (isNewerReading(fresh, windows[i]))
            windows[i] = fresh;
    }
    return {
        fetchedAt: Math.max(...windows.map(w => w.fetchedAt)),
        windows: sorted(windows),
    };
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

// {utilization, resets_at, limit_dollars, used_dollars, remaining_dollars,
//  locked_reason}. Null limits mean the account has no credits.
function fromCredits(entry) {
    if (!isObject(entry) || !isMoney(entry.limit_dollars) || entry.limit_dollars <= 0 ||
        !isMoney(entry.used_dollars))
        return null;
    const limit = entry.limit_dollars;
    const used = entry.used_dollars;
    const remaining = isMoney(entry.remaining_dollars)
        ? entry.remaining_dollars : Math.max(0, limit - used);
    const locked = typeof entry.locked_reason === 'string' && entry.locked_reason !== '';
    return {
        id: CREDITS,
        kind: CREDITS,
        model: null,
        percent: isPercent(entry.utilization) ? entry.utilization : used / limit * 100,
        resetsAt: parseTime(entry.resets_at),
        severity: locked ? 'locked' : null,
        limit,
        used,
        remaining,
    };
}

const isMoney = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

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
