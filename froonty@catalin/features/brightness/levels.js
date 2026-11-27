// SPDX-License-Identifier: GPL-3.0-or-later
// Software brightness, without the Shell: which monitors are dimmed, how
// much, and when they join GNOME's slider (unit-tested; overlay.js puts it
// on screen). Levels are in
// percent, 100 meaning no overlay. Also Night Light's warmth slider
// (nightLightMenu.js).

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

/**
 * The monitors that join GNOME's brightness slider: those a target dims,
 * while GNOME shows its slider (some screen has a backlight) and none of
 * them has a backlight of its own. A laptop open and joined to monitors
 * GNOME cannot dim is the case it is for.
 *
 * @param {string} target one of TARGETS
 * @param {number} count how many monitors there are
 * @param {Set<number>} builtIn indices of the built-in panels
 * @param {Set<number>} backlit indices of the monitors with a backlight
 * @returns {number[]|null} monitor indices, or null for two sliders
 */
export function mergedMonitors(target, count, builtIn, backlit) {
    const dimmed = targetMonitors(target, count, builtIn);
    if (!backlit.size || !dimmed.length || dimmed.some(i => backlit.has(i)))
        return null;
    return dimmed;
}

/** The level applied: the stored one, never below the minimum. */
export function appliedLevel(level, minimum) {
    return Math.max(minimum, level);
}

/** The dimming overlay's opacity (0-255) for a level. */
export function overlayOpacity(level) {
    return Math.round(255 * (100 - level) / 100);
}

/** Where the Quick Settings slider stands (0-1): it spans minimum-100 %. */
export function sliderValue(level, minimum) {
    return (appliedLevel(level, minimum) - minimum) / (100 - minimum);
}

/** The level a slider position (0-1) stands for, in whole percent. */
export function levelFromSlider(value, minimum) {
    return Math.round(minimum + Math.min(1, Math.max(0, value)) * (100 - minimum));
}

// Night Light's warmth: 6500 K at the left (neutral, no warming; owner
// asked for less warmth than GNOME Settings allows, whose slider stops at
// 4700 K) to 1700 K (warmest, as GNOME Settings) at the right, in steps of
// 100 K. GNOME stores any value; Settings shows one above 4700 K at its
// left end.
export const WARMTH_COOLEST_K = 6500;
export const WARMTH_WARMEST_K = 1700;

/** night-light-temperature (K) for a slider position (0-1). */
export function temperatureFromSlider(value) {
    const span = WARMTH_COOLEST_K - WARMTH_WARMEST_K;
    const kelvin = WARMTH_COOLEST_K - Math.min(1, Math.max(0, value)) * span;
    return Math.round(kelvin / 100) * 100;
}

/** Where the warmth slider stands (0-1); a temperature outside the range sits at its end. */
export function sliderFromTemperature(kelvin) {
    const value = (WARMTH_COOLEST_K - kelvin) / (WARMTH_COOLEST_K - WARMTH_WARMEST_K);
    return Math.min(1, Math.max(0, value));
}
