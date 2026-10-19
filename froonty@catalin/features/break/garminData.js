// SPDX-License-Identifier: GPL-3.0-or-later
// Garmin's activities in the Break tab's day (docs/features/break.md,
// "Garmin"): which count as a workout, how they merge with the ones
// logged by hand, and when Froonty may ask the helper again. Pure.
//
// The helper (garmin/helper.py) is asked only on events: when the service
// starts (a login, an unlock), when you come back from an away of 20 min
// or more, when the Break tab comes on screen, and when the setting is
// turned on; at most every 15 min (5 after an away), and after a failure
// not before its backoff ends (Garmin blocking the library: 6 h).

// An activity this long is a workout (the Break tab's rule; the helper
// drops shorter ones at 10 min).
export const WORKOUT_MIN_SECONDS = 20 * 60;
// Coming back from an away this long asks Garmin (a workout may be in).
export const RETURN_SECONDS = 20 * 60;
const MIN_GAP_MS = 15 * 60 * 1000;
const RETURN_GAP_MS = 5 * 60 * 1000;
const BACKOFF_MS = {
    blocked: 6 * 3600 * 1000,
    auth: 24 * 3600 * 1000,
    setup: 24 * 3600 * 1000,
    network: 15 * 60 * 1000,
    other: 3600 * 1000,
};

/** A fresh record of the readings (state.json's `garmin`). */
export const freshGarmin = () => ({lastTry: 0, lastSync: 0, nextTry: 0, error: null});

/**
 * Whether to ask the helper now.
 *
 * @param {object} g the readings' record
 * @param {number} now ms
 * @param {string} reason 'start' | 'return' | 'tab' | 'setting'
 */
export function shouldRead(g, now, reason) {
    if (reason === 'setting')
        return true;
    if (g.nextTry > now)
        return false;
    const gap = reason === 'return' ? RETURN_GAP_MS : MIN_GAP_MS;
    return now - g.lastTry >= gap;
}

/** The record after an answer of the helper's. */
export function afterRead(g, result, now) {
    if (result?.ok)
        return {lastTry: now, lastSync: now, nextTry: 0, error: null};
    const error = Object.hasOwn(BACKOFF_MS, result?.error) ? result.error : 'other';
    return {...g, lastTry: now, nextTry: now + BACKOFF_MS[error], error};
}

/**
 * Today's activities from an answer: only those that began today, with
 * their end; [] for anything it does not understand.
 *
 * @param {object} result the helper's answer
 * @param {string} day "YYYY-MM-DD"
 * @param {Function} dayKey ms → "YYYY-MM-DD" (local)
 */
export function todaysActivities(result, day, dayKey) {
    if (!result?.ok || !Array.isArray(result.activities))
        return [];
    return result.activities.filter(a =>
        typeof a?.id === 'string' && Number.isFinite(a.start) && Number.isFinite(a.seconds) && a.seconds > 0 &&
        dayKey(a.start) === day)
        .map(a => ({
            id: a.id,
            type: typeof a.type === 'string' ? a.type.slice(0, 40) : 'other',
            start: a.start,
            end: a.start + a.seconds * 1000,
            minutes: Math.round(a.seconds / 60),
        }));
}

/** Today's intensity minutes from an answer, or null. */
export function intensityOf(result) {
    const i = result?.ok ? result.intensity : null;
    if (!i || !Number.isFinite(i.moderate) || !Number.isFinite(i.vigorous))
        return null;
    return {moderate: Math.max(0, i.moderate), vigorous: Math.max(0, i.vigorous)};
}

/** The day's workouts: those logged by hand and Garmin's that count. */
export function workoutOf(day) {
    const garmin = (day.garmin ?? []).filter(a => a.minutes * 60 >= WORKOUT_MIN_SECONDS);
    const minutes = (day.workoutMinutes ?? 0) + garmin.reduce((sum, a) => sum + a.minutes, 0);
    const ends = [day.workoutEnd, ...garmin.map(a => a.end)].filter(Number.isFinite);
    return {minutes, end: ends.length ? Math.max(...ends) : null, garmin};
}

/** Whether a Garmin activity covers most of an away (its question is answered). */
export function coversAway(activities, away) {
    if (!away)
        return false;
    const length = away.to - away.from;
    return activities.some(a => Math.min(a.end, away.to) - Math.max(a.start, away.from) >= length / 2);
}
