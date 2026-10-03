// SPDX-License-Identifier: GPL-3.0-or-later
// Calendar tab: the events the views delivered, and what the grid and
// the agenda show of them (docs/features/calendar.md §B.4). Pure: GLib
// date math only (range.js), no EDS and no Shell.
//
// An item is one EDS component, already expanded into its occurrences in
// the views' range (eds.js):
//
//   {key, uid, rid, title, location, cancelled, occurrences}
//   key  `${uid}\n${recurrence id or ''}`: a series' master has an empty
//        recurrence id, a detached (moved or changed) occurrence its own
//   rid  the detached occurrence's RECURRENCE-ID in seconds, or null
//   occurrence {allDay: false, start, end, rid} in seconds, or
//              {allDay: true, startDate, endDate, rid} as 'YYYY-MM-DD',
//              endDate exclusive; rid: the start the series gives it
//
// A detached occurrence replaces the one its series would have at the
// same time: the master's occurrence whose rid equals the detached
// item's rid is left out, whichever arrived first.

import {addDays, dateKey, dateOf, midnight, parseDateKey} from './range.js';

/** The most event cards the agenda shows for one span. */
export const MAX_CARDS = 200;
/** Calendar colours per day in the month grid. */
export const MAX_DOTS = 3;

const ALL_DAY_KINDS = new Set(['all-day', 'middle']);

/** Every calendar's items, by calendar id and then by item key. */
export class EventStore {
    constructor() {
        this._calendars = new Map();
    }

    _items(calendarUid) {
        let items = this._calendars.get(calendarUid);
        if (!items) {
            items = new Map();
            this._calendars.set(calendarUid, items);
        }
        return items;
    }

    /** Adds or replaces items (by key). */
    put(calendarUid, items) {
        const map = this._items(calendarUid);
        for (const item of items)
            map.set(item.key, item);
    }

    /**
     * Removes items by key. A key with an empty recurrence id (a whole
     * series) removes every item of that uid, its detached occurrences
     * too, as GNOME's own event source does.
     *
     * @returns {string[]} the keys removed
     */
    removeKeys(calendarUid, keys) {
        const map = this._calendars.get(calendarUid);
        const removed = [];
        if (!map)
            return removed;
        for (const key of keys) {
            if (key.endsWith('\n')) {
                for (const existing of [...map.keys()]) {
                    if (existing.startsWith(key)) {
                        map.delete(existing);
                        removed.push(existing);
                    }
                }
            } else if (map.delete(key)) {
                removed.push(key);
            }
        }
        return removed;
    }

    /**
     * Every moved or changed occurrence of the series `uid`: these items,
     * and no other (the ones not listed are gone).
     *
     * @returns {string[]} the keys of the ones dropped
     */
    setDetached(calendarUid, uid, items) {
        const map = this._items(calendarUid);
        const keep = new Set(items.map(item => item.key));
        const dropped = [];
        for (const [key, item] of map) {
            if (item.uid === uid && item.rid !== null && item.rid !== undefined && !keep.has(key)) {
                map.delete(key);
                dropped.push(key);
            }
        }
        this.put(calendarUid, items);
        return dropped;
    }

    /** Drops the calendar's items whose keys are not in `keys`. */
    retain(calendarUid, keys) {
        const map = this._calendars.get(calendarUid);
        for (const key of [...map?.keys() ?? []]) {
            if (!keys.has(key))
                map.delete(key);
        }
    }

    dropCalendar(calendarUid) {
        this._calendars.delete(calendarUid);
    }

    size(calendarUid) {
        return this._calendars.get(calendarUid)?.size ?? 0;
    }

    /** Every item of a calendar (for tests). */
    items(calendarUid) {
        return [...this._calendars.get(calendarUid)?.values() ?? []];
    }

