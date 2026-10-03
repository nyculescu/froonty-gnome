// SPDX-License-Identifier: GPL-3.0-or-later
// Adds or removes Froonty's hooks in Claude Code's user settings, from
// Froonty's settings window (prefs.js), only on the user's click
// (docs/features/claude-attention.md §5). Never inside a group of the
// user's: Froonty's handlers sit in groups of their own, appended after
// the user's, and only exactly those are removed again. GLib only, so it
// runs in the preferences process and in plain gjs unit tests.
//
// Claude Code reads `hooks` from $CLAUDE_CONFIG_DIR/settings.json or
// ~/.claude/settings.json (code.claude.com/docs/en/hooks) and picks up a
// change on its own.

import GLib from 'gi://GLib';

import {HOOK_EVENTS} from './attention.js';
import {hookScriptPath} from './attentionHook.js';
import {claudeSettingsFile, readClaudeSettings, saveClaudeSettings} from './statusLineSetup.js';

export {hookScriptPath};

const SCRIPT_SUFFIX = '/froonty@catalin/features/claude/attentionHook.js';

/**
 * Deletes this session's state file, with no output and exit 0 even when
 * it or its folder is missing. It runs after each prompt and each model
 * step, so it is plain `sh` (dash on Ubuntu) rather than a GJS process.
 */
export const CLEAR_COMMAND = 'case "$CLAUDE_CODE_SESSION_ID" in ""|*[!0-9A-Za-z-]*) ;; ' +
    '*) rm -f -- "${XDG_RUNTIME_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}}/froonty/claude-attention/' +
    '$CLAUDE_CODE_SESSION_ID.json" ;; esac';

/** Exact names only (letters, digits and `_|`): a list, not a pattern. */
export const NOTIFICATION_MATCHER = [
    'permission_prompt', 'worker_permission_prompt', 'elicitation_dialog',
    'elicitation_url_dialog', 'elicitation_complete', 'elicitation_response',
    'agent_needs_input', 'idle_prompt', 'quota_auto_resume_stale',
].join('|');

/** Claude Code's events, in the order new keys are added. */
export const HOOK_KEYS = ['Notification', 'Stop', 'StopFailure', 'UserPromptSubmit', 'PostToolBatch', 'SessionEnd'];

/**
 * gjs, by an absolute path. /usr/bin first: other toolchains may shadow
 * system tools on PATH (the Makefile notes the same), and a fixed path
 * keeps the entries identical from one Set up to the next.
 */
export function gjsPath() {
    if (GLib.file_test('/usr/bin/gjs', GLib.FileTest.IS_EXECUTABLE))
        return '/usr/bin/gjs';
    return GLib.find_program_in_path('gjs') ?? '/usr/bin/gjs';
}

const gjsHandler = (gjs, script, event) =>
    ({type: 'command', command: gjs, args: ['-m', script, event], async: true});

/**
 * The groups Froonty adds, one per event.
 *
 * @returns {Object<string, {matcher?: string, hooks: object[]}>}
 */
export function attentionGroups(gjs = gjsPath(), script = hookScriptPath()) {
    return {
        Notification: {matcher: NOTIFICATION_MATCHER, hooks: [gjsHandler(gjs, script, 'notification')]},
        Stop: {hooks: [gjsHandler(gjs, script, 'stop')]},
        StopFailure: {hooks: [gjsHandler(gjs, script, 'stop-failure')]},
        UserPromptSubmit: {hooks: [{type: 'command', command: CLEAR_COMMAND, async: true}]},
        PostToolBatch: {hooks: [{type: 'command', command: CLEAR_COMMAND, async: true}]},
        // Synchronous: an async hook may be killed while the session ends.
        // No timeout, so it does not raise SessionEnd's shared 1.5 s budget.
        SessionEnd: {hooks: [{type: 'command', command: CLEAR_COMMAND}]},
    };
}

const basename = path => path.slice(path.lastIndexOf('/') + 1);

/**
 * Whether a hook handler is one Froonty writes, from any copy of Froonty:
 * the exact clear command, or gjs running a Froonty attentionHook.js with
 * one of its events. A command of the user's that merely runs the script
 * among other things is theirs.
 */
export function isOursHandler(h) {
    if (typeof h !== 'object' || h === null || h.type !== 'command' || typeof h.command !== 'string')
        return false;
    if (h.command === CLEAR_COMMAND)
        return true;
    return ['gjs', 'gjs-console'].includes(basename(h.command)) &&
        Array.isArray(h.args) && h.args.length === 3 && h.args[0] === '-m' &&
        typeof h.args[1] === 'string' && h.args[1].endsWith(SCRIPT_SUFFIX) &&
        HOOK_EVENTS.includes(h.args[2]);
}

