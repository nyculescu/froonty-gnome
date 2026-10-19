// SPDX-License-Identifier: GPL-3.0-or-later
// The Break tab's 14-week chart (docs/features/break.md), its pure part:
// which day goes in which cell, a day's value for a metric, its level, and
// the words for one day. No St and no Shell: gettext comes in as
// parameters, so plain gjs tests run it. chart.js draws it.
//
// Columns are weeks, oldest left, today's week last; rows are weekdays,
// Monday at the top, in local time. A day with no record, or without what
// the metric needs, has the value null (drawn as an empty outline).

import GLib from 'gi://GLib';

import {BREAK_TYPES} from '../../shell/breakEngine.js';

export const METRICS = ['kept', 'screen', 'stretch', 'standing', 'moves'];

// Shares, levelled at fixed steps (at least 25%, 50%, 75%); the other
// metrics are levelled by the quartiles of the days shown.
export const RATIO_METRICS = new Set(['kept', 'standing', 'moves']);
const RATIO_STEPS = [0.25, 0.5, 0.75];
// An hour with this much time at the computer is a desk hour ("moves").
export const DESK_HOUR_SECONDS = 1800;

const two = n => String(n).padStart(2, '0');
const keyOf = t => `${t.get_year()}-${two(t.get_month())}-${two(t.get_day_of_month())}`;

/** The local noon of a "YYYY-MM-DD" day (noon: adding days never meets a DST change). */
export function dayDate(key) {
    const [y, m, d] = key.split('-').map(Number);
    return GLib.DateTime.new_local(y, m, d, 12, 0, 0);
}

// Breaks taken, and taken + skipped + delayed, eyes and movement together
// (busy and held are not counted).
function keptCounts(record) {
    let taken = 0;
    let counted = 0;
    for (const type of BREAK_TYPES) {
        const c = record[type] ?? {};
        taken += c.taken ?? 0;
        counted += (c.taken ?? 0) + (c.skipped ?? 0) + (c.delayed ?? 0);
    }
    return {taken, counted};
}

// Desk hours, and those you moved in; null for a record from before
// hours were kept.
function moveCounts(record) {
    if (!Array.isArray(record.hourActive))
        return null;
    let desk = 0;
    let moved = 0;
    record.hourActive.forEach((seconds, hour) => {
        if (seconds < DESK_HOUR_SECONDS)
            return;
        desk++;
        if (record.hourMoved?.[hour] === 1)
            moved++;
    });
    return {desk, moved};
}

/** One day's value for `metric`: a number, or null when the day cannot say. */
export function dayValue(record, metric) {
    if (!METRICS.includes(metric))
        throw new Error(`unknown metric ${metric}`);
    if (!record)
        return null;
    switch (metric) {
    case 'kept': {
        const {taken, counted} = keptCounts(record);
        return counted ? taken / counted : null;
    }
    case 'screen':
        return record.activeSeconds ?? 0;
    case 'stretch':
        return record.longestStretchSeconds ?? 0;
    case 'standing':
        // A workout day's workout counts toward its target (plan.js met()).
        return record.targetSeconds > 0
            ? ((record.standingSeconds ?? 0) + (record.workoutCreditSeconds ?? 0)) / record.targetSeconds : null;
    default: {
        const hours = moveCounts(record);
        return hours?.desk ? hours.moved / hours.desk : null;
    }
    }
}

