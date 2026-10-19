// SPDX-License-Identifier: GPL-3.0-or-later
// Offline Markdown block rendering in a WebKitGTK helper, kept out of both
// GNOME Shell and the preferences process.
//
//   render({kind, source, width, uri?, baseUri?}) → Promise of
//       {png: Uint8Array, width, height, warnings: string[]}: the picture
//       (its pixel size) and what it left out of the block (a diagram line,
//       a table's cell image). Rejects with an Error whose message is a
//       short human reason when the block cannot be drawn at all.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');

const HELPER = GLib.build_filenamev([
    GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), 'helper.js']);
const MAX_SOURCE = 50000;
const RENDER_TIMEOUT_MS = 30000;
export class BlockRenderClient {
    constructor() {
        this._nextId = 1;
        // The helper renders one request at a time, so it is sent one at a
        // time: the timeout counts only its own rendering, and a stuck render
        // fails only itself.
        this._queue = [];
        this._current = null;
        this._proc = null;
        this._destroyed = false;
    }

    render(request) {
        if (this._destroyed)
            return Promise.reject(new Error('The Markdown renderer has stopped'));
        if (String(request.source ?? '').length > MAX_SOURCE)
            return Promise.reject(new Error(`Markdown block is longer than ${MAX_SOURCE} characters`));
        return new Promise((resolve, reject) => {
            this._queue.push({request, resolve, reject});
            this._next();
        });
    }

    destroy() {
        this._destroyed = true;
        try { this._proc?.proc.force_exit(); } catch {}
        this._proc = null;
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
        for (const executable of ['/usr/bin/gjs', 'gjs']) {
            try {
                proc = launcher.spawnv([executable, '-m', HELPER]);
                break;
            } catch (e) {
                lastError = e;
            }
        }
        if (!proc) {
            console.warn(`Froonty notes: could not start WebKit renderer: ${lastError?.message}`);
            return null;
        }
        const state = {proc, stdin: proc.get_stdin_pipe()};
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

    _fail(error) {
        const current = this._current;
        if (current)
            this._finish(current);
        for (const item of [current, ...this._queue].filter(Boolean))
            item.reject(error);
        this._queue = [];
    }
}
