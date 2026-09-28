// SPDX-License-Identifier: GPL-3.0-or-later
// Content transitions inside the pill. The pill's own resize is a plain
// ease() in island.js; this module only swaps what is shown inside it.

import Clutter from 'gi://Clutter';

const FADE_MODE = Clutter.AnimationMode.EASE_OUT_QUAD;

// Content cross-fade, as fractions of the resize duration: the outgoing view
// fades out during the first half, the incoming one fades in during the
// second half, when the pill is already close to its final size.
const FADE_OUT_FRACTION = 0.5;
const FADE_IN_DELAY_FRACTION = 0.5;

/**
 * Fade from one content actor to another while the pill resizes.
 *
 * @param {Clutter.Actor} incoming
 * @param {Clutter.Actor} outgoing
 * @param {number} duration the resize duration, in ms
 */
export function crossfade(incoming, outgoing, duration) {
    outgoing.remove_all_transitions();
    outgoing.ease({
        opacity: 0,
        duration: duration * FADE_OUT_FRACTION,
        mode: FADE_MODE,
        onComplete: () => outgoing.hide(),
    });

    incoming.remove_all_transitions();
    incoming.show();
    incoming.ease({
        opacity: 255,
        delay: duration * FADE_IN_DELAY_FRACTION,
        duration: duration * (1 - FADE_IN_DELAY_FRACTION),
        mode: FADE_MODE,
    });
}

/**
 * Show one content actor and hide the other, cancelling any fade.
 *
 * @param {Clutter.Actor} visible
 * @param {Clutter.Actor} hidden
 */
export function showOnly(visible, hidden) {
    for (const actor of [visible, hidden])
        actor.remove_all_transitions();

    visible.opacity = 255;
    visible.show();
    hidden.opacity = 0;
    hidden.hide();
}
