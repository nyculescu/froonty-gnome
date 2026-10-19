// SPDX-License-Identifier: GPL-3.0-or-later
// Which moves the Break tab shows (docs/features/break.md, Exercises):
// one card at a time, or a guided routine for a movement break or a long
// rest. Pure; the moves are the catalog's (exercises.js).
//
// - During a call (busy, busy.js) only discreet moves.
// - Standing at the desk: standing moves first; sitting, seated ones, but
//   a movement break starts by getting up (unless during a call).
// - Different body regions before the same one twice.
// - The moves shown lately (state exercise.recent) come last.
// - `seed` (the service's exercise counter) turns the order, so "Another"
//   and the next break show something else.

const BODY = ['stretch', 'move'];
// A routine stops adding moves at this many.
const MAX_ROUTINE_MOVES = 8;
// ... and once it fills this share of the time it has.
const FILL = 0.8;
// Moves that get you up and moving, first in a movement break.
const GET_UP = ['walk', 'march', 'chair-squat', 'calf-raise', 'arm-circles'];

const rotate = (list, seed) => {
    if (!list.length)
        return list;
    const k = ((seed % list.length) + list.length) % list.length;
    return [...list.slice(k), ...list.slice(0, k)];
};

/**
 * The moves of `kinds` that fit, in the order to show them.
 *
 * @param {object[]} moves the catalog's
 * @param {object} o
 * @param {string[]} [o.kinds] catalog kinds (default: stretches and moves)
 * @param {'sitting'|'standing'} [o.posture]
 * @param {boolean} [o.discreet] only moves that can be done in a call
 * @param {string[]} [o.recent] ids shown lately, newest first
 * @param {number} [o.seed]
 * @returns {object[]}
 */
export function orderMoves(moves, {kinds = BODY, posture = 'sitting', discreet = false, recent = [], seed = 0} = {}) {
    const fits = moves.filter(m => kinds.includes(m.kind) && (!discreet || m.discreet));
    const fresh = rotate(fits.filter(m => !recent.includes(m.id)), seed);
    // The least recent of the recent ones first.
    const stale = fits.filter(m => recent.includes(m.id))
        .sort((a, b) => recent.indexOf(b.id) - recent.indexOf(a.id));
    const preferred = posture === 'standing' ? 'standing' : 'seated';
    const byPosture = list => [...list.filter(m => m.posture === preferred),
        ...list.filter(m => m.posture !== preferred)];
    return [...byPosture(fresh), ...byPosture(stale)];
}

// Greedy: a new region each time while there is one, then any.
function spread(list, count) {
    const out = [];
    const regions = new Set();
    for (const m of list) {
        if (out.length >= count)
            break;
        if (!regions.has(m.region)) {
            out.push(m);
            regions.add(m.region);
        }
    }
    for (const m of list) {
        if (out.length >= count)
            break;
        if (!out.includes(m))
            out.push(m);
    }
    return out;
}

/** The next single card: the first move that fits, or null. */
export function nextMove(moves, options = {}) {
    return orderMoves(moves, options)[0] ?? null;
}

/**
 * A guided routine.
 *
 * @param {object[]} moves the catalog's
 * @param {object} o
 * @param {'movement'|'long-rest'} o.kind
 * @param {number} o.seconds the time it has (GNOME's movement break, the long rest)
 * @param {'sitting'|'standing'} [o.posture]
 * @param {boolean} [o.discreet]
 * @param {string[]} [o.recent]
 * @param {number} [o.seed]
 * @param {boolean} [o.breathing] end a long rest with a breathing exercise
 * @param {string} [o.breathingPattern] 'box' | 'slow'
 * @returns {object[]} moves, in order
 */
export function routine(moves, {kind, seconds, posture = 'sitting', discreet = false, recent = [],
    seed = 0, breathing = false, breathingPattern = 'box'}) {
    const steps = [];
    const byId = id => moves.find(m => m.id === id) ?? null;
    let budget = seconds * FILL;
    const add = m => {
        if (m && !steps.includes(m)) {
            steps.push(m);
            budget -= m.seconds;
        }
    };
    if (kind === 'long-rest' && !discreet) {
        add(byId('walk'));
        add(byId('water'));
    } else if (kind === 'movement' && !discreet) {
        // Get up first: standing at the desk already, a move; else the
        // first standing move that fits.
        const up = orderMoves(moves, {posture: 'standing', recent, seed})
            .find(m => GET_UP.includes(m.id) && m.seconds <= Math.max(60, seconds / 2));
        add(up);
    }
    const breath = breathing && kind === 'long-rest'
        ? byId(breathingPattern === 'slow' ? 'breath-slow' : 'breath-box') : null;
    if (breath)
        budget -= breath.seconds;
    const rest = orderMoves(moves, {posture, discreet, recent, seed})
        .filter(m => !steps.includes(m) && !(GET_UP.includes(m.id) && steps.length));
    for (const m of spread(rest, MAX_ROUTINE_MOVES)) {
        if (budget <= 0 || steps.length >= MAX_ROUTINE_MOVES - (breath ? 1 : 0))
            break;
        add(m);
    }
    add(breath);
    return steps;
}

/** A routine's length in seconds. */
export const routineSeconds = steps => steps.reduce((sum, m) => sum + m.seconds, 0);