    /**
     * The occurrences of the given calendars, a detached occurrence
     * replacing its series' own.
     *
     * @param {string[]} calendarUids
     * @returns {{calendarUid: string, item: object, occurrence: object}[]}
     */
    occurrences(calendarUids) {
        const out = [];
        for (const calendarUid of calendarUids) {
            const items = this._calendars.get(calendarUid);
            if (!items)
                continue;
            const detached = new Map();
            for (const item of items.values()) {
                if (item.rid === null || item.rid === undefined)
                    continue;
                if (!detached.has(item.uid))
                    detached.set(item.uid, new Set());
                detached.get(item.uid).add(item.rid);
            }
            for (const item of items.values()) {
                const replaced = item.rid === null || item.rid === undefined
                    ? detached.get(item.uid) : null;
                for (const occurrence of item.occurrences) {
                    if (replaced?.has(occurrence.rid))
                        continue;
                    out.push({calendarUid, item, occurrence});
                }
            }
        }
        return out;
    }
}

/**
 * An occurrence's bounds in seconds; an all-day one from local midnight
 * to local midnight in `tz`.
 */
export function bounds(occurrence, tz) {
    if (!occurrence.allDay)
        return {start: occurrence.start, end: Math.max(occurrence.start, occurrence.end)};
    const first = parseDateKey(occurrence.startDate);
    let last = parseDateKey(occurrence.endDate);
    if (!last || dateKey(last) <= dateKey(first))
        last = addDays(first, 1);
    return {start: midnight(first, tz), end: midnight(last, tz)};
}

/**
 * Whether an event overlaps an interval: GNOME's rule (ui/calendar.js
 * _eventOverlapsInterval). A zero-length event at the interval's start
 * belongs to it; an event ending exactly at the start does not.
 */
export function overlaps(start, end, from, to) {
    if (start >= from && end < to)
        return true;
    if (end <= from || to <= start)
        return false;
    return true;
}

/**
 * How an occurrence shows on a day [from, to):
 * 'all-day' (a date, or exactly that day's midnight to midnight),
 * 'middle' (it covers the whole day, started before or ends after),
 * 'timed' (starts and ends that day), 'starts' (goes on past midnight)
 * or 'ends' (started on an earlier day).
 */
export function dayKind(occurrence, start, end, from, to) {
    if (occurrence.allDay || (start === from && end === to))
        return 'all-day';
    if (start <= from && end >= to)
        return 'middle';
    if (start < from)
        return 'ends';
    if (end > to)
        return 'starts';
    return 'timed';
}

// The local dates an occurrence is on: from its start's date to the date
// of its last second (a zero-length one: its start's date).
function datesOf(start, end, tz) {
    return [dateOf(start, tz), dateOf(Math.max(start, end - 1), tz)];
}

function compareEntries(a, b) {
    const allDayA = ALL_DAY_KINDS.has(a.kind) ? 0 : 1;
    const allDayB = ALL_DAY_KINDS.has(b.kind) ? 0 : 1;
    return allDayA - allDayB || a.start - b.start || a.end - b.end ||
        (a.item.title ?? '').localeCompare(b.item.title ?? '') ||
        a.order - b.order;
}

/**
 * 'past' (ended), 'now' (a timed event going on), 'next' (the one timed
 * event starting soonest after now, see nextAfter), or null. All-day
 * events are never now or next; cancelled ones never either.
 */
export function timeState(entry, now, next = null) {
    if (entry.end <= now)
        return 'past';
    if (entry.occurrence.allDay || entry.item.cancelled)
        return null;
    if (entry.start <= now && now < entry.end)
        return 'now';
    if (next && entry.item === next.item && entry.occurrence === next.occurrence)
        return 'next';
    return null;
}

/**
 * The timed, not cancelled occurrence that starts soonest after `now`
 * among all of them, wherever it is: {item, occurrence, start} or null.
 */
export function nextAfter(occurrences, now) {
    let next = null;
    for (const {item, occurrence} of occurrences) {
        if (occurrence.allDay || item.cancelled || occurrence.start <= now)
            continue;
        if (!next || occurrence.start < next.start)
            next = {item, occurrence, start: occurrence.start};
    }
    return next;
}

