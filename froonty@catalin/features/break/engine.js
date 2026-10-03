// SPDX-License-Identifier: GPL-3.0-or-later
// The Break tab's rules (docs/features/break.md): urgency, which of GNOME's
// actions work, a suggested length, what a change in GNOME's times was,
// when anything next changes, and the pill's cue. Pure functions over a
// model the service builds; no GNOME, no St. Times are wall-clock seconds.
//
// "Due" comes from GNOME's times, never from its state alone: GNOME reports
// IN_BREAK while the user types after an interrupted break, and IDLE while
// they work with a break still owed (verified on GNOME Shell 50.1).
//
// The model (BreakService.model()):
//   now, state                   GNOME's clock and state (shell/breakEngine.js)
//   lastEnd                      {type: s} per selected type, or null (fallback)
//   nextDue, nextType            GNOME's next break (the fallback's only source)
//   types                        {type: {interval, duration, delay, fade, lock}}
//   breaks                       {type: {consecutive, delaysInRow, owed}}
//   prefs                        escalateAfter, maxDelays, makeUp, longRest,
//                                longRestAfter, longRestLength (s)
//   screenSinceLongRest          s at the screen since the last long rest
//   present                      not in an open idle period
//   posture                      {enabled, reminders, mode, modeActiveSeconds,
//                                 sitAfter, standAfter, standingSeconds, targetSeconds}
//   cueMode                      'off' | 'icon' | 'icon-and-time'
//   midnight                     the next local midnight

import {OVERDUE_SECONDS, STATE, UPCOMING_SECONDS} from '../../shell/breakEngine.js';

export const LEVEL = {FINE: 0, SOON: 1, DUE: 2, OVERDUE: 3, URGENT: 4};
// Pill cue priority: urgent > overdue > due > posture > soon > fine.
export const RANK = {0: 0, 1: 10, 2: 20, 3: 30, 4: 40, posture: 15};

// Tolerances when matching GNOME's time changes (s).
const NOW_TOLERANCE = 2;
const DELAY_TOLERANCE = 1;

// Of several types, the one with the longest break (GNOME reports that one).
const longest = types => types.reduce((a, b) => (b.duration > a.duration ? b : a));

/** Each selected type's due time and how far past it `now` is. */
export function perType(m) {
    if (m.state === STATE.DISABLED)
        return [];
    if (m.lastEnd) {
        return Object.keys(m.lastEnd).filter(t => m.types[t]).map(t => {
            const due = m.lastEnd[t] + m.types[t].interval;
            return {type: t, ...m.types[t], due, overdue: m.now - due};
        });
    }
    // Fallback (GNOME's private map is gone): the next break only.
    if (!m.nextType || !m.nextDue || !m.types[m.nextType])
        return [];
    return [{type: m.nextType, ...m.types[m.nextType], due: m.nextDue,
        overdue: m.now - m.nextDue, fallback: true}];
}

/**
 * The urgency level, 0-4, and what it is about.
 *
 * @returns {{level: number, reason: string, type: ?string, overdue: number,
 *   soonIn: ?number, froontyRule: boolean}}
 */
export function levelOf(m) {
    const types = perType(m);
    const due = types.filter(t => t.overdue >= 0);
    const result = (level, reason, focus, froontyRule = false) => ({
        level, reason, froontyRule,
        type: focus?.type ?? null,
        overdue: focus ? Math.max(0, focus.overdue) : 0,
        soonIn: focus && focus.overdue < 0 ? -focus.overdue : null,
    });

    const byInterval = due.filter(t => t.overdue >= t.interval);
    if (byInterval.length)
        return result(LEVEL.URGENT, 'interval', longest(byInterval), true);
    if (m.prefs.longRest && m.screenSinceLongRest >= m.prefs.longRestAfter)
        return result(LEVEL.URGENT, 'long-rest', null, true);
    const late = due.filter(t => t.overdue >= OVERDUE_SECONDS);
    if (late.length)
        return result(LEVEL.OVERDUE, 'overdue', longest(late));
    const escalated = m.prefs.escalateAfter > 0
        ? due.filter(t => (m.breaks[t.type]?.consecutive ?? 0) >= m.prefs.escalateAfter) : [];
    if (escalated.length)
        return result(LEVEL.OVERDUE, 'skips', longest(escalated), true);
    if (due.length)
        return result(LEVEL.DUE, 'due', longest(due));
    if (!types.length)
        return result(LEVEL.FINE, 'none', null);
    const next = types.reduce((a, b) => (b.due < a.due ? b : a));
    return next.due - m.now <= UPCOMING_SECONDS
        ? result(LEVEL.SOON, 'soon', next)
        : result(LEVEL.FINE, 'fine', next);
}

