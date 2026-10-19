// SPDX-License-Identifier: GPL-3.0-or-later
// Pausing breaks and working hours (docs/features/break.md, "Pause and
// working hours"), and holding GNOME's dimming and locking while busy
// ("Busy"). GNOME's engine has no pause, only its selected breaks: while
// paused, Froonty turns them off and gives them back at the end, exactly
// as they were (GNOME then starts each break's interval afresh). While
// busy (break-busy-hold-gnome), it turns each type's fade-screen and
// lock-screen off, and gives them back when that ends.
//
// What Froonty changed is recorded in break-gnome-saved (the record the
// notification takeover uses, its own entries 'breaks/selected' and
// 'hold/<type>/<key>'), first, so that whatever happens next a restore
// can undo it:
//   - the service ends a pause or a hold at its time;
//   - turning the Break tab or Froonty off ends both (PauseKeeper below),
//     but a screen lock does not (DESIGN.md §2, principle 5);
//   - a value the user changed meanwhile is theirs: left alone.
// Pure rules first; GLib for local days only. No St.

import GLib from 'gi://GLib';

import {parseSaved} from './gnomeSettings.js';

const SAVED_KEY = 'break-gnome-saved';
const RECORD = 'breaks/selected';
const SELECTED = 'selected-breaks';
// GLib.DateTime.get_day_of_week(): 1 Monday … 7 Sunday.
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
// "Until tomorrow" without working hours.
const MORNING_MINUTES = 6 * 60;
// Looking for the next working hours: a week ahead is enough.
const SEARCH_DAYS = 8;

const local = ms => GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
const at = (t, minutes) => GLib.DateTime.new_local(t.get_year(), t.get_month(), t.get_day_of_month(),
    Math.floor(minutes / 60) % 24, minutes % 60, 0).add_days(minutes >= 1440 ? 1 : 0);

/**
 * Working hours at `nowMs`.
 *
 * @param {{enabled: boolean, days: string[], start: number, end: number}} h
 *   minutes after local midnight
 * @returns {{inside: boolean, nextStart: ?number, nextEnd: ?number}} s
 */
export function workHours(h, nowMs) {
    if (!h.enabled || !h.days.length || h.end <= h.start)
        return {inside: true, nextStart: null, nextEnd: null};
    const now = nowMs / 1000;
    const today = local(nowMs);
    let inside = false;
    let nextStart = null;
    let nextEnd = null;
    for (let d = 0; d < SEARCH_DAYS && (nextStart === null || nextEnd === null); d++) {
        const day = today.add_days(d);
        if (!h.days.includes(WEEKDAYS[day.get_day_of_week() - 1]))
            continue;
        const start = at(day, h.start).to_unix();
        const end = at(day, h.end).to_unix();
        if (start <= now && now < end) {
            inside = true;
            nextEnd ??= end;
        } else if (start > now) {
            nextStart ??= start;
            nextEnd ??= end;
        }
    }
    return {inside, nextStart, nextEnd};
}

/**
 * Whether breaks are paused at `nowMs`, why, and until when.
 *
 * @param {object} p
 * @param {number} p.pausedUntil break-paused-until (s; 0: none)
 * @param {object} p.hours workHours()'s settings
 * @param {number} p.overrideUntil break-work-override-until (s; 0: none)
 * @returns {{paused: boolean, reason: ?string, until: ?number, hours: object}}
 */
export function pauseState({pausedUntil, hours, overrideUntil}, nowMs) {
    const now = nowMs / 1000;
    const w = workHours(hours, nowMs);
    if (pausedUntil > now)
        return {paused: true, reason: 'manual', until: pausedUntil, hours: w};
    if (!w.inside && !(overrideUntil > now))
        return {paused: true, reason: 'hours', until: w.nextStart, hours: w};
    return {paused: false, reason: null, until: null, hours: w};
}

/** "Until tomorrow": the next working hours, or tomorrow 06:00 without them (s). */
export function untilTomorrow(hours, nowMs) {
    const w = workHours(hours, nowMs);
    if (hours.enabled && w.nextStart !== null) {
        // Tomorrow's start, not later today's.
        const tomorrow = at(local(nowMs).add_days(1), 0).to_unix();
        const later = workHours(hours, tomorrow * 1000);
        return later.inside ? tomorrow : later.nextStart ?? w.nextStart;
    }
    return at(local(nowMs).add_days(1), MORNING_MINUTES).to_unix();
}

/** The working-hours settings from Froonty's settings. */
export function hoursFrom(settings) {
    return {
        enabled: settings.get_boolean('break-work-hours'),
        days: settings.get_strv('break-work-days').filter(d => WEEKDAYS.includes(d)),
        start: settings.get_int('break-work-start'),
        end: settings.get_int('break-work-end'),
    };
}

// ------------------------------------------------------------ GNOME

const HOLD_KEYS = ['fade-screen', 'lock-screen'];
const holdId = (type, key) => `hold/${type}/${key}`;

// While Froonty writes GNOME's settings: GSettings and the takeover react
// at once, and must not take it for the user's change.
let writing = false;
// After the Break tab or Froonty is turned off: no pause is applied again
// until the service starts anew (it may run on for a moment).
let suspended = false;

/** Whether the GNOME change being reported is Froonty's own. */
export const pauseWriting = () => writing;

/** The service starts: pauses may be applied again. */
export const allowPauses = () => {
    suspended = false;
};

