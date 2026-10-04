// SPDX-License-Identifier: GPL-3.0-or-later
// Rendering formulas without waiting for them (docs/features/formulas.md
// §4): requests go to the helper process (helper.js) over its stdin, and
// replies come back on its stdout, read asynchronously. Gio and GLib only,
// no St or Gtk, so GNOME Shell and the settings window can both use it.
//
// - The helper starts on the first request, and stops after IDLE_MS
//   without any, or on destroy().
// - Results are kept in a small LRU cache by (tex, display, color, scale);
//   equal requests in flight share one answer.
// - A request on a channel (the tab's preview, say) supersedes the one
//   before it on that channel: the older one is rejected at once
//   ('superseded'), and its reply, when it comes, only fills the cache.
// - A helper that dies is started again, after a growing pause, and what
//   it was working on is sent again once; one that takes longer than
//   TIMEOUT_MS on a formula is stopped, and that formula fails.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {stopProcess} from '../../../core/subprocess.js';

Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_all_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');

export const IDLE_MS = 60000;
export const TIMEOUT_MS = 10000;
export const CACHE_SIZE = 200;
// Pauses before starting a helper that died, growing with each death in a
// row, up to the last.
export const RESTART_DELAYS_MS = [200, 1000, 5000, 20000];
const HELPER_PATH = GLib.build_filenamev([
    GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), 'helper.js']);
// gjs from the system first: other toolchains may put their own gjs (or
// something else named so) earlier on PATH.
const GJS = ['/usr/bin/gjs', 'gjs'];

/** Why a render failed. kind: 'tex', 'unavailable', 'superseded', 'timeout', 'crashed', 'stopped', 'request'. */
export class RenderError extends Error {
    constructor(kind, message) {
        super(message);
        this.kind = kind;
    }
}

/** The fetched MathJax tree's folder (tools/fetch-mathjax.py). */
export function defaultMathJaxDir() {
    return GLib.build_filenamev([GLib.path_get_dirname(HELPER_PATH),
        '..', '..', '..', 'third_party', 'mathjax']);
}

/**
 * Whether MathJax was fetched (`make mathjax`), without blocking.
 *
 * @param {string} [dir]
 * @returns {Promise<boolean>}
 */
export async function isMathJaxFetched(dir = defaultMathJaxDir()) {
    try {
        await Gio.File.new_for_path(GLib.build_filenamev([dir, 'fetched.json']))
            .query_info_async('standard::type', Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT, null);
        return true;
    } catch (e) {
        return false;
    }
}

const cacheKey = ({tex, display, color, scale}) =>
    JSON.stringify([tex, Boolean(display), color, scale]);

export class MathRenderClient {
    /**
     * @param {object} [options]
     * @param {string[]} [options.argv] the helper's command (tests use a
     *   stand-in); default `gjs -m helper.js`
     * @param {object} [options.env] extra environment for the helper
     * @param {number} [options.idleMs]
     * @param {number} [options.timeoutMs]
     * @param {number} [options.cacheSize]
     * @param {number[]} [options.restartDelaysMs]
     */
    constructor({argv = null, env = {}, idleMs = IDLE_MS, timeoutMs = TIMEOUT_MS,
        cacheSize = CACHE_SIZE, restartDelaysMs = RESTART_DELAYS_MS} = {}) {
        this._argv = argv;
        this._env = env;
        this._idleMs = idleMs;
        this._timeoutMs = timeoutMs;
        this._cacheSize = cacheSize;
        this._restartDelaysMs = restartDelaysMs;

        this._cache = new Map(); // key → result, oldest first
        this._waiting = new Map(); // key → {request, callers, tries}
        this._sent = new Map(); // id → key, in order
        this._channels = new Map(); // channel → {key, caller}
        this._nextId = 1;
        this._helper = null;
        this._crashes = 0;
        this._restartId = 0;
        this._idleId = 0;
        this._timeoutId = 0;
        this._destroyed = false;
        // How many helpers were started (tests).
        this.starts = 0;
    }

    /** Whether a helper process is running now. */
    get running() {
        return this._helper !== null;
    }

