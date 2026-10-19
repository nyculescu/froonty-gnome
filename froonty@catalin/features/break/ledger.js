// SPDX-License-Identifier: GPL-3.0-or-later
// The Break tab's ledger (docs/features/break.md): when the user was at the
// computer or away, and what that adds up to today. Pure functions over a
// plain state object, which store.js saves; no GNOME, no St.
//
// "Present" time is accounted up to a moment; an "away" is a stretch with no
// input (an idle period of AWAY_MIN_SECONDS or more, a screen lock, a
// suspend). Times are wall-clock milliseconds; totals are seconds.

import GLib from 'gi://GLib';

import {BREAK_TYPES} from '../../shell/breakEngine.js';

// A pause shorter than this is reading, not being away.
export const AWAY_MIN_SECONDS = 120;
// Away this long during the day: "Was that a workout?"
export const WORKOUT_ASK_SECONDS = 45 * 60;
const WORKOUT_ASK_MAX_SECONDS = 4 * 3600;
// Away this long: the posture is "sitting" again on return.
const POSTURE_RESET_AWAY_SECONDS = 3600;
// A WallClock tick whose wall-clock step beats the monotonic one by this
// much was a suspend.
const SUSPEND_DRIFT_SECONDS = 60;

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

/** The local hour (0-23) of `ms`. */
export function hourOf(ms) {
    return GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000)).get_hour();
}

/** The first local whole hour after `ms`, in ms. */
export function nextHour(ms) {
    const t = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
    return GLib.DateTime.new_local(t.get_year(), t.get_month(), t.get_day_of_month(), t.get_hour(), 0, 0)
        .add_hours(1).to_unix() * 1000;
}

export const LOCAL_DAYS = {dayKey, nextMidnight, hourOf, nextHour};

// Days without hour functions (the tests' fake days): hours from midnight.
const HOUR_MS = 3600000;
const dayStart = (days, ms) => days.nextMidnight(ms) - 24 * HOUR_MS;
const hourIn = (days, ms) => days.hourOf?.(ms) ??
    Math.min(23, Math.max(0, Math.floor((ms - dayStart(days, ms)) / HOUR_MS)));
const hourEnd = (days, ms) => days.nextHour?.(ms) ??
    Math.min(days.nextMidnight(ms), ms - ((ms - dayStart(days, ms)) % HOUR_MS) + HOUR_MS);

export const REASONS = ['meeting', 'deadline', 'flow', 'other'];

export function emptyDay(day) {
    // busy: credited by GNOME while you were busy (a call, a video).
    const counts = () => ({taken: 0, delayed: 0, skipped: 0, busy: 0});
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
        // Time at the computer without input because you were busy.
        busySeconds: 0,
        // Why you skipped or delayed (one tap, optional).
        reasons: Object.fromEntries(REASONS.map(r => [r, 0])),
        // Seconds at the computer in each local hour, and whether you
        // moved (were away AWAY_MIN_SECONDS or more) in it.
        hourActive: new Array(24).fill(0),
        hourMoved: new Array(24).fill(0),
        // Workouts you logged today (minutes in all) and when the last ended.
        workoutMinutes: 0,
        workoutEnd: null,
        // Garmin's activities today ({id, type, start, end, minutes}) and
        // intensity minutes ({moderate, vigorous}), with break-garmin on.
        garmin: [],
        garminIntensity: null,
    };
}

/** Whether a day has anything worth a history row. */
function hasActivity(day) {
    return day.activeSeconds >= 1 || day.longRests > 0 ||
        BREAK_TYPES.some(t => day[t].taken + day[t].delayed + day[t].skipped > 0);
}

/** A fresh state at `now` (first start, or an unreadable file). */
export function freshState(now, days = LOCAL_DAYS) {
    const counters = () => ({consecutive: 0, delaysInRow: 0, skipsInRow: 0, owed: 0});
    return {
        ledger: {
            accountedUntil: now,
            stretchStart: now,
            screenSinceLongRest: 0,
            // At the computer since you last moved (the move bar).
            screenSinceMove: 0,
            // Set while an idle period is open (Mutter's idle watch fired
            // and no input since); saved, so a lock that follows it is
            // counted from when the user left.
            idleStart: null,
        },
        breaks: {eyesight: counters(), movement: counters()},
        posture: {mode: 'sitting', modeActiveSeconds: 0},
        plan: {lastStepDay: null, minimumDay: null},
        // The next stretch, the moves shown lately (not repeated soon),
        // the next break idea.
        exercise: {next: 0, recent: [], idea: 0},
        // The last away long enough to ask whether it was a workout; null
        // once answered.
        lastLongAway: null,
        // The pause last applied ("manual:<until>", "hours:<start>"): once
        // each, so breaks turned back on meanwhile stay on.
        pauseHandled: null,
        // When Garmin was last asked, and its backoff (garminData.js).
        garmin: {lastTry: 0, lastSync: 0, nextTry: 0, error: null},
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
        const b = Math.min(t, days.nextMidnight(a), hourEnd(days, a));
        const seconds = (b - a) / 1000;
        s.today.activeSeconds += seconds;
        s.today.hourActive[hourIn(days, a)] += seconds;
        l.screenSinceLongRest += seconds;
        l.screenSinceMove += seconds;
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
    }
    if (seconds >= movementSeconds)
        l.stretchStart = to;
    if (seconds >= AWAY_MIN_SECONDS) {
        s.posture.modeActiveSeconds = 0;
        l.screenSinceMove = 0;
        markMoved(s, start, to, days);
    }
    // Long enough to have been a workout, not a night: the tab asks
    // (break-workout).
    if (seconds >= WORKOUT_ASK_SECONDS && seconds <= WORKOUT_ASK_MAX_SECONDS &&
        days.dayKey(start) === s.today.day)
        s.lastLongAway = {from: start, to};
    if (seconds >= POSTURE_RESET_AWAY_SECONDS)
        s.posture.mode = 'sitting';
    l.accountedUntil = Math.max(l.accountedUntil ?? to, to);
    return closed;
}

// Every hour of today an away of AWAY_MIN_SECONDS or more touched.
function markMoved(s, from, to, days) {
    for (let a = Math.max(from, to - 24 * HOUR_MS); a < to; a = hourEnd(days, a)) {
        if (days.dayKey(a) === s.today.day)
            s.today.hourMoved[hourIn(days, a)] = 1;
    }
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