/**
 * The agenda for a span: its days, each with its entries sorted (all-day
 * first, then by start, end and title), at most `cap` entries in all.
 *
 * @param {object[]} occurrences EventStore.occurrences()
 * @param {object[]} days the span's dates (range.js span().days)
 * @param {GLib.TimeZone} tz
 * @param {number} now seconds
 * @param {object} [options]
 * @param {Map<string, number>} [options.order] calendar id → position
 * @param {number} [options.cap]
 * @param {?object} [options.next] the occurrence to mark "Next"; by
 *   default nextAfter(occurrences, now), which is only right when
 *   `occurrences` holds every event from now on to it (the service passes
 *   null when it does not)
 * @returns {{days: object[], truncated: number, next: ?object}}
 */
export function agendaDays(occurrences, days, tz, now, {order = new Map(), cap = MAX_CARDS, next} = {}) {
    const result = days.map(date => ({
        date,
        start: midnight(date, tz),
        end: midnight(addDays(date, 1), tz),
        entries: [],
    }));
    if (result.length === 0)
        return {days: result, truncated: 0, next: null};
    const spanStart = result[0].start;
    const spanEnd = result.at(-1).end;
    // Not the first one in the span: one before it, outside, is next.
    if (next === undefined)
        next = nextAfter(occurrences, now);

    for (const {calendarUid, item, occurrence} of occurrences) {
        const {start, end} = bounds(occurrence, tz);
        if (!overlaps(start, end, spanStart, spanEnd))
            continue;
        const position = order.get(calendarUid) ?? Number.MAX_SAFE_INTEGER;
        for (const day of result) {
            if (!overlaps(start, end, day.start, day.end))
                continue;
            day.entries.push({
                calendarUid, item, occurrence, start, end, order: position,
                kind: dayKind(occurrence, start, end, day.start, day.end),
            });
        }
    }

    let shown = 0;
    let truncated = 0;
    for (const day of result) {
        day.entries.sort(compareEntries);
        const room = Math.max(0, cap - shown);
        if (day.entries.length > room) {
            truncated += day.entries.length - room;
            day.entries = day.entries.slice(0, room);
        }
        shown += day.entries.length;
        for (const entry of day.entries)
            entry.state = timeState(entry, now, next);
    }
    return {days: result, truncated, next};
}

/**
 * Per local date: how many occurrences, and up to MAX_DOTS calendar ids
 * in calendar order (the grid's dots).
 *
 * @param {object[]} occurrences EventStore.occurrences()
 * @param {object[]} dates the grid's dates
 * @param {GLib.TimeZone} tz
 * @param {Map<string, number>} order calendar id → position
 * @returns {Map<string, {count: number, calendars: string[]}>} by dateKey
 */
export function dayMarks(occurrences, dates, tz, order = new Map()) {
    const marks = new Map(dates.map(date => [dateKey(date), {count: 0, calendars: new Set()}]));
    if (dates.length === 0)
        return new Map();
    const firstKey = dateKey(dates[0]);
    const lastKey = dateKey(dates.at(-1));
    for (const {calendarUid, occurrence} of occurrences) {
        const {start, end} = bounds(occurrence, tz);
        const [first, last] = datesOf(start, end, tz);
        let date = dateKey(first) < firstKey ? dates[0] : first;
        const lastShown = dateKey(last) > lastKey ? lastKey : dateKey(last);
        for (let key = dateKey(date); key <= lastShown; date = addDays(date, 1), key = dateKey(date)) {
            const mark = marks.get(key);
            if (!mark)
                continue;
            mark.count++;
            mark.calendars.add(calendarUid);
        }
    }
    const rank = uid => order.get(uid) ?? Number.MAX_SAFE_INTEGER;
    const out = new Map();
    for (const [key, {count, calendars}] of marks) {
        out.set(key, {
            count,
            calendars: [...calendars].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
                .slice(0, MAX_DOTS),
        });
    }
    return out;
}
