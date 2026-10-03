// SPDX-License-Identifier: GPL-3.0-or-later
// "When Claude needs you" (docs/features/claude-attention.md): what the
// hook script, the Shell side, the settings window and the tests share.
// Pure logic and constants; only Gio and GLib, so it loads in the hook
// script (plain gjs, outside the Shell), in the Shell, in the preferences
// process and in the unit tests. Nothing here runs at module load.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const RUNTIME_SUBDIR = 'froonty';
export const STATE_DIR_NAME = 'claude-attention';
/** The hook script's argument (argv[0]), one per Claude Code event. */
export const HOOK_EVENTS = ['notification', 'stop', 'stop-failure'];
/** Priority order: index 0 is shown first. */
export const KINDS = ['permission', 'input', 'error', 'attention', 'waiting', 'finished'];
/**
 * Claude Code's CLAUDE_CODE_ENTRYPOINT values whose sessions a person sits
 * in front of ('' when unset). Others (sdk-*: `claude -p`, Froonty's own
 * /usage run included; mcp; remote*; the GitHub Action) are never recorded.
 */
export const ENTRYPOINTS = ['', 'cli', 'claude-vscode', 'claude-desktop', 'claude-desktop-3p', 'local-agent'];
/** Sessions hosted by the Claude app (its Code tab). */
export const APP_ENTRYPOINTS = ['claude-desktop', 'claude-desktop-3p', 'local-agent'];
/** Sessions in a terminal (`claude` started by hand; '' when unset). */
export const TERMINAL_ENTRYPOINTS = ['', 'cli'];
/** A reply's end: finished, or stopped by an error. */
export const FINISHED_KINDS = ['finished', 'error'];
/** Claude waits for an answer: a permission, or a question. */
export const ANSWER_KINDS = ['permission', 'input'];
export const CLAUDE_APP_ID = 'com.anthropic.Claude.desktop';
export const SESSION_RE = /^[0-9A-Za-z-]{1,128}$/;
export const FILE_RE = /^([0-9A-Za-z-]{1,128})\.json$/;
export const DESKTOP_RE = /^[A-Za-z0-9._-]{1,128}\.desktop$/;
export const MAX_FILE = 4096;
export const MAX_ENTRIES = 64;
export const MAX_PIDS = 16;
export const MAX_PROJECT = 128;
export const MAX_INPUT = 16 << 20;

/**
 * The folder of per-session state files. GLib falls back to the cache
 * folder without XDG_RUNTIME_DIR, as the clear command does.
 *
 * @returns {Gio.File}
 */
export function stateDir() {
    return Gio.File.new_for_path(GLib.build_filenamev(
        [GLib.get_user_runtime_dir(), RUNTIME_SUBDIR, STATE_DIR_NAME]));
}

// Claude Code's notification_type → what the bar says. Only the mapped
// kind is ever written down, never the type or the message.
const NOTIFICATION_KINDS = {
    permission_prompt: 'permission',
    worker_permission_prompt: 'permission',
    elicitation_dialog: 'input',
    elicitation_url_dialog: 'input',
    agent_needs_input: 'input',
    idle_prompt: 'waiting',
    quota_auto_resume_stale: 'waiting',
};
const NOTIFICATION_CLEARS = ['elicitation_complete', 'elicitation_response'];

const nonEmptyArray = value => Array.isArray(value) && value.length > 0;

/**
 * What a Claude Code event means for its session.
 *
 * @param {string} event one of HOOK_EVENTS
 * @param {object} input the hook's JSON input ({} when unreadable)
 * @returns {?({kind: string}|{clear: true})} null: nothing to do
 */
export function actionFor(event, input) {
    switch (event) {
    case 'notification': {
        const type = input?.notification_type;
        if (typeof type !== 'string')
            return null;
        if (Object.hasOwn(NOTIFICATION_KINDS, type))
            return {kind: NOTIFICATION_KINDS[type]};
        return NOTIFICATION_CLEARS.includes(type) ? {clear: true} : null;
    }
    case 'stop':
        // Paused, waiting for background work or a scheduled wake-up to
        // continue it: not done.
        if (nonEmptyArray(input?.background_tasks) || nonEmptyArray(input?.session_crons))
            return {clear: true};
        return {kind: 'finished'};
    case 'stop-failure':
        return {kind: 'error'};
    default:
        return null;
    }
}

