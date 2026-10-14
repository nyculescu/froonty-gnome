// SPDX-License-Identifier: GPL-3.0-or-later
// Offline Markdown block rendering in a WebKitGTK helper, kept out of both
// GNOME Shell and the preferences process.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');

const HELPER = GLib.build_filenamev([
    GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), 'helper.js']);
// These are launched/read as runtime files, not imported into GNOME Shell.
// pack-public/prune.py keeps the helper and image picker from these.
// pack:asset ./helper.js
// pack:asset ./image-picker.js
// pack:asset ./image-picker-helper.js
const MAX_SOURCE = 50000;
const RENDER_TIMEOUT_MS = 30000;
export class BlockRenderClient {
    constructor() {
        this._nextId = 1;
        this._pending = new Map();
        this._proc = null;
        this._writing = Promise.resolve();
        this._destroyed = false;
    }

    render(request) {
        if (this._destroyed)
            return Promise.reject(new Error('The Markdown renderer has stopped'));
        if (String(request.source ?? '').length > MAX_SOURCE)
            return Promise.reject(new Error(`Markdown block is longer than ${MAX_SOURCE} characters`));
        const proc = this._start();
        if (!proc)
            return Promise.reject(new Error('WebKitGTK is unavailable'));
        const id = this._nextId++;
        return new Promise((resolve, reject) => {
            const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RENDER_TIMEOUT_MS, () => {
                const pending = this._pending.get(id);
                if (pending) {
                    this._pending.delete(id);
                    pending.reject(new Error('WebKit took too long to render this Markdown block'));
                    try { this._proc?.proc.force_exit(); } catch {}
                }
                return GLib.SOURCE_REMOVE;
            });
            this._pending.set(id, {resolve, reject, timer});
            const bytes = new TextEncoder().encode(`${JSON.stringify({id, ...request})}\n`);
            this._writing = this._writing.then(async () => {
                let written = 0;
                while (written < bytes.length) {
                    const count = await proc.stdin.write_bytes_async(
                        new GLib.Bytes(bytes.subarray(written)), GLib.PRIORITY_DEFAULT, null);
                    if (count < 1)
                        throw new Error('The Markdown renderer pipe closed while writing');
                    written += count;
                }
            }).catch(e => this._fail(e));
        });
    }

    destroy() {
        this._destroyed = true;
        try { this._proc?.proc.force_exit(); } catch {}
        this._proc = null;
        this._fail(new Error('The Markdown renderer has stopped'));
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
                const pending = this._pending.get(reply.id);
                if (!pending)
                    continue;
                this._pending.delete(reply.id);
                GLib.source_remove(pending.timer);
                if (reply.error)
                    pending.reject(new Error(reply.error));
                else
                    pending.resolve({png: GLib.base64_decode(reply.png), width: reply.width,
                        height: reply.height});
            }
        } catch (e) {
            if (!this._destroyed)
                this._fail(e);
        }
        if (this._proc === proc) {
            this._proc = null;
            this._fail(new Error('The WebKit renderer stopped'));
        }
    }

    _fail(error) {
        for (const pending of this._pending.values()) {
            GLib.source_remove(pending.timer);
            pending.reject(error);
        }
        this._pending.clear();
    }
}