const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

// JSON with sorted keys: equal for deep-equal values.
function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    if (isPlainObject(value))
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    return JSON.stringify(value);
}

// Every handler of Froonty's in `hooks`, with where it is.
function findOurs(hooks) {
    const found = [];
    if (!isPlainObject(hooks))
        return found;
    for (const [event, groups] of Object.entries(hooks)) {
        if (!Array.isArray(groups))
            continue;
        for (const group of groups) {
            if (!isPlainObject(group) || !Array.isArray(group.hooks))
                continue;
            for (const handler of group.hooks) {
                if (isOursHandler(handler))
                    found.push({event, matcher: group.matcher, handler});
            }
        }
    }
    return found;
}

/**
 * @param {?object} settings parsed settings.json, or null without one
 * @returns {{state: 'none'|'ours'|'outdated', disableAllHooks: boolean}}
 */
export function attentionHooksState(settings, gjs = gjsPath(), script = hookScriptPath()) {
    const disableAllHooks = settings?.disableAllHooks === true;
    const ours = findOurs(settings?.hooks);
    if (ours.length === 0)
        return {state: 'none', disableAllHooks};
    const expected = attentionGroups(gjs, script);
    const exact = ours.length === HOOK_KEYS.length && HOOK_KEYS.every(event => {
        const mine = ours.filter(o => o.event === event);
        const want = expected[event];
        return mine.length === 1 &&
            canonical(mine[0].handler) === canonical(want.hooks[0]) &&
            (want.matcher === undefined
                ? mine[0].matcher === undefined || mine[0].matcher === ''
                : mine[0].matcher === want.matcher);
    });
    return {state: exact ? 'ours' : 'outdated', disableAllHooks};
}

// Drops Froonty's handlers, then the groups that this emptied, then the
// event lists this emptied, except those in `keepEvents` (install appends
// to them again, in place). Lists and groups that were empty before stay.
function withoutOurs(hooks, keepEvents = []) {
    const result = {};
    let changed = false;
    for (const [event, groups] of Object.entries(hooks)) {
        if (!Array.isArray(groups)) {
            result[event] = groups;
            continue;
        }
        let eventChanged = false;
        const kept = [];
        for (const group of groups) {
            if (!isPlainObject(group) || !Array.isArray(group.hooks) ||
                !group.hooks.some(isOursHandler)) {
                kept.push(group);
                continue;
            }
            eventChanged = true;
            const rest = group.hooks.filter(h => !isOursHandler(h));
            if (rest.length > 0)
                kept.push({...group, hooks: rest});
        }
        changed ||= eventChanged;
        if (!eventChanged)
            result[event] = groups;
        else if (kept.length > 0 || keepEvents.includes(event))
            result[event] = kept;
    }
    return {hooks: result, changed};
}

/**
 * Adds Froonty's hooks (replacing any of its own, from this or another
 * copy), keeping everything else in the file and its order.
 *
 * @returns {?string} null when done, or why not (the file is unchanged)
 */
export function installAttentionHooks(file = claudeSettingsFile(), script = hookScriptPath(),
    gjs = gjsPath()) {
    const {settings, error, etag} = readClaudeSettings(file);
    if (error)
        return error;
    const current = settings ?? {};
    if (current.hooks !== undefined && !isPlainObject(current.hooks))
        return 'hooks is not an object';
    for (const event of HOOK_KEYS) {
        if (current.hooks?.[event] !== undefined && !Array.isArray(current.hooks[event]))
            return `hooks.${event} is not a list`;
    }

    const {hooks} = withoutOurs(current.hooks ?? {}, HOOK_KEYS);
    const groups = attentionGroups(gjs, script);
    for (const event of HOOK_KEYS)
        hooks[event] = [...hooks[event] ?? [], groups[event]];
    // A new `hooks` goes last; an existing one keeps its place.
    return saveClaudeSettings(file, {...current, hooks}, etag);
}

/**
 * Removes Froonty's hooks only; written only if something was removed.
 *
 * @returns {?string} null when done (or nothing to do), or why not
 */
export function removeAttentionHooks(file = claudeSettingsFile()) {
    const {settings, error, etag} = readClaudeSettings(file);
    if (error)
        return error;
    if (!isPlainObject(settings?.hooks))
        return null;
    const {hooks, changed} = withoutOurs(settings.hooks);
    if (!changed)
        return null;
    const next = {...settings, hooks};
    // Left empty by this removal: dropped, as when it was not there.
    if (Object.keys(hooks).length === 0)
        delete next.hooks;
    return saveClaudeSettings(file, next, etag);
}
