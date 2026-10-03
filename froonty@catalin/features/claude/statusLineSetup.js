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
 * @returns {{settings: ?object, error: ?string, etag: string}} settings null
 *   when there is no file; error set when it cannot be read or is not a JSON
 *   object; etag: what saveClaudeSettings() checks the file against, so a
 *   change made in between (Claude Code saving it) is never overwritten
 */
export function readClaudeSettings(file = claudeSettingsFile()) {
    try {
        const [, bytes, etag] = file.load_contents(null);
        const settings = JSON.parse(new TextDecoder().decode(bytes));
        if (typeof settings !== 'object' || settings === null || Array.isArray(settings))
            return {settings: null, error: 'not a JSON object', etag};
        return {settings, error: null, etag};
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return {settings: null, error: null, etag: NO_FILE};
        return {settings: null, error: e.message, etag: NO_FILE};
    }
}

/**
 * Adds Froonty's status line, keeping everything else in the file.
 *
 * @returns {?string} null when done, or why not
 */
export function installStatusLine(file = claudeSettingsFile(), script = scriptPath()) {
    const {settings, error, etag} = readClaudeSettings(file);
    if (error)
        return error;
    if (statusLineState(settings) === 'other')
        return 'Claude Code already has a status line';
    return saveClaudeSettings(file, {...settings ?? {}, statusLine: statusLineEntry(script)}, etag);
}

/**
 * Removes Froonty's status line; any other one is left alone.
 *
 * @returns {?string} null when done, or why not
 */
export function removeStatusLine(file = claudeSettingsFile()) {
    const {settings, error, etag} = readClaudeSettings(file);
    if (error)
        return error;
    if (statusLineState(settings) !== 'ours')
        return null;
    const {statusLine: _ours, ...rest} = settings;
    return saveClaudeSettings(file, rest, etag);
}

// The etag of "there was no file": GLib compares a non-null etag with an
// existing file's, and a local file's ("seconds:microseconds") never
// equals this, so a file that appeared since the read is not overwritten.
const NO_FILE = 'none';
const MAX_LINKS = 32;

const isError = (e, code) => e?.matches?.(Gio.IOErrorEnum, code);

// The file a write replaces: settings.json, or the file its symbolic link
// (or chain of links, as dotfiles managers make) points to. GLib's replace
// would otherwise rewrite a link's target in place: truncated, then
// written, with no temporary file.
function realFile(file) {
    let current = file;
    for (let i = 0; i < MAX_LINKS; i++) {
        let info;
        try {
            info = current.query_info('standard::type,standard::symlink-target',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        } catch (e) {
            if (isError(e, Gio.IOErrorEnum.NOT_FOUND))
                return current;
            throw e;
        }
        if (info.get_file_type() !== Gio.FileType.SYMBOLIC_LINK)
            return current;
        current = current.get_parent().resolve_relative_path(info.get_symlink_target());
    }
    throw new Error('too many levels of symbolic links');
}

/**
 * Writes Claude Code's settings as a whole new file renamed onto the old
 * one (Gio's replace): never a half-written file, as Claude Code itself
 * writes it. Also used by the attention bar's hook set-up
 * (attentionSetup.js).
 *
 * - A symbolic link is followed: the file it points to is replaced, the
 *   link stays.
 * - A file with more than one hard link is refused: GLib would rewrite it
 *   in place, and replacing it would cut it off from its other names.
 * - `etag` (readClaudeSettings()) must still match: when Claude Code saved
 *   the file since it was read, nothing is written ("try again").
 * - Without a file, a new one is made in place (there is nothing to lose),
 *   unless one appeared since the read.
 *
 * @param {Gio.File} file
 * @param {object} settings
 * @param {?string} etag from readClaudeSettings(); null: no check
 * @returns {?string} null when done, or why not
 */
export function saveClaudeSettings(file, settings, etag = null) {
    try {
        const target = realFile(file);
        if (target === file) {
            try {
                file.get_parent().make_directory_with_parents(null);
            } catch (e) {
                if (!isError(e, Gio.IOErrorEnum.EXISTS))
                    throw e;
            }
        }
        let links = 1;
        try {
            links = target.query_info('unix::nlink', Gio.FileQueryInfoFlags.NONE, null)
                .get_attribute_uint32('unix::nlink');
        } catch (e) {
            if (!isError(e, Gio.IOErrorEnum.NOT_FOUND))
                throw e;
        }
        if (links > 1)
            return `${target.get_path()} has more than one hard link; Froonty only replaces a file whole, so it leaves this one alone`;
        target.replace_contents(new TextEncoder().encode(`${JSON.stringify(settings, null, 2)}\n`),
            etag, false, Gio.FileCreateFlags.PRIVATE, null);
        return null;
    } catch (e) {
        if (isError(e, Gio.IOErrorEnum.WRONG_ETAG))
            return 'it changed since Froonty read it (Claude Code may have saved it); nothing was written, try again';
        return e.message;
    }
}
