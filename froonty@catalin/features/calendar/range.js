// SPDX-License-Identifier: GPL-3.0-or-later
// Calendar tab: date math (docs/features/calendar.md §B). Pure: GLib only,
// no Shell, so it runs in plain-gjs unit tests.
//
// A date is a plain {y, m, d} (month 1-12). Days are counted on the
// calendar (in UTC, where every day is 86400 s), and a day's bounds are
// its local midnights in an explicit GLib.TimeZone, so a day across a
// daylight-saving change is 23 or 25 hours long. Never "+ 86400".
//
// Weekdays are numbered as JavaScript and GNOME's calendar.js do:
// 0 = Sunday ... 6 = Saturday.

import GLib from 'gi://GLib';

export const GRANULARITIES = ['day', 'week', 'month'];
/** Days in the month grid: always six weeks, as GNOME's own calendar. */
export const GRID_DAYS = 42;

const utc = date => GLib.DateTime.new_utc(date.y, date.m, date.d, 0, 0, 0);
const fromUtc = time => ({y: time.get_year(), m: time.get_month(), d: time.get_day_of_month()});

/** The date `days` after `date` (negative: before). */
export function addDays(date, days) {
    return fromUtc(utc(date).add_days(days));
}

/** The weekday of a date, 0 = Sunday ... 6 = Saturday. */
export function dayOfWeek(date) {
    return utc(date).get_day_of_week() % 7;
}

/** 'YYYY-MM-DD', which also sorts and compares as dates do. */
export function dateKey(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${String(date.y).padStart(4, '0')}-${pad(date.m)}-${pad(date.d)}`;
}

export function parseDateKey(key) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key ?? '');
    return match ? {y: Number(match[1]), m: Number(match[2]), d: Number(match[3])} : null;
}

export const sameDate = (a, b) => a.y === b.y && a.m === b.m && a.d === b.d;

/** Local midnight at the start of `date`, in seconds since the epoch. */
export function midnight(date, tz) {
    return GLib.DateTime.new(tz, date.y, date.m, date.d, 0, 0, 0).to_unix();
}

/** The local date of a moment (seconds since the epoch). */
export function dateOf(epoch, tz) {
    const time = GLib.DateTime.new_from_unix_utc(Math.floor(epoch)).to_timezone(tz);
    return {y: time.get_year(), m: time.get_month(), d: time.get_day_of_month()};
}

export function daysInMonth(y, m) {
    return GLib.Date.get_days_in_month(m, y);
}

/** The first day of the month `delta` months after {y, m}. */
export function addMonths({y, m}, delta) {
    const index = y * 12 + (m - 1) + delta;
    return {y: Math.floor(index / 12), m: index % 12 + 1};
}

/**
 * The same day of the month `delta` months on, clamped to the end of the
 * shorter month (GNOME's calendar: 31 Jan + 1 month = 28 or 29 Feb).
 */
export function shiftMonth(date, delta) {
    const {y, m} = addMonths(date, delta);
    return {y, m, d: Math.min(date.d, daysInMonth(y, m))};
}

/**
 * The 42 days of the month grid, by GNOME's padding rule
 * (ui/calendar.js _rebuildCalendar): a month that begins on the week's
 * first day is padded with a whole week before it, so the grid is
 * always six weeks and starts before the 1st.
 *
 * @param {number} y
 * @param {number} m 1-12
 * @param {number} weekStart 0 = Sunday ... 6 = Saturday
 * @param {GLib.TimeZone} tz
 * @returns {{days: object[], start: number, end: number}} dates, and the
 *   grid's bounds (local midnights, end exclusive)
 */
export function gridRange(y, m, weekStart, tz) {
    const first = {y, m, d: 1};
    const daysToWeekStart = (7 + dayOfWeek(first) - weekStart) % 7;
    const padding = daysToWeekStart === 0 ? 7 : 0;
    const begin = addDays(first, -(padding + daysToWeekStart));
    const days = [];
    for (let i = 0; i < GRID_DAYS; i++)
        days.push(addDays(begin, i));
    return {days, start: midnight(begin, tz), end: midnight(addDays(begin, GRID_DAYS), tz)};
}

/**
 * The span the agenda shows for a selected date: that day, its week or
 * its month.
 *
 * @returns {{days: object[], start: number, end: number}} end exclusive
 */
export function span(selected, granularity, weekStart, tz) {
    let first, count;
    if (granularity === 'month') {
        first = {y: selected.y, m: selected.m, d: 1};
        count = daysInMonth(selected.y, selected.m);
    } else if (granularity === 'week') {
        first = addDays(selected, -((7 + dayOfWeek(selected) - weekStart) % 7));
        count = 7;
    } else {
        first = selected;
        count = 1;
    }
    const days = [];
    for (let i = 0; i < count; i++)
        days.push(addDays(first, i));
    return {days, start: midnight(first, tz), end: midnight(addDays(first, count), tz)};
}

/** The ISO 8601 week number of a date (strftime's %V). */
export function isoWeek(date) {
    return utc(date).get_week_of_year();
}

/**
 * The grid's days in rows of seven, each with its ISO week number: the
 * week of the row's Thursday, as GNOME's grid labels it.
 */
export function weeksOf(days) {
    const rows = [];
    for (let i = 0; i < days.length; i += 7) {
        const week = days.slice(i, i + 7);
        const thursday = week.find(date => dayOfWeek(date) === 4) ?? week[0];
        rows.push({week: isoWeek(thursday), days: week});
    }
    return rows;
}

/**
 * Whether a weekday is a day off. `noWork` is GNOME's translatable
 * 'calendar-no-work' string: the digits of the days off, 0 = Sunday
 * ("06": Saturday and Sunday). Anything else falls back to "06".
 */
export function isWeekend(dow, noWork) {
    const days = /^[0-6]+$/.test(noWork ?? '') ? noWork : '06';
    return days.includes(String(dow));
}

/** An epoch as an EDS s-expression time: 'YYYYMMDDTHHMMSSZ'. */
export function sexpTime(epoch) {
    return GLib.DateTime.new_from_unix_utc(Math.floor(epoch)).format('%Y%m%dT%H%M%SZ');
}

/** Whether {y, m, d} is a real date with integer fields. */
export function isDate(date) {
    return Boolean(date) && [date.y, date.m, date.d].every(Number.isInteger) &&
        date.y >= 1 && date.y <= 9999 && date.m >= 1 && date.m <= 12 &&
        date.d >= 1 && date.d <= daysInMonth(date.y, date.m);
}