/**
 * Which of GNOME's actions work now (GNOME 50.1: Delay and Skip do nothing
 * when nothing is due; Take only dims or locks while a break is current).
 */
export function actionsOf(m) {
    const none = {take: false, delay: false, skip: false, skipBoth: false, type: null,
        delaySeconds: 0, delayHidden: null, interrupted: false};
    const due = perType(m).filter(t => t.overdue >= 0);
    if (m.state === STATE.DISABLED || !due.length)
        return none;
    const reported = longest(due);
    const tooLate = due.filter(t => t.overdue >= t.delay);
    const capped = m.prefs.maxDelays > 0 &&
        due.some(t => (m.breaks[t.type]?.delaysInRow ?? 0) >= m.prefs.maxDelays);
    let delayHidden = null;
    if (tooLate.length) {
        const worst = tooLate.reduce((a, b) => (b.overdue > a.overdue ? b : a));
        delayHidden = {reason: 'overdue', delay: worst.delay, overdue: worst.overdue};
    } else if (capped) {
        delayHidden = {reason: 'capped', max: m.prefs.maxDelays};
    }
    return {
        // GNOME dims or locks only while BREAK_DUE: its current type is set
        // there (and right after due, it lags by up to a second).
        take: m.state === STATE.BREAK_DUE,
        delay: !delayHidden,
        skip: true,
        // GNOME skips (and delays) every due type at once.
        skipBoth: due.length > 1,
        type: reported.type,
        delaySeconds: reported.delay,
        delayHidden,
        // Back early from a break, or working with one still owed.
        interrupted: m.state === STATE.IN_BREAK || m.state === STATE.IDLE,
        fade: m.types[reported.type]?.fade ?? false,
        lock: m.types[reported.type]?.lock ?? false,
        duration: reported.duration,
    };
}

/**
 * A suggested length (a labelled heuristic; GNOME's own length is never
 * rewritten).
 *
 * @returns {?{seconds: number, type: ?string, longRest: boolean,
 *   insteadMovement: boolean}}
 */
export function suggested(m, level = levelOf(m)) {
    if (level.reason === 'long-rest')
        return {seconds: m.prefs.longRestLength, type: null, longRest: true, insteadMovement: false};
    const type = level.type;
    if (!type || !m.types[type])
        return null;
    const duration = m.types[type].duration;
    if (type === 'movement') {
        const owed = m.prefs.makeUp ? Math.min(duration, m.breaks.movement?.owed ?? 0) : 0;
        return {seconds: duration + owed, type, longRest: false, insteadMovement: false};
    }
    return {
        seconds: duration, type, longRest: false,
        insteadMovement: (m.breaks[type]?.consecutive ?? 0) >= 2 && Boolean(m.types.movement),
    };
}

/**
 * What a change in GNOME's per-type last break ends was.
 *
 * @param {?object} before {type: s}
 * @param {?object} after {type: s}
 * @param {object} ctx
 * @param {number} ctx.now
 * @param {?string} ctx.ownAction 'delay' | 'skip' while Froonty's call runs
 * @param {object} ctx.types {type: {interval, duration, delay}}
 * @param {?number} ctx.returnLength s of the idle period ending now, if any
 * @returns {object[]} events: {type, kind: 'taken'|'skip'|'delay', source, length}
 */
export function classify(before, after, {now, ownAction, types, returnLength = null}) {
    const events = [];
    if (!before || !after)
        return events;
    for (const type of Object.keys(after)) {
        const c = types[type];
        // A type turned on (or off: not in `after`) is not a break.
        if (!(type in before) || !c)
            continue;
        const was = before[type];
        const is = after[type];
        if (Math.abs(is - was) < 1e-3)
            continue;
        const nearNow = Math.abs(is - now) <= NOW_TOLERANCE;
        const byDelay = Math.abs(is - was - c.delay) <= DELAY_TOLERANCE;
        const wasDue = was + c.interval <= now + DELAY_TOLERANCE;
        if (ownAction === 'skip' && nearNow)
            events.push({type, kind: 'skip', source: 'froonty'});
        else if (byDelay)
            events.push({type, kind: 'delay', source: ownAction === 'delay' ? 'froonty' : 'gnome'});
        else if (nearNow && returnLength !== null && returnLength >= c.duration - 1)
            events.push({type, kind: 'taken', source: 'gnome', length: returnLength});
        else if (nearNow && wasDue)
            // Closing GNOME's break notification skips the break.
            events.push({type, kind: 'skip', source: 'gnome'});
    }
    return events;
}

