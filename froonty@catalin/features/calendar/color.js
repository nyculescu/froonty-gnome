// SPDX-License-Identifier: GPL-3.0-or-later
// Calendar colours (docs/features/calendar.md §B). An EDS calendar's
// colour is a free-form string anyone with access to the calendar's
// settings can write, so it never reaches CSS or markup as it is: it is
// parsed into numbers, and only hex built from those numbers is used.

/** Shown for a calendar whose colour is missing or not a colour. */
export const FALLBACK_COLOR = 'rgba(255,255,255,0.5)';

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(?:\d*\.?\d+%?)\s*)?\)$/i;

/**
 * @param {?string} text '#rgb', '#rrggbb', '#rrggbbaa', 'rgb(r,g,b)' or
 *   'rgba(r,g,b,a)' (alpha is ignored)
 * @returns {?number[]} [r, g, b], each 0-255, or null
 */
export function parseColor(text) {
    if (typeof text !== 'string')
        return null;
    const value = text.trim();
    const hex = HEX.exec(value);
    if (hex) {
        let digits = hex[1];
        if (digits.length === 3)
            digits = [...digits].map(c => c + c).join('');
        return [0, 2, 4].map(i => parseInt(digits.slice(i, i + 2), 16));
    }
    const rgb = RGB.exec(value);
    if (rgb) {
        const channels = rgb.slice(1, 4).map(Number);
        return channels.every(c => c <= 255) ? channels : null;
    }
    return null;
}

/** '#rrggbb' for a parsed colour. */
export function toHex(rgb) {
    return `#${rgb.map(c => c.toString(16).padStart(2, '0')).join('')}`;
}

/** The colour as '#rrggbb', or null when it is not one. */
export function sanitizeColor(text) {
    const rgb = parseColor(text);
    return rgb ? toHex(rgb) : null;
}

/** '#rrggbb' with an alpha, as CSS rgba(); only from a sanitized colour. */
export function withAlpha(hex, alpha) {
    const rgb = parseColor(hex);
    if (!rgb)
        return FALLBACK_COLOR;
    return `rgba(${rgb.join(',')},${alpha})`;
}
