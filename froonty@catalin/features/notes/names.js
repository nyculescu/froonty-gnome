// SPDX-License-Identifier: GPL-3.0-or-later
// Note names ↔ file names. Pure functions, unit-tested.
//
// A note's name is its file name without the ".md" extension.

const EXTENSION = '.md';

// "2026-09-28 15.40": sortable, and free of ":", which is invalid on
// exFAT/NTFS and trips up sync tools.
const TIMESTAMP_FORMAT = '%Y-%m-%d %H.%M';

// Characters that cannot or should not appear in a file name on the file
// systems notes may be synced to (Linux, exFAT, NTFS, macOS).
const FORBIDDEN = /[/\\:*?"<>|\u0000-\u001f]/;

/** @param {GLib.DateTime} dateTime */
export function timestampName(dateTime) {
    return dateTime.format(TIMESTAMP_FORMAT);
}

/**
 * The first of "base", "base (2)", "base (3)", … not in `existing`.
 * Comparison ignores case: exFAT and NTFS do.
 *
 * @param {string} base
 * @param {string[]} existing note names
 */
export function uniqueName(base, existing) {
    const taken = new Set(existing.map(n => n.toLowerCase()));
    if (!taken.has(base.toLowerCase()))
        return base;

    for (let i = 2; ; i++) {
        const candidate = `${base} (${i})`;
        if (!taken.has(candidate.toLowerCase()))
            return candidate;
    }
}

/** Trimmed name, or null when it cannot be used as a file name. */
export function cleanName(name) {
    const trimmed = name.trim();
    if (!trimmed || trimmed.startsWith('.') || FORBIDDEN.test(trimmed))
        return null;
    return trimmed;
}

export function fileName(name) {
    return `${name}${EXTENSION}`;
}

/** Note name for a file name, or null when it is not a note. */
export function noteName(file) {
    if (!file.toLowerCase().endsWith(EXTENSION) || file.startsWith('.'))
        return null;
    const name = file.slice(0, -EXTENSION.length);
    return name || null;
}

/** Case-insensitive, natural order ("Note 2" before "Note 10"). */
export function compareNames(a, b) {
    return a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'});
}