    /**
     * @param {object} request
     * @param {string} request.tex
     * @param {boolean} [request.display]
     * @param {string} [request.color] '#rrggbb' or '#rrggbbaa'
     * @param {number} [request.scale]
     * @param {object} [options]
     * @param {string} [options.channel] supersedes the channel's previous
     *   request
     * @returns {Promise<{png: GLib.Bytes, width: number, height: number, baseline: number}>}
     * @throws {RenderError}
     */
    render({tex, display = false, color = '#000000', scale = 1}, {channel = null} = {}) {
        if (this._destroyed)
            return Promise.reject(new RenderError('stopped', 'The renderer is stopped'));
        const request = {tex, display: Boolean(display), color, scale};
        const key = cacheKey(request);
        if (channel !== null)
            this._supersede(channel);

        const cached = this._cache.get(key);
        if (cached) {
            // Most recently used last.
            this._cache.delete(key);
            this._cache.set(key, cached);
            return cached.error
                ? Promise.reject(new RenderError('tex', cached.error)) : Promise.resolve(cached);
        }

        return new Promise((resolve, reject) => {
            const caller = {resolve, reject};
            if (channel !== null)
                this._channels.set(channel, {key, caller});
            const waiting = this._waiting.get(key);
            if (waiting) {
                waiting.callers.add(caller);
                return;
            }
            this._waiting.set(key, {request, callers: new Set([caller]), tries: 0});
            this._stopIdleTimer();
            this._send(key);
        });
    }

