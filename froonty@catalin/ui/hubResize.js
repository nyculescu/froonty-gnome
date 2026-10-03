// SPDX-License-Identifier: GPL-3.0-or-later
// Sizes the resize grip may give the open tab (ui/resizeGrip.js), in the
// logical pixels of its hubSizeKeys (what Settings → Size shows). Pure
// calculations: no GNOME imports, so the unit tests can load them.
//
// The island stays centred at the top: a pointer that moves dx widens it
// by 2 dx (each side follows by dx) and lengthens it by dy downward.

// Keyboard steps on the focused grip (logical px; Shift: the larger one).
export const KEY_STEP = 10;
export const KEY_STEP_LARGE = 50;

/**
 * One axis, clamped. In order of precedence: the key's schema range (a
 * value outside it cannot be written), what the hub needs (below it the
 * island would not shrink anyway), the room the work area has.
 *
 * @param {number} value logical px
 * @param {object} limits
 * @param {number} limits.min schema minimum
 * @param {number} limits.max schema maximum
 * @param {number} [limits.need] logical px the hub needs on this axis
 * @param {number} [limits.room] logical px the work area has
 * @returns {number} a whole number within [min, max]
 */
export function clampAxis(value, {min, max, need = 0, room = Infinity}) {
    const lower = Math.max(min, Math.min(need, max));
    const upper = Math.max(lower, Math.min(max, room));
    return Math.round(Math.min(upper, Math.max(lower, value)));
}

/**
 * @param {{width: number, height: number}} size logical px
 * @param {{width: object, height: object}} limits clampAxis()'s, per axis
 * @returns {{width: number, height: number}}
 */
export function clampHubSize(size, limits) {
    return {
        width: clampAxis(size.width, limits.width),
        height: clampAxis(size.height, limits.height),
    };
}

/**
 * The size a drag asks for, before clamping.
 *
 * @param {{width: number, height: number}} start logical px at the press
 * @param {number} dx stage px the pointer moved right
 * @param {number} dy stage px the pointer moved down
 * @param {number} scale stage px per logical px
 * @returns {{width: number, height: number}}
 */
export function draggedSize(start, dx, dy, scale = 1) {
    return {
        width: start.width + 2 * dx / scale,
        height: start.height + dy / scale,
    };
}

/**
 * The size an arrow key asks for, before clamping: Left and Right narrow
 * and widen, Up and Down shorten and lengthen.
 *
 * @param {{width: number, height: number}} size logical px
 * @param {'left'|'right'|'up'|'down'} direction
 * @param {boolean} [large] Shift was held
 * @returns {{width: number, height: number}}
 */
export function nudgedSize(size, direction, large = false) {
    const step = large ? KEY_STEP_LARGE : KEY_STEP;
    const [dw, dh] = {
        left: [-step, 0],
        right: [step, 0],
        up: [0, -step],
        down: [0, step],
    }[direction] ?? [0, 0];
    return {width: size.width + dw, height: size.height + dh};
}
