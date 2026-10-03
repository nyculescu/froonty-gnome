// SPDX-License-Identifier: GPL-3.0-or-later
// The Break tab's ledger (docs/features/break.md): when the user was at the
// computer or away, and what that adds up to today. Pure functions over a
// plain state object, which store.js saves; no GNOME, no St.
//
// "Present" time is accounted up to a moment; an "away" is a stretch with no
// input (an idle period of AWAY_MIN_SECONDS or more, a screen lock, a
// suspend). Times are wall-clock milliseconds; totals are seconds.

import GLib from 'gi://GLib';

// A pause shorter than this is reading, not being away.
export const AWAY_MIN_SECONDS = 120;
// Away this long: the posture is "sitting" again on return.
export const POSTURE_RESET_AWAY_SECONDS = 3600;
// A WallClock tick whose wall-clock step beats the monotonic one by this
// much was a suspend.
export const SUSPEND_DRIFT_SECONDS = 60;

export const BREAK_TYPES = ['eyesight', 'movement'];

const two = n => String(n).padStart(2, '0');

/** "YYYY-MM-DD" of `ms` in the local time zone. */
export function dayKey(ms) {
    const t = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
    return `${t.get_year()}-${two(t.get_month())}-${two(t.get_day_of_month())}`;
}

/** The first local midnight after `ms`, in ms. */
export function nextMidnight(ms) {
    const t = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
    const midnight = GLib.DateTime.new_local(t.get_year(), t.get_month(), t.get_day_of_month(), 0, 0, 0)
        .add_days(1);
    return midnight.to_unix() * 1000;
}

export const LOCAL_DAYS = {dayKey, nextMidnight};

export function emptyDay(day) {
    const counts = () => ({taken: 0, delayed: 0, skipped: 0});
    return {
        day,
        activeSeconds: 0,
        longestStretchSeconds: 0,
        eyesight: counts(),
        movement: counts(),
        longRests: 0,
        standingSeconds: 0,
        targetSeconds: 0,
        minimumOnly: false,
    };
}

/** Whether a day has anything worth a history row. */
export function hasActivity(day) {
    return day.activeSeconds >= 1 || day.longRests > 0 ||
        BREAK_TYPES.some(t => day[t].taken + day[t].delayed + day[t].skipped > 0);
}

/** A fresh state at `now` (first start, or an unreadable file). */
export function freshState(now, days = LOCAL_DAYS) {
    const counters = () => ({consecutive: 0, delaysInRow: 0, owed: 0});
    return {
        ledger: {
            accountedUntil: now,
            stretchStart: now,
            screenSinceLongRest: 0,
            lastLongRestEnd: null,
            // Set while an idle period is open (Mutter's idle watch fired
            // and no input since); saved, so a lock that follows it is
            // counted from when the user left.
            idleStart: null,
        },
        breaks: {eyesight: counters(), movement: counters()},
        posture: {mode: 'sitting', modeActiveSeconds: 0, notNowAt: null},
        plan: {lastStepDay: null, minimumDay: null},
        exercise: {next: 0},
        today: emptyDay(days.dayKey(now)),
    };
}

// Moves `today` on to the day of `t`, collecting the day it closes.
function rollTo(s, t, days, closed) {
    const key = days.dayKey(t);
    if (key === s.today.day)
        return;
    closed.push(s.today);
    s.today = emptyDay(key);
}

/**
 * Accounts present time from accountedUntil to `t`: today's active time,
 * screen time since the last long rest, the posture clock, and standing
 * time while standing. Local midnights split it.
 *
 * @returns {object[]} the days it closed (oldest first)
 */
export function addPresent(s, t, days = LOCAL_DAYS) {
    const closed = [];
    const l = s.ledger;
    let a = l.accountedUntil ?? t;
    while (a < t) {
        rollTo(s, a, days, closed);
        const b = Math.min(t, days.nextMidnight(a));
        const seconds = (b - a) / 1000;
        s.today.activeSeconds += seconds;
        l.screenSinceLongRest += seconds;
        s.posture.modeActiveSeconds += seconds;
        if (s.posture.mode === 'standing')
            s.today.standingSeconds += seconds;
        s.today.longestStretchSeconds = Math.max(s.today.longestStretchSeconds,
            (b - l.stretchStart) / 1000);
        a = b;
    }
    rollTo(s, t, days, closed);
    l.accountedUntil = Math.max(l.accountedUntil ?? t, t);
    return closed;
}

/**
 * An away from `from` to `to` (present time before it is accounted first).
 *
 * @param {object} rules
 * @param {number} rules.movementSeconds GNOME's movement break length (300
 *   when movement breaks are off): an away this long ends a stretch
 * @param {number} rules.longRestSeconds an away this long is a long rest
 * @returns {object[]} the days it closed (oldest first)
 */
export function addAway(s, from, to, {movementSeconds, longRestSeconds}, days = LOCAL_DAYS) {
    const l = s.ledger;
    const closed = from > (l.accountedUntil ?? from) ? addPresent(s, from, days) : [];
    const start = Math.min(from, to);
    rollTo(s, to, days, closed);
    const seconds = (to - start) / 1000;
    if (seconds >= longRestSeconds) {
        // A night (or a weekend) away is not a rest taken during the day.
        if (days.dayKey(start) === s.today.day)
            s.today.longRests++;
        l.screenSinceLongRest = 0;
        l.lastLongRestEnd = to;
    }
    if (seconds >= movementSeconds)
        l.stretchStart = to;
    if (seconds >= AWAY_MIN_SECONDS) {
        s.posture.modeActiveSeconds = 0;
        s.posture.notNowAt = null;
    }
    if (seconds >= POSTURE_RESET_AWAY_SECONDS)
        s.posture.mode = 'sitting';
    l.accountedUntil = Math.max(l.accountedUntil ?? to, to);
    return closed;
}

/**
 * The away a WallClock tick reveals, from the wall-clock and monotonic
 * steps since the previous one: a suspend without a lock.
 *
 * @returns {?number} the suspended seconds, or null
 */
export function suspendDrift(wallStepMs, monoStepUs) {
    const drift = (wallStepMs - monoStepUs / 1000) / 1000;
    return drift >= SUSPEND_DRIFT_SECONDS ? drift : null;
}

/** Adds a closed day to the history (newest first), kept to `keep` days. */
export function pushHistory(history, day, keep) {
    if (!hasActivity(day))
        return history;
    return [day, ...history.filter(d => d.day !== day.day)].slice(0, keep);
}