/**
 * A /proc/<pid>/stat line: the fields after the command name, which may
 * itself hold spaces and parentheses.
 *
 * @param {string} text
 * @returns {?{ppid: number, start: number}}
 */
export function parseProcStat(text) {
    if (typeof text !== 'string')
        return null;
    const close = text.lastIndexOf(')');
    if (close < 0)
        return null;
    // Field 3 (state) onwards.
    const fields = text.slice(close + 1).trim().split(/\s+/);
    const ppid = fields[1];
    const start = fields[19];
    if (!/^\d+$/.test(ppid ?? '') || !/^\d+$/.test(start ?? ''))
        return null;
    return {ppid: Number(ppid), start: Number(start)};
}

const codePoints = text => [...text];

/**
 * The project's folder name (never its path): CLAUDE_PROJECT_DIR, else
 * the session's cwd; '' for "/" or ".". Control characters are dropped and
 * it is cut to MAX_PROJECT code points.
 *
 * @param {?string} projectDir
 * @param {?string} cwd
 * @returns {string}
 */
export function projectName(projectDir, cwd) {
    const path = [projectDir, cwd].find(p => typeof p === 'string' && p !== '') ?? '';
    const trimmed = path.replace(/\/+$/, '');
    let base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
    if (base === '.')
        base = '';
    base = base.replace(/\p{Cc}/gu, '').trim();
    return codePoints(base).slice(0, MAX_PROJECT).join('').trim();
}

/**
 * The state file's text (section 6 of the feature doc).
 *
 * @param {object} e {kind, at, session, entrypoint, project, pids, desktop?}
 * @returns {string}
 */
export function serializeEntry(e) {
    const data = {
        v: 1,
        kind: e.kind,
        at: e.at,
        session: e.session,
        entrypoint: e.entrypoint,
        project: e.project,
        pids: e.pids,
    };
    if (e.desktop)
        data.desktop = e.desktop;
    return JSON.stringify(data);
}

const isPidPair = pair => Array.isArray(pair) && pair.length === 2 &&
    Number.isSafeInteger(pair[0]) && pair[0] > 1 &&
    Number.isSafeInteger(pair[1]) && pair[1] >= 0;

/**
 * Reads a state file, checking every field; unknown extra fields are
 * ignored.
 *
 * @param {string|Uint8Array} text the file's contents
 * @param {string} stem the file name without ".json"
 * @returns {?object} a frozen entry, or null when anything is off
 */
export function parseEntry(text, stem) {
    let data;
    try {
        const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
        if (!(bytes instanceof Uint8Array) || bytes.length > MAX_FILE)
            return null;
        data = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    } catch {
        return null;
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data))
        return null;
    const {v, kind, at, session, entrypoint, project, pids, desktop} = data;
    if (v !== 1 || !KINDS.includes(kind) || typeof at !== 'number' || !Number.isFinite(at))
        return null;
    if (typeof session !== 'string' || session !== stem || !SESSION_RE.test(session))
        return null;
    if (typeof entrypoint !== 'string' || !ENTRYPOINTS.includes(entrypoint))
        return null;
    if (typeof project !== 'string' || codePoints(project).length > MAX_PROJECT ||
        /\p{Cc}/u.test(project))
        return null;
    if (!Array.isArray(pids) || pids.length < 1 || pids.length > MAX_PIDS || !pids.every(isPidPair))
        return null;
    if (desktop !== undefined && (typeof desktop !== 'string' || !DESKTOP_RE.test(desktop)))
        return null;
    return Object.freeze({
        v, kind, at, session, entrypoint, project,
        pids: Object.freeze(pids.map(pair => Object.freeze([...pair]))),
        desktop: desktop ?? null,
    });
}

/**
 * The Claude app's own notification text (English; its exact wording is
 * not verified, see the feature doc's manual checks).
 *
 * @param {string} body plain text
 * @returns {string} one of KINDS
 */
