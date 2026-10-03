// SPDX-License-Identifier: GPL-3.0-or-later
// Froonty's Claude Code hook script (docs/features/claude-attention.md).
// Claude Code runs it, never the Shell, after "Set up" in Settings →
// Claude (attentionSetup.js):
//
//   /usr/bin/gjs -m <this file> notification|stop|stop-failure
//
// with the event's JSON on stdin, in the background (`async: true`), so it
// never holds Claude up. It writes one small file per session under
// $XDG_RUNTIME_DIR/froonty/claude-attention/, which Froonty's bar watches
// (features/claude/attentionService.js), or deletes it.
//
// It only records what the bar needs: a kind (permission, finished…), the
// time, the session id, Claude Code's entrypoint, the project folder's name
// and the process ids that lead to its window. Never the message, the
// prompt, a path, a tool or anything Claude said.
//
// It prints nothing to stdout: an async hook's JSON output would reach
// Claude. It always exits 0.
//
// Imported (by attentionSetup.js, for this file's path), it does nothing:
// it only runs as the program gjs was started with.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GioUnix from 'gi://GioUnix';
import System from 'system';

import {
    DESKTOP_RE, ENTRYPOINTS, HOOK_EVENTS, MAX_INPUT, MAX_PIDS, SESSION_RE,
    actionFor, parseProcStat, projectName, serializeEntry, stateDir,
} from './attention.js';

const CHUNK = 65536;
const SCRIPT_NAME = 'attentionHook.js';

/** This file: what Set up asks Claude Code to run. */
export function hookScriptPath() {
    return Gio.File.new_for_uri(import.meta.url).get_path();
}

const isRealDir = file => file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) ===
    Gio.FileType.DIRECTORY;

// Claude Code's JSON on stdin, at most MAX_INPUT bytes kept (the rest is
// read and dropped, so Claude Code never writes into a closed pipe); {}
// when it is not a JSON object.
function readInput() {
    const stream = GioUnix.InputStream.new(0, false);
    const chunks = [];
    let kept = 0;
    let truncated = false;
    try {
        for (;;) {
            const bytes = stream.read_bytes(CHUNK, null);
            const size = bytes.get_size();
            if (size === 0)
                break;
            if (kept + size <= MAX_INPUT) {
                chunks.push(bytes.toArray());
                kept += size;
            } else {
                truncated = true;
            }
        }
    } catch {
        return {};
    }
    if (truncated)
        return {};
    const all = new Uint8Array(kept);
    let offset = 0;
    for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.length;
    }
    try {
        const input = JSON.parse(new TextDecoder().decode(all));
        return typeof input === 'object' && input !== null && !Array.isArray(input) ? input : {};
    } catch {
        return {};
    }
}

const validSession = id => typeof id === 'string' && SESSION_RE.test(id) ? id : null;

function procStat(pid) {
    try {
        const [, bytes] = GLib.file_get_contents(`/proc/${pid}/stat`);
        return parseProcStat(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}

// Claude Code (CLAUDE_PID, or this script's parent in exec form) and its
// ancestors, each with its start time, so the Shell can tell a reused
// process id from the same process and find the window it belongs to.
function processChain() {
    const claudePid = Number(GLib.getenv('CLAUDE_PID'));
    let pid = Number.isSafeInteger(claudePid) && claudePid > 1
        ? claudePid
        : procStat('self')?.ppid ?? 0;
    const pids = [];
    while (pid > 1 && pids.length < MAX_PIDS) {
        const stat = procStat(pid);
        if (!stat)
            break;
        pids.push([pid, stat.start]);
        pid = stat.ppid;
    }
    return pids;
}

// A new file renamed onto the old one: Froonty's folder monitor sees one
// MOVED_IN, never a half-written file. The temporary file is in the parent
// folder, so it never shows up in the watched one.
function writeAtomically(dir, name, text) {
    const pid = new Gio.Credentials().get_unix_pid();
    const temp = dir.get_parent().get_child(`.claude-attention-${name}.${pid}.tmp`);
    try {
        const stream = temp.create(Gio.FileCreateFlags.PRIVATE, null);
        try {
            stream.write_all(new TextEncoder().encode(text), null);
        } finally {
            stream.close(null);
        }
        temp.move(dir.get_child(`${name}.json`),
            Gio.FileCopyFlags.OVERWRITE | Gio.FileCopyFlags.NOFOLLOW_SYMLINKS |
            Gio.FileCopyFlags.NO_FALLBACK_FOR_MOVE, null, null);
    } catch (e) {
        try {
            temp.delete(null);
        } catch {}
        throw e;
    }
}

function main() {
    const [event] = System.programArgs;
    if (!HOOK_EVENTS.includes(event))
        return;

    // The folder exists only while Froonty's bar is on; this script never
    // creates it, so nothing is recorded while nobody listens.
    const dir = stateDir();
    if (!isRealDir(dir))
        return;

    const entrypoint = GLib.getenv('CLAUDE_CODE_ENTRYPOINT') ?? '';
    if (!ENTRYPOINTS.includes(entrypoint))
        return;

    const input = readInput();
    const session = validSession(input.session_id) ??
        validSession(GLib.getenv('CLAUDE_CODE_SESSION_ID'));
    if (!session)
        return;

    const action = actionFor(event, input);
    if (!action)
        return;
    if (action.clear) {
        try {
            dir.get_child(`${session}.json`).delete(null);
        } catch {}
        return;
    }

    const pids = processChain();
    if (pids.length === 0)
        return;
    const chromeDesktop = GLib.getenv('CHROME_DESKTOP');
    writeAtomically(dir, session, serializeEntry({
        kind: action.kind,
        at: Date.now(),
        session,
        entrypoint,
        project: projectName(GLib.getenv('CLAUDE_PROJECT_DIR'), input.cwd),
        pids,
        desktop: chromeDesktop && DESKTOP_RE.test(chromeDesktop) ? chromeDesktop : null,
    }));
}

if (GLib.path_get_basename(System.programPath ?? '') === SCRIPT_NAME) {
    try {
        main();
    } catch (e) {
        printerr(`Froonty: Claude attention hook: ${e.message}`);
    }
}
