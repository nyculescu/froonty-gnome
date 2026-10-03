// SPDX-License-Identifier: GPL-3.0-or-later
// Two-finger touchpad swipes that change song (media-gestures), over the
// collapsed pill's music or the Media tab's player row. Fingers left:
// next; right: previous; once per gesture (model.SwipeTracker).
//
// Only touchpad finger scrolls without modifier keys count; a mouse wheel
// never skips. The finger direction is the physical one, as GNOME Shell's
// own slider reads it (ui/slider.js: "Match physical direction"), so it
// is the same with natural and traditional scrolling.

import Clutter from 'gi://Clutter';

import {physicalDx} from './model.js';

// Clutter gives touchpad scroll deltas in tenths of a pixel of finger
// travel (Mutter divides libinput's pixels by its discrete step, 10).
export const PX_PER_DELTA = 10;
const MODIFIERS = Clutter.ModifierType.SHIFT_MASK | Clutter.ModifierType.CONTROL_MASK |
    Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK;

/**
 * Feeds a scroll event to a tracker.
 *
 * @param {SwipeTracker} tracker
 * @param {Clutter.Event} event
 * @returns {?string} null when the event is not a finger swipe; else
 *   'next', 'previous' or '' (a swipe, no skip yet)
 */
export function feedSwipe(tracker, event) {
    if (event.get_scroll_direction() !== Clutter.ScrollDirection.SMOOTH ||
        event.get_scroll_source() !== Clutter.ScrollSource.FINGER ||
        (event.get_state() & MODIFIERS) !== 0)
        return null;
    const [dx, dy] = event.get_scroll_delta();
    const inverted = (event.get_scroll_flags() & Clutter.ScrollFlags.INVERTED) !== 0;
    const finished = event.get_scroll_finish_flags() !== Clutter.ScrollFinishFlags.NONE;
    return tracker.feed({
        dx: physicalDx(dx, inverted) * PX_PER_DELTA,
        dy: dy * PX_PER_DELTA,
        timeMs: event.get_time(),
        finished,
    }) ?? '';
}

/**
 * A short sideways nudge after a skip (skipped when GNOME's animations are
 * off: the Shell's ease is then instant anyway).
 *
 * @param {Clutter.Actor} actor
 * @param {string} action 'next' (left) or 'previous' (right)
 */
export function nudge(actor, action) {
    actor.remove_transition('translation-x');
    actor.translation_x = 0;
    actor.ease({
        translation_x: action === 'next' ? -8 : 8,
        duration: 90,
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        onComplete: () => actor.ease({
            translation_x: 0,
            duration: 250,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        }),
    });
}