// Linear interpolation between the closest ranks of a sorted list.
function quantile(sorted, p) {
    const at = (sorted.length - 1) * p;
    const lo = Math.floor(at);
    const hi = Math.min(lo + 1, sorted.length - 1);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

// value → level: 0 for nothing (or no value), 1-4 by the metric's steps.
function leveller(metric, values) {
    if (RATIO_METRICS.has(metric))
        return v => (v > 0 ? 1 + RATIO_STEPS.filter(step => v >= step).length : 0);
    // As GitHub's calendar: quartiles of the days with something.
    const sorted = values.filter(v => v > 0).sort((a, b) => a - b);
    const steps = sorted.length ? [0.25, 0.5, 0.75].map(p => quantile(sorted, p)) : [];
    return v => (v > 0 ? 1 + steps.filter(step => v > step).length : 0);
}

/**
 * Pure: the cells for `metric` over `weeks` weeks ending with today's week.
 *
 * @param {object[]} history day records, newest first
 * @param {?object} today today's record (wins over a history record of the
 *   same day)
 * @param {string} metric one of METRICS
 * @returns {{cells: object[], max: ?number, metric: string}} cells in day
 *   order, each {day, col, row, value, level, inFuture}; `max` is the
 *   largest value shown, null without any
 */
export function chartCells(history, today, metric, {weeks = 14, todayKey = today?.day} = {}) {
    if (!METRICS.includes(metric))
        throw new Error(`unknown metric ${metric}`);
    const records = new Map();
    for (const record of history ?? []) {
        if (!records.has(record.day))
            records.set(record.day, record);
    }
    if (today)
        records.set(today.day, today);

    const now = dayDate(todayKey);
    // get_day_of_week: 1 Monday … 7 Sunday.
    const start = now.add_days(1 - now.get_day_of_week() - 7 * (weeks - 1));
    const cells = [];
    for (let i = 0; i < weeks * 7; i++) {
        const day = keyOf(start.add_days(i));
        const inFuture = day > todayKey;
        const value = inFuture ? null : dayValue(records.get(day), metric);
        cells.push({day, col: Math.floor(i / 7), row: i % 7, value, level: 0, inFuture});
    }
    const values = cells.map(c => c.value).filter(v => v !== null);
    const level = leveller(metric, values);
    for (const cell of cells)
        cell.level = cell.value === null ? 0 : level(cell.value);
    return {cells, max: values.length ? Math.max(...values) : null, metric};
}

/**
 * Pure: the text for one day and metric, e.g. "Thu 1 Oct: 6 of 9 breaks
 * taken (67%)", with the caller's gettext and words.js's duration().
 */
export function cellText(cell, record, metric, {_, ngettext, duration}) {
    const date = dayDate(cell.day).format('%a %-d %b');
    if (!record)
        return _('%s: nothing recorded').format(date);
    const percent = (part, whole) => Math.round(100 * part / whole);
    switch (metric) {
    case 'kept': {
        const {taken, counted} = keptCounts(record);
        if (!counted)
            return _('%s: no breaks taken, skipped or delayed').format(date);
        return ngettext('%s: %d of %d break taken (%d%%)', '%s: %d of %d breaks taken (%d%%)', counted)
            .format(date, taken, counted, percent(taken, counted));
    }
    case 'screen':
        return _('%s: %s at the computer').format(date, duration(record.activeSeconds ?? 0));
    case 'stretch':
        return _('%s: longest stretch %s').format(date, duration(record.longestStretchSeconds ?? 0));
    case 'standing': {
        const target = record.targetSeconds ?? 0;
        if (target <= 0)
            return _('%s: no standing target').format(date);
        const standing = (record.standingSeconds ?? 0) + (record.workoutCreditSeconds ?? 0);
        return _('%s: standing %s of %s (%d%%)').format(date, duration(standing), duration(target),
            percent(standing, target));
    }
    case 'moves': {
        const hours = moveCounts(record);
        if (!hours)
            return _('%s: hours not recorded').format(date);
        if (!hours.desk)
            return _('%s: no hour with 30 min at the computer').format(date);
        return ngettext('%s: moved in %d of %d hour at the computer (%d%%)',
            '%s: moved in %d of %d hours at the computer (%d%%)', hours.desk)
            .format(date, hours.moved, hours.desk, percent(hours.moved, hours.desk));
    }
    default:
        throw new Error(`unknown metric ${metric}`);
    }
}
