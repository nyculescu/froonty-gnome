// SPDX-License-Identifier: GPL-3.0-or-later
// "Notice when you are busy" (docs/features/break.md, "Busy"): what the
// busy signals (shell/busySignals.js) mean for the Break tab. Pure.
//
// Three effects, each from its own signals:
//   present   no input still counts as time at the computer (a call, a
//             video, a presentation): the ledger opens no away for it
//   hold      the island holds its break cue (it shows again
//             break-busy-grace-minutes after the last one ends)
//   gnome     with break-busy-hold-gnome, GNOME's dimming and locking are
//             off meanwhile (pause.js applyHold): only in a call, a screen
//             share, or full screen while something keeps the screen awake
//             (a video, a presentation). Not for Do Not Disturb or any
//             full-screen window: someone who keeps those on all day would
//             never be reminded.
//
// Do Not Disturb (off by default) holds the cue, but someone can leave with
// it on: it does not keep them present. A video that keeps the screen awake
// keeps them present but holds nothing: a cue on the pill does not
// interrupt it.

export const SIGNALS = ['fullscreen', 'screen-share', 'microphone', 'dnd', 'watching'];

const PRESENT = ['fullscreen', 'screen-share', 'microphone', 'watching'];
const HOLD = ['fullscreen', 'screen-share', 'microphone', 'dnd'];

const on = (active, signal) => (signal === 'watching' ? active.watching?.length > 0 : Boolean(active[signal]));

/**
 * @param {?object} active BusySignals.active, or null (off or not made)
 * @param {string[]} chosen break-busy-signals
 * @param {object} [options]
 * @param {boolean} [options.holdGnome] break-busy-hold-gnome
 * @returns {{present: boolean, hold: boolean, gnome: boolean, reasons: string[],
 *   watching: {app: string, reason: string}[]}}
 */
export function busyState(active, chosen, {holdGnome = false} = {}) {
    const reasons = active ? SIGNALS.filter(s => chosen.includes(s) && on(active, s)) : [];
    const has = s => reasons.includes(s);
    return {
        present: reasons.some(s => PRESENT.includes(s)),
        hold: reasons.some(s => HOLD.includes(s)),
        gnome: holdGnome && (has('microphone') || has('screen-share') || (has('fullscreen') && has('watching'))),
        reasons,
        watching: reasons.includes('watching') ? active.watching : [],
    };
}

/**
 * Whether the cue is held at `now` (s): while busy, and for `grace` s
 * after the last busy moment.
 */
export function cueHeld(busy, endedAt, now, grace) {
    return busy.hold || (endedAt !== null && now < endedAt + grace);
}

/** A display name for an inhibitor's app id (a desktop id or a path). */
export function appName(app) {
    const base = String(app ?? '').split('/').pop().replace(/\.desktop$/, '');
    return base || null;
}