/**
 * Breaks taken while Froonty was stopped (a screen lock): GNOME counts on.
 * Only for the same Shell process; a new one restarted its counting.
 *
 * @param {object} saved {type: s} when Froonty stopped
 * @param {object} current {type: s} now
 * @param {object} ctx
 * @param {number} ctx.savedAt s
 * @param {?number} ctx.idleStart s, when an idle period was open at the stop
 * @param {number} ctx.now
 * @param {object} ctx.types
 */
export function classifyGap(saved, current, {savedAt, idleStart, now, types}) {
    const events = [];
    if (!saved || !current)
        return events;
    for (const type of Object.keys(current)) {
        const c = types[type];
        if (!(type in saved) || !c || Math.abs(current[type] - saved[type]) < 1e-3)
            continue;
        const end = current[type];
        if (Math.abs(end - saved[type] - c.delay) <= DELAY_TOLERANCE) {
            events.push({type, kind: 'delay', source: 'gnome'});
        } else if (end >= savedAt - NOW_TOLERANCE && end <= now + NOW_TOLERANCE) {
            const length = end - (idleStart ?? savedAt);
            if (length >= c.duration - 1)
                events.push({type, kind: 'taken', source: 'gnome', length});
        }
    }
    return events;
}

/** The posture reminder due now: 'stand', 'sit' or null. */
export function postureCue(p) {
    if (!p?.enabled || !p.reminders)
        return null;
    if (p.mode === 'sitting' && p.modeActiveSeconds >= p.sitAfter &&
        p.standingSeconds < p.targetSeconds)
        return 'stand';
    if (p.mode === 'standing' && p.modeActiveSeconds >= p.standAfter)
        return 'sit';
    return null;
}

/**
 * When anything shown can next change on its own (s): 2 min before each
 * break, at it, 60 s and one interval after it, the long-rest crossing,
 * the posture reminder, and midnight. GNOME emits nothing at those times.
 */
export function nextBoundary(m) {
    const times = [];
    for (const t of perType(m))
        times.push(t.due - UPCOMING_SECONDS, t.due, t.due + OVERDUE_SECONDS, t.due + t.interval);
    if (m.present && m.prefs.longRest)
        times.push(m.now + m.prefs.longRestAfter - m.screenSinceLongRest);
    const p = m.posture;
    if (m.present && p?.enabled && p.reminders && !postureCue(p)) {
        if (p.mode === 'standing')
            times.push(m.now + p.standAfter - p.modeActiveSeconds);
        else if (p.standingSeconds < p.targetSeconds)
            times.push(m.now + p.sitAfter - p.modeActiveSeconds);
    }
    if (m.midnight)
        times.push(m.midnight);
    const future = times.filter(t => t > m.now + 1e-3);
    return future.length ? Math.min(...future) : null;
}

/**
 * The pill's cue: the most urgent of the break level and the posture
 * reminder, or null. Text and icons come from words.js and shared.js.
 *
 * @returns {?{rank: number, kind: 'break'|'posture', level: ?number,
 *   reason: ?string, type: ?string, seconds: number, posture: ?string}}
 */
export function cueModel(m, level = levelOf(m)) {
    if (m.cueMode === 'off')
        return null;
    let cue = null;
    const hasSubject = level.type || level.reason === 'long-rest';
    if (hasSubject && (level.level > LEVEL.FINE || m.cueMode === 'icon-and-time')) {
        let seconds = level.soonIn ?? level.overdue;
        if (level.reason === 'long-rest')
            seconds = m.screenSinceLongRest;
        cue = {rank: RANK[level.level], kind: 'break', level: level.level, reason: level.reason,
            type: level.type, seconds, posture: null};
    }
    const posture = postureCue(m.posture);
    if (posture && (!cue || RANK.posture > cue.rank)) {
        cue = {rank: RANK.posture, kind: 'posture', level: null, reason: 'posture',
            type: null, seconds: 0, posture};
    }
    return cue;
}
