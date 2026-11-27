// SPDX-License-Identifier: GPL-3.0-or-later
// Offline Markdown block rendering in a WebKitGTK helper, kept out of both
// GNOME Shell and the preferences process. The helper starts on the first
// request and stops after IDLE_MS without one, or on destroy().
//
//   new BlockRenderClient({argv?, idleMs?})
//       argv: the helper's command (tests use a stand-in); default
//       `gjs -m helper.js`
//   render({kind, source, width, uri?, baseUri?}) → Promise of
//       {png: Uint8Array, width, height, warnings: string[]}: the picture
//       (its pixel size) and what it left out of the block (a diagram line,
//       a table's cell image). Rejects with an Error whose message is a
//       short human reason when the block cannot be drawn at all.
//   running: whether a helper process is running now
//   starts: how many helpers were started (tests)

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {stopProcess} from '../../../core/subprocess.js';

Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');

const HELPER = GLib.build_filenamev([
    GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), 'helper.js']);
const MAX_SOURCE = 50000;
const RENDER_TIMEOUT_MS = 30000;
const IDLE_MS = 60000;
// How long an idle helper gets to end on its closed stdin before SIGTERM.
const STOP_GRACE_MS = 2000;
export class BlockRenderClient {
    constructor({argv = null, idleMs = IDLE_MS} = {}) {
        this._argv = argv;
        this._idleMs = idleMs;
        this._nextId = 1;
        // The helper renders one request at a time, so it is sent one at a
        // time: the timeout counts only its own rendering, and a stuck render
        // fails only itself.
        this._queue = [];
        this._current = null;
        this._proc = null;
        this._idleId = 0;
        // Idle helpers told to stop that have not ended yet.
        this._stopping = new Set();
        this._destroyed = false;
        this.starts = 0;
    }

    get running() {
        return this._proc !== null;
    }

    render(request) {
        if (this._destroyed)
            return Promise.reject(new Error('The Markdown renderer has stopped'));
        if (String(request.source ?? '').length > MAX_SOURCE)
            return Promise.reject(new Error(`Markdown block is longer than ${MAX_SOURCE} characters`));
        this._stopIdleTimer();
        return new Promise((resolve, reject) => {
            this._queue.push({request, resolve, reject});
            this._next();
        });
    }

    destroy() {
        this._destroyed = true;
        this._stopIdleTimer();
        try { this._proc?.proc.force_exit(); } catch {}
        this._proc = null;
        for (const state of this._stopping) {
            if (state.backstop)
                GLib.source_remove(state.backstop);
            state.backstop = 0;
            try { state.proc.force_exit(); } catch {}
        }
        this._stopping.clear();
        this._fail(new Error('The Markdown renderer has stopped'));
    }

    _next() {
        if (this._current || !this._queue.length)
            return;
        const proc = this._start();
        if (!proc) {
            this._fail(new Error('WebKitGTK is unavailable'));
            return;
        }
        const current = this._current = this._queue.shift();
        current.id = this._nextId++;
        current.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RENDER_TIMEOUT_MS, () => {
            current.timer = 0;
            // The helper's end (_read) rejects it and starts the next one.
            current.error = new Error('WebKit took too long to render this Markdown block');
            try { proc.proc.force_exit(); } catch {}
            return GLib.SOURCE_REMOVE;
        });
        this._write(proc, `${JSON.stringify({id: current.id, ...current.request})}\n`)
            .catch(() => {
                // The pipe closed: the helper ended, and _read handles that.
            });
    }

    async _write(proc, line) {
        const bytes = new TextEncoder().encode(line);
        let written = 0;
        while (written < bytes.length) {
            const count = await proc.stdin.write_bytes_async(
                new GLib.Bytes(bytes.subarray(written)), GLib.PRIORITY_DEFAULT, null);
            if (count < 1)
                throw new Error('The Markdown renderer pipe closed while writing');
            written += count;
        }
    }

    _finish(current) {
        if (current.timer)
            GLib.source_remove(current.timer);
        this._current = null;
    }

    _start() {
        if (this._proc)
            return this._proc;
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE,
        });
        let proc = null, lastError = null;
        const commands = this._argv ? [this._argv]
            : ['/usr/bin/gjs', 'gjs'].map(executable => [executable, '-m', HELPER]);
        for (const argv of commands) {
            try {
                proc = launcher.spawnv(argv);
                break;
            } catch (e) {
                lastError = e;
            }
        }
        if (!proc) {
            console.warn(`Froonty notes: could not start WebKit renderer: ${lastError?.message}`);
            return null;
        }
        this.starts++;
        const state = {proc, stdin: proc.get_stdin_pipe(), backstop: 0};
        const input = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
        this._proc = state;
        this._read(input, state);
        return state;
    }

    async _read(input, proc) {
        try {
            for (;;) {
                const [line] = await input.read_line_async(GLib.PRIORITY_DEFAULT, null);
                if (line === null)
                    break;
                let reply;
                try { reply = JSON.parse(new TextDecoder().decode(line)); } catch { continue; }
                const current = this._current;
                if (reply.id !== current?.id)
                    continue;
                this._finish(current);
                if (reply.error)
                    current.reject(new Error(reply.error));
                else
                    current.resolve({png: GLib.base64_decode(reply.png), width: reply.width,
                        height: reply.height, warnings: reply.warnings ?? []});
                this._next();
                this._maybeIdle();
            }
        } catch {}
        if (this._proc !== proc)
            return;
        // The helper ended (it crashed, timed out or could not load WebKit):
        // only the request it was rendering fails; the next one restarts it.
        this._proc = null;
        const current = this._current;
        if (current) {
            this._finish(current);
            current.reject(current.error ?? new Error('The WebKit renderer stopped'));
        }
        this._next();
    }

    // One-shot, armed only when the last reply left nothing to render: a
    // started helper holds tens of MB (WebKit's processes) while it waits.
    _maybeIdle() {
        if (this._current || this._queue.length || !this._proc || this._idleId)
            return;
        this._idleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._idleMs, () => {
            this._idleId = 0;
            this._stopIdle();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopIdleTimer() {
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = 0;
    }

    // Closing its stdin ends the helper's serve() loop, and WebKit's
    // processes with it; SIGTERM only if it is still there STOP_GRACE_MS later.
    _stopIdle() {
        const state = this._proc;
        if (!state)
            return;
        // First, so _read takes the helper's end for this stop, not a crash.
        this._proc = null;
        try { state.stdin.close(null); } catch {}
        // Kept in _stopping until it has ended, so destroy() can still
        // force_exit it after SIGTERM.
        this._stopping.add(state);
        state.backstop = GLib.timeout_add(GLib.PRIORITY_DEFAULT, STOP_GRACE_MS, () => {
            state.backstop = 0;
            stopProcess(state.proc, 'The Markdown renderer', 2);
            return GLib.SOURCE_REMOVE;
        });
        state.proc.wait_async(null, () => {
            if (state.backstop)
                GLib.source_remove(state.backstop);
            state.backstop = 0;
            this._stopping.delete(state);
        });
    }

    _fail(error) {
        const current = this._current;
        if (current)
            this._finish(current);
        for (const item of [current, ...this._queue].filter(Boolean))
            item.reject(error);
        this._queue = [];
    }
}