export function appNotificationKind(body) {
    const text = typeof body === 'string' ? body.trim() : '';
    if (/^Allow\b/.test(text))
        return 'permission';
    if (/waiting for your input/i.test(text))
        return 'waiting';
    if (/\bfinished\b/i.test(text))
        return 'finished';
    return 'attention';
}

/** Whether a browser's notification is about claude.ai. */
export function mentionsClaudeAi(title, body) {
    return [title, body].some(text => typeof text === 'string' && /claude\.ai/i.test(text));
}

// VS Code: "file.js - Froonty - Visual Studio Code"; terminals vary.
const TITLE_SEPARATOR = /\s[-—–]\s/;

/**
 * Which of an app's windows a session runs in, from their titles (in the
 * app's order, most recent first) and the project's folder name.
 *
 * Known for sure ("exact") only when the app has one window, or when
 * exactly one title has a part (split on " - ", " — ", " – ") equal to the
 * project. A title that merely contains the project (a shell's
 * "user@host: ~/src/Froonty") is a guess: it is picked, but not for sure.
 * Several windows and no match: the most recent, not for sure.
 *
 * @param {Array<?string>} titles
 * @param {string} project
 * @returns {?{index: number, exact: boolean}} null without windows
 */
export function pickWindow(titles, project) {
    if (!Array.isArray(titles) || titles.length === 0)
        return null;
    if (titles.length === 1)
        return {index: 0, exact: true};
    if (typeof project !== 'string' || project === '')
        return {index: 0, exact: false};
    const where = test => titles.flatMap((title, index) => test(title ?? '') ? [index] : []);
    const named = where(title => title.split(TITLE_SEPARATOR).some(part => part.trim() === project));
    if (named.length > 0)
        return {index: named[0], exact: named.length === 1};
    const [containing = 0] = where(title => title.includes(project));
    return {index: containing, exact: false};
}

/**
 * Whether a state file is dropped on arrival when the user already looks
 * at the session's own window (known for sure, and focused).
 *
 * A finished reply or an error, in any host. In a terminal, nothing else:
 * Claude Code sends a permission, a question or an idle prompt only after
 * about 6 s or 60 s in which nobody typed into it, whatever has the focus,
 * and a terminal's tabs are invisible to Froonty, so a focused terminal
 * window says nothing about whether that Claude Code is on screen.
 *
 * @param {{kind: string, entrypoint: string}} record
 * @returns {boolean}
 */
export function quietWhileLooking(record) {
    return FINISHED_KINDS.includes(record.kind) || !TERMINAL_ENTRYPOINTS.includes(record.entrypoint);
}

/**
 * Whether the focus moving to any window of the session's app clears an
 * entry whose own window is not known for sure: the user went there,
 * most likely to answer. Answering is not an event of Claude Code's, and
 * the next one (PostToolBatch) waits for the approved tool to finish.
 * Finished replies and idle prompts clear only on their own window.
 *
 * @param {string} kind
 * @returns {boolean}
 */
export function clearedByAppFocus(kind) {
    return ANSWER_KINDS.includes(kind);
}

/** Bar order: by KINDS, then newest first, then id. */
export function compareEntries(a, b) {
    const kind = KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind);
    if (kind !== 0)
        return kind;
    if (a.at !== b.at)
        return b.at - a.at;
    if (a.id === b.id)
        return 0;
    return a.id < b.id ? -1 : 1;
}

/**
 * The host a hook entry's session runs in when its window's app is not
 * known (product names, not translated).
 *
 * @param {string} entrypoint
 * @returns {string}
 */
export function hostName(entrypoint) {
    if (entrypoint === 'claude-vscode')
        return 'VS Code';
    if (APP_ENTRYPOINTS.includes(entrypoint))
        return 'Claude';
    return 'Claude Code';
}

/**
 * The bar's second label: where the session waits.
 *
 * @param {object} entry an AttentionService entry
 * @returns {string}
 */
export function placeText(entry) {
    switch (entry.origin) {
    case 'hook':
        return [entry.project, entry.appName ?? hostName(entry.entrypoint)]
            .filter(Boolean).join(' · ');
    case 'app':
        return [entry.title, 'Claude'].filter(Boolean).join(' · ');
    default:
        return entry.appName ?? '';
    }
}