function writeGnome(fn) {
    writing = true;
    try {
        fn();
    } finally {
        writing = false;
    }
}

function readRecord(settings) {
    return parseSaved(settings.get_string(SAVED_KEY));
}

function writeRecord(settings, record) {
    const text = Object.keys(record).length ? JSON.stringify(record) : '';
    if (settings.get_string(SAVED_KEY) !== text)
        settings.set_string(SAVED_KEY, text);
}

// Our entries go; the takeover's (written meanwhile, it follows GNOME's
// selected breaks) stay: the record is read again.
function forget(settings, ids) {
    const fresh = readRecord(settings);
    for (const id of ids)
        delete fresh[id];
    writeRecord(settings, fresh);
}

// A recorded value of `type` ('as', 'b'); null for none or a damaged
// record (GNOME's default is restored then).
function savedValue(text, type) {
    if (text === null || text === undefined)
        return null;
    try {
        return GLib.Variant.parse(new GLib.VariantType(type), text, null, null);
    } catch {
        return null;
    }
}

// Gives one recorded key back, unless the user changed it since.
function giveBack(s, key, saved, type) {
    if (!s?.is_writable(key) || s.get_value(key).print(true) !== saved.set)
        return false;
    const value = savedValue(saved.user, type);
    writeGnome(() => (value ? s.set_value(key, value) : s.reset(key)));
    return true;
}

/** Whether Froonty has GNOME's breaks turned off for a pause now. */
export function pauseApplied(settings) {
    return Boolean(readRecord(settings)[RECORD]);
}

/**
 * Turns GNOME's selected breaks off for a pause (once; recorded first).
 *
 * @param {Gio.Settings} settings Froonty's
 * @param {GnomeBreakSettings} gnome
 * @returns {boolean} false when not allowed now (the tab is being turned off)
 */
export function applyPause(settings, gnome) {
    if (suspended)
        return false;
    const s = gnome.breaks;
    if (!s || !gnome.selectedWritable())
        return true;
    const record = readRecord(settings);
    if (record[RECORD] || !gnome.selected().length)
        return true;
    const empty = new GLib.Variant('as', []);
    record[RECORD] = {user: s.get_user_value(SELECTED)?.print(true) ?? null, set: empty.print(true)};
    writeRecord(settings, record);
    writeGnome(() => s.set_value(SELECTED, empty));
    return true;
}

/**
 * Gives GNOME's selected breaks back, unless the user changed them since.
 *
 * @returns {boolean} whether the user had changed them (the pause is theirs to end)
 */
export function restorePause(settings, gnome) {
    const saved = readRecord(settings)[RECORD];
    if (!saved)
        return false;
    const changed = gnome.breaks?.is_writable(SELECTED) && !giveBack(gnome.breaks, SELECTED, saved, 'as');
    forget(settings, [RECORD]);
    return Boolean(changed);
}

/** Whether Froonty has GNOME's dimming or locking off while busy. */
export function holdApplied(settings) {
    return Object.keys(readRecord(settings)).some(id => id.startsWith('hold/'));
}

/**
 * Busy: each type's fade-screen and lock-screen off, those that are on
 * (once each; recorded first).
 */
export function applyHold(settings, gnome) {
    if (suspended)
        return;
    const record = readRecord(settings);
    const writes = [];
    for (const type of ['eyesight', 'movement']) {
        const s = gnome.typeSettings(type);
        for (const key of HOLD_KEYS) {
            const id = holdId(type, key);
            if (!s?.is_writable(key) || record[id] || !s.get_boolean(key))
                continue;
            record[id] = {user: s.get_user_value(key)?.print(true) ?? null, set: 'false'};
            writes.push([s, key]);
        }
    }
    if (!writes.length)
        return;
    writeRecord(settings, record);
    writeGnome(() => writes.forEach(([s, key]) => s.set_boolean(key, false)));
}

/** Gives GNOME's dimming and locking back (a key the user changed stays). */
export function restoreHold(settings, gnome) {
    const record = readRecord(settings);
    const ids = [];
    for (const type of ['eyesight', 'movement']) {
        for (const key of HOLD_KEYS) {
            const id = holdId(type, key);
            if (!record[id])
                continue;
            giveBack(gnome.typeSettings(type), key, record[id], 'b');
            ids.push(id);
        }
    }
    if (ids.length)
        forget(settings, ids);
}

// Turning the tab or Froonty off: no pause applied again meanwhile, a
// manual pause is over, and GNOME's settings come back.
function endAll(settings, gnome) {
    suspended = true;
    if (settings.get_int64('break-paused-until') !== 0)
        settings.set_int64('break-paused-until', 0);
    restorePause(settings, gnome);
    restoreHold(settings, gnome);
}

/**
 * Ends a pause and a hold when the Break tab is turned off, and when
 * Froonty is (but not under the lock screen), like the notification
 * takeover. The service applies and ends them while it runs.
 */
export class PauseKeeper {
    /**
     * @param {Gio.Settings} settings Froonty's
     * @param {GnomeBreakSettings} gnome
     */
    constructor(settings, gnome) {
        this._settings = settings;
        this._gnome = gnome;
        this._id = settings.connect('changed::break-enabled', () => {
            if (!settings.get_boolean('break-enabled'))
                endAll(settings, gnome);
        });
    }

    destroy({restore}) {
        this._settings.disconnect(this._id);
        if (restore)
            endAll(this._settings, this._gnome);
    }
}
