// SPDX-License-Identifier: GPL-3.0-or-later
// The standing target and its optional build-up (docs/features/break.md).
// Pure; no GNOME, no St.
//
// The base (posture-target-minutes, 2 h by default) is the minimum. With
// build-up on, the target grows by a step (15 min) after the user met it
// on 4 of the last 5 working days, at most once a week, up to a ceiling
// (4 h). It never steps down by itself; Settings → Break resets it.
// "Just the minimum today" keeps today at the base, and such days do not
// count toward a step.

// The last WINDOW working days decide; MET of them must meet their target.
const WINDOW = 5;
const MET = 4;
const MIN_WEEK_DAYS = 7;
// A day counts as a working day from this much time at the computer.
const WORKING_DAY_SECONDS = 3600;

/**
 * @typedef {object} PlanSettings
 * @property {number} base posture-target-minutes
 * @property {boolean} buildup posture-buildup
 * @property {number} step posture-buildup-step-minutes
 * @property {number} ceiling posture-buildup-ceiling-minutes
 * @property {number} built posture-buildup-target (0: not built up yet)
 */

/** The built-up target in minutes, kept between the base and the ceiling. */
export function builtTarget(p) {
    return Math.max(p.base, Math.min(p.ceiling, p.built || p.base));
}

/** Today's standing target in minutes. */
export function todayTarget(p, minimumToday) {
    return minimumToday || !p.buildup ? p.base : builtTarget(p);
}

export function met(day) {
    return day.targetSeconds > 0 && day.standingSeconds >= day.targetSeconds;
}

// Days between two "YYYY-MM-DD" keys (calendar days, ignoring DST).
function daysBetween(a, b) {
    const ms = key => Date.UTC(...key.split('-').map((n, i) => Number(n) - (i === 1 ? 1 : 0)));
    return Math.round((ms(b) - ms(a)) / 86400000);
}

/**
 * Evaluated when a day closes (at the first moment of the next one).
 *
 * @param {PlanSettings} p
 * @param {object[]} history past days, newest first, including the one
 *   that just closed
 * @param {?string} lastStepDay when the target last grew
 * @param {string} today the new day's key
 * @returns {?{built: number, lastStepDay: string}} a step, or null
 */
export function evaluateStep(p, history, lastStepDay, today) {
    if (!p.buildup)
        return null;
    const current = builtTarget(p);
    if (current >= p.ceiling)
        return null;
    if (lastStepDay && daysBetween(lastStepDay, today) < MIN_WEEK_DAYS)
        return null;
    const recent = history
        .filter(d => !d.minimumOnly && d.activeSeconds >= WORKING_DAY_SECONDS)
        .slice(0, WINDOW);
    if (recent.length < WINDOW || recent.filter(met).length < MET)
        return null;
    return {built: Math.min(p.ceiling, current + p.step), lastStepDay: today};
}