    /** Stops the helper and fails what is waiting; the client is done. */
    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._clearTimers();
        this._stopProcess();
        for (const key of [...this._waiting.keys()])
            this._fail(key, new RenderError('stopped', 'The renderer is stopped'));
        this._channels.clear();
        this._cache.clear();
    }

    _supersede(channel) {
        const previous = this._channels.get(channel);
        if (!previous)
            return;
        this._channels.delete(channel);
        const waiting = this._waiting.get(previous.key);
        if (waiting?.callers.delete(previous.caller))
            previous.caller.reject(new RenderError('superseded', 'A newer formula replaced this one'));
        // Its reply still fills the cache when it comes.
    }

    _send(key) {
        if (this._restartId)
            return; // sent once the helper starts again
        const helper = this._helper ?? this._start();
        if (!helper)
            return;
        const waiting = this._waiting.get(key);
        const id = this._nextId++;
        this._sent.set(id, key);
        waiting.tries++;
        const line = new TextEncoder().encode(`${JSON.stringify({id, ...waiting.request})}\n`);
        // Writes are queued, in order, on the helper's stdin.
        helper.writing = helper.writing
            .then(() => helper.stdin.write_all_async(line, GLib.PRIORITY_DEFAULT, helper.cancellable))
            .catch(e => {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`Froonty: math renderer: ${e.message}`);
            });
        if (!this._timeoutId)
            this._armTimeout();
    }

    // Starts the helper; null (and every waiting request failed) when it
    // cannot run at all.
    _start() {
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE,
        });
        for (const [name, value] of Object.entries(this._env))
            launcher.setenv(name, value, true);
        let proc = null, lastError = null;
        for (const argv of this._argv ? [this._argv] : GJS.map(gjs => [gjs, '-m', HELPER_PATH])) {
            try {
                proc = launcher.spawnv(argv);
                break;
            } catch (e) {
                lastError = e;
            }
        }
        if (!proc) {
            for (const key of [...this._waiting.keys()]) {
                this._fail(key, new RenderError('unavailable',
                    `Could not start the math renderer: ${lastError?.message}`));
            }
            return null;
        }
        this.starts++;
        const helper = {
            proc,
            stdin: proc.get_stdin_pipe(),
            cancellable: new Gio.Cancellable(),
            writing: Promise.resolve(),
        };
        this._helper = helper;
        this._read(helper, new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()}));
        proc.wait_async(null, () => this._onExit(helper));
        return helper;
    }

    async _read(helper, stdout) {
        try {
            for (;;) {
                // eslint-disable-next-line no-await-in-loop
                const [line] = await stdout.read_line_async(GLib.PRIORITY_DEFAULT, helper.cancellable);
                if (line === null || helper !== this._helper)
                    return;
                this._onReply(new TextDecoder().decode(line));
            }
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`Froonty: math renderer: ${e.message}`);
        }
    }

    _onReply(text) {
        let reply;
        try {
            reply = JSON.parse(text);
        } catch (e) {
            console.warn('Froonty: math renderer: a reply that is not JSON');
            return;
        }
        const key = this._sent.get(reply.id);
        // An id this helper was not asked for, or one already given up on.
        if (key === undefined)
            return;
        this._sent.delete(reply.id);
        this._crashes = 0;
        this._armTimeout();

        if (reply.error !== undefined) {
            const error = new RenderError(reply.kind ?? 'tex', String(reply.error));
            // The same formula always fails the same way.
            if (error.kind === 'tex')
                this._remember(key, {error: error.message});
            this._fail(key, error);
        } else {
            const result = {
                png: new GLib.Bytes(GLib.base64_decode(reply.png)),
                width: reply.width,
                height: reply.height,
                baseline: reply.baseline,
            };
            this._remember(key, result);
            const waiting = this._waiting.get(key);
            this._waiting.delete(key);
            this._forgetChannels(key);
            for (const caller of waiting?.callers ?? [])
                caller.resolve(result);
        }
        this._maybeIdle();
    }

    _remember(key, result) {
        this._cache.delete(key);
        this._cache.set(key, result);
        while (this._cache.size > this._cacheSize)
            this._cache.delete(this._cache.keys().next().value);
    }

    _fail(key, error) {
        const waiting = this._waiting.get(key);
        this._waiting.delete(key);
        this._forgetChannels(key);
        for (const caller of waiting?.callers ?? [])
            caller.reject(error);
    }

    _forgetChannels(key) {
        for (const [channel, entry] of this._channels) {
            if (entry.key === key)
                this._channels.delete(channel);
        }
    }

    // The requests sent to the current helper and not answered yet.
    _takeUnanswered() {
        const keys = [...new Set(this._sent.values())];
        this._sent.clear();
        this._stopTimeout();
        return keys.filter(key => this._waiting.has(key));
    }

    // The helper died by itself. What it was working on gets one more try,
    // in a new helper started after a pause that grows with each death.
    _onExit(helper) {
        if (helper !== this._helper)
            return; // stopped on purpose (_stopProcess)
        this._helper = null;
        helper.cancellable.cancel();
        for (const key of this._takeUnanswered()) {
            if (this._waiting.get(key).tries > 1) {
                this._fail(key, new RenderError('crashed',
                    'The math renderer stopped while drawing this formula'));
            }
        }
        if (this._destroyed || this._waiting.size === 0)
            return;
        const delays = this._restartDelaysMs;
        const delay = delays[Math.min(this._crashes, delays.length - 1)];
        this._crashes++;
        this._restartId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._restartId = 0;
            for (const key of [...this._waiting.keys()])
                this._send(key);
            return GLib.SOURCE_REMOVE;
        });
    }

    _maybeIdle() {
        if (this._waiting.size > 0 || this._idleId || !this._helper)
            return;
        this._idleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._idleMs, () => {
            this._idleId = 0;
            this._stopProcess();
            return GLib.SOURCE_REMOVE;
        });
    }

    // While requests are out, the helper must answer one within timeoutMs
    // of the previous answer (or of the first request).
    _armTimeout() {
        this._stopTimeout();
        if (this._sent.size === 0)
            return;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._timeoutMs, () => {
            this._timeoutId = 0;
            // Replies come in request order: the oldest one is stuck.
            const [id, key] = this._sent.entries().next().value;
            this._sent.delete(id);
            this._fail(key, new RenderError('timeout', 'The formula took too long to draw'));
            this._stopProcess();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopTimeout() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
    }

    _stopIdleTimer() {
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = 0;
    }

    _clearTimers() {
        this._stopTimeout();
        this._stopIdleTimer();
        if (this._restartId)
            GLib.source_remove(this._restartId);
        this._restartId = 0;
    }

    // Stops the helper on purpose (idle, a timeout, destroy()): closing
    // its stdin ends it, SIGTERM (then SIGKILL) makes sure. Requests still
    // out go to a new helper, unless the client is done.
    _stopProcess() {
        const helper = this._helper;
        if (!helper)
            return;
        this._helper = null;
        helper.cancellable.cancel();
        try {
            helper.stdin.close(null);
        } catch (e) {
            // Already closed: it is ending anyway.
        }
        stopProcess(helper.proc, 'The math renderer', 2);
        const unanswered = this._takeUnanswered();
        if (!this._destroyed) {
            for (const key of unanswered)
                this._send(key);
        }
    }
}
