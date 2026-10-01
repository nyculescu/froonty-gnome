// SPDX-License-Identifier: GPL-3.0-or-later
// Setting up Froonty's Claude Code status line (statusline.py) in Claude
// Code's user settings, from Froonty's settings window (prefs.js). Only on
// the user's click; never over a status line of their own. Gio only, so
// it runs in the preferences process and in plain gjs unit tests.
//
// Claude Code reads `statusLine` from $CLAUDE_CONFIG_DIR/settings.json, or
// ~/.claude/settings.json (code.claude.com/docs/en/statusline), and picks
// up a change on its own.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const SCRIPT = 'statusline.py';

/** Claude Code's user settings file. */
export function claudeSettingsFile() {
    const dir = GLib.getenv('CLAUDE_CONFIG_DIR') ||
        GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
    return Gio.File.new_for_path(GLib.build_filenamev([dir, 'settings.json']));
}

/** This copy of Froonty's statusline.py. */
export function scriptPath() {
    return Gio.File.new_for_uri(import.meta.url).get_parent().get_child(SCRIPT).get_path();
}

const quote = path => `'${path.replace(/'/g, "'\\''")}'`;

/** The `statusLine` entry that runs `script`. */
export function statusLineEntry(script) {
    return {type: 'command', command: `python3 ${quote(script)}`, padding: 0};
}

// Exactly what statusLineEntry() writes, for any install of Froonty (a
// copy, or the working tree); a command of the user's that merely runs the
// script among other things is theirs.
function isOurs(entry) {
    if (entry?.type !== 'command' || typeof entry.command !== 'string')
        return false;
    const quoted = /^python3 '((?:[^']|'\\'')*)'$/.exec(entry.command);
    return Boolean(quoted) &&
        quoted[1].replace(/'\\''/g, "'").endsWith(`/froonty@catalin/features/claude/${SCRIPT}`);
}

/**
 * @param {?object} settings parsed settings.json, or null without one
 * @returns {'none'|'ours'|'other'}
 */
export function statusLineState(settings) {
    const entry = settings?.statusLine;
    if (entry === undefined || entry === null)
        return 'none';
    return isOurs(entry) ? 'ours' : 'other';
}

/**
 * Reads Claude Code's settings.
 *
 * @returns {{settings: ?object, error: ?string}} settings null when there is
 *   no file; error set when it cannot be read or is not a JSON object
 */
export function readClaudeSettings(file = claudeSettingsFile()) {
    try {
        const [, bytes] = file.load_contents(null);
        const settings = JSON.parse(new TextDecoder().decode(bytes));
        if (typeof settings !== 'object' || settings === null || Array.isArray(settings))
            return {settings: null, error: 'not a JSON object'};
        return {settings, error: null};
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return {settings: null, error: null};
        return {settings: null, error: e.message};
    }
}

/**
 * Adds Froonty's status line, keeping everything else in the file.
 *
 * @returns {?string} null when done, or why not
 */
export function installStatusLine(file = claudeSettingsFile(), script = scriptPath()) {
    const {settings, error} = readClaudeSettings(file);
    if (error)
        return error;
    if (statusLineState(settings) === 'other')
        return 'Claude Code already has a status line';
    return save(file, {...settings ?? {}, statusLine: statusLineEntry(script)});
}

/**
 * Removes Froonty's status line; any other one is left alone.
 *
 * @returns {?string} null when done, or why not
 */
export function removeStatusLine(file = claudeSettingsFile()) {
    const {settings, error} = readClaudeSettings(file);
    if (error)
        return error;
    if (statusLineState(settings) !== 'ours')
        return null;
    const {statusLine: _ours, ...rest} = settings;
    return save(file, rest);
}

// A whole new file renamed onto the old one (Gio's replace), as Claude
// Code itself writes it.
function save(file, settings) {
    try {
        try {
            file.get_parent().make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                throw e;
        }
        file.replace_contents(new TextEncoder().encode(`${JSON.stringify(settings, null, 2)}\n`),
            null, false, Gio.FileCreateFlags.PRIVATE, null);
        return null;
    } catch (e) {
        return e.message;
    }
}
