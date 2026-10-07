// SPDX-License-Identifier: GPL-3.0-or-later
// Software brightness, without the Shell: which monitors are dimmed and
// how much (unit-tested; overlay.js puts it on screen). Levels are in
// percent, 100 meaning no overlay.

// Settings → Brightness → Monitors, in the order the settings list them.
export const TARGETS = ['external', 'built-in', 'all'];

/**
 * The monitors a target dims.
 *
 * @param {string} target one of TARGETS
 * @param {number} count how many monitors there are
 * @param {Set<number>} builtIn indices of the built-in panels (a laptop's)
 * @returns {number[]} monitor indices, as in Main.layoutManager.monitors
 */
export function targetMonitors(target, count, builtIn) {
    const all = [...Array(count).keys()];
    if (target === 'all')
        return all;
    if (target === 'built-in')
        return all.filter(i => builtIn.has(i));
    return all.filter(i => !builtIn.has(i));
}

/** The level applied: the stored one, never below the minimum. */
export function appliedLevel(level, minimum) {
    return Math.min(100, Math.max(minimum, level));
}

/** The black overlay's opacity (0-255) for a level. */
export function overlayOpacity(level) {
    return Math.round(255 * (100 - level) / 100);
}

/** Where the Quick Settings slider stands (0-1): it spans minimum-100 %. */
export function sliderValue(level, minimum) {
    if (minimum >= 100)
        return 1;
    return (appliedLevel(level, minimum) - minimum) / (100 - minimum);
}

/** The level a slider position (0-1) stands for, in whole percent. */
export function levelFromSlider(value, minimum) {
    return Math.round(minimum + Math.min(1, Math.max(0, value)) * (100 - minimum));
}
