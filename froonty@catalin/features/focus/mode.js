// SPDX-License-Identifier: GPL-3.0-or-later
// Focus (docs/features/focus.md): what this computer is told about you,
// Working, Sleeping, Away (from home) or Auto, kept in
// $XDG_STATE_HOME/focus/mode.json so programs outside the Shell can read it
// without GNOME: llano's noise caps (noise.py focus()) and the batch fan
// controller. No GNOME Shell imports here, so plain gjs can test it.

import GLib from 'gi://GLib';

/** The modes, in menu order; 'auto' is none chosen (the clock's rules). */
export const MODES = ['working', 'sleeping', 'away', 'auto'];

/** Where the mode is kept. */
export function modePath() {
    return GLib.build_filenamev([GLib.get_user_state_dir(), 'focus', 'mode.json']);
}

/**
 * The mode in a mode.json text; 'auto' for anything else.
 *
 * @param {string} text the file's contents
 * @returns {string} one of MODES
 */
export function parseMode(text) {
    try {
        const mode = JSON.parse(text)?.mode;
        return MODES.includes(mode) ? mode : 'auto';
    } catch {
        return 'auto';
    }
}

/**
 * The mode on disk; 'auto' when there is none or it cannot be read.
 *
 * @param {string} path the file (modePath() by default)
 * @returns {string} one of MODES
 */
export function readMode(path = modePath()) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return parseMode(new TextDecoder().decode(bytes));
    } catch {
        return 'auto';
    }
}

/**
 * Writes the mode (atomically: GLib writes a temporary file and renames it,
 * so a reader never sees half a file).
 *
 * @param {string} mode one of MODES
 * @param {string} path the file (modePath() by default)
 * @param {number} now seconds since the epoch, for `since`
 */
export function writeMode(mode, path = modePath(), now = Date.now() / 1000) {
    if (!MODES.includes(mode))
        throw new Error(`unknown Focus mode ${mode}`);
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    GLib.file_set_contents(path, `${JSON.stringify({mode, since: Math.round(now), by: 'Froonty'})}\n`);
}
