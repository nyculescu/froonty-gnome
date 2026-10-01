// SPDX-License-Identifier: GPL-3.0-or-later
// Fresh Claude usage on open (docs/features/claude.md, user request).
// Claude Code writes its usage cache only when it checks usage: its /usage
// command or VS Code's Account & Usage panel. So when the Claude tab or
// its panic button comes on screen, this runs the user's own Claude Code
// once, non-interactively:
//
//   claude -p --no-session-persistence /usage
//
// A local command: Claude Code asks Anthropic for the plan's usage and
// caches it; no model request, no plan usage, no transcript (checked with
// Claude Code 2.1.285 on 2026-09-30). Froonty never sees a credential.
//
// With the setting off nothing is run, and only the status line
// (statusline.py) brings in new numbers. Low power (power.js) turns the
// setting off by itself as it begins, and back on as it ends if it was
// this that turned it off (user request). Turning it on meanwhile is the
// user's choice and stays: it is not turned off again until the next time
// low power begins.
//
// One per Shell (acquireShared): the tab and the panic button share it,
// so opening the island runs Claude Code once, not twice. The extension
// holds it too while the Claude tab is enabled, so its power monitor (and
// with it the setting) follows the power state also with the island
// collapsed and the tab never opened; it only listens to D-Bus property
// changes. No St.
//
// Emits 'changed' when the mode changes, 'done' after each run.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Emitter} from '../../core/emitter.js';
import {PowerMonitor} from './power.js';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');

export const SETTING = 'claude-ask-claude-code';
// Internal: this turned SETTING off for low power (and will turn it back on).
export const PAUSED = 'claude-ask-paused-for-power';
// Internal: the current low-power stretch was already acted on, so a user
// who turns SETTING back on keeps it (survives a Shell restart or lock).
export const HANDLED = 'claude-low-power-handled';
// Claude Code neither asks again nor rewrites its cache within a minute.
export const MIN_INTERVAL_MS = 60 * 1000;
// A run takes 2-3 s; one that hangs (e.g. no network) is stopped.
const TIMEOUT_S = 30;
const SIGTERM = 15;
// How long a stopped run gets to end on SIGTERM before SIGKILL.
const KILL_GRACE_S = 5;
const SIGKILL = 9;

// Folders whose extensions/ may hold Claude Code's VS Code extension.
const EDITOR_DIRS = ['.vscode', '.vscode-insiders'];

/**
 * The newest Claude Code VS Code extension folder among `names`.
 *
 * @param {string[]} names e.g. ['anthropic.claude-code-2.1.285-linux-x64']
 * @returns {?string}
 */
export function newestExtension(names) {
    const version = name => /^anthropic\.claude-code-(\d+(?:\.\d+)*)-linux-[a-z0-9]+$/
        .exec(name)?.[1].split('.').map(Number) ?? null;
    let best = null;
    for (const name of names) {
        const v = version(name);
        if (v && (!best || compare(v, best.v) > 0))
            best = {name, v};
    }
    return best?.name ?? null;
}

function compare(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const d = (a[i] ?? 0) - (b[i] ?? 0);
        if (d)
            return d;
    }
    return 0;
}

/**
 * Claude Code's executable: $FROONTY_CLAUDE_CODE when set (the tests; never
 * anything else then), the newest VS Code extension's bundled binary, or
 * `claude` from a standalone install.
 *
 * @returns {Promise<?string>}
 */
export async function findClaudeCode() {
    const override = GLib.getenv('FROONTY_CLAUDE_CODE');
    if (override)
        return await isExecutable(override) ? override : null;

    const home = GLib.get_home_dir();
    for (const editor of EDITOR_DIRS) {
        const dir = Gio.File.new_for_path(GLib.build_filenamev([home, editor, 'extensions']));
        // eslint-disable-next-line no-await-in-loop
        const name = newestExtension(await childNames(dir));
        const path = name && GLib.build_filenamev([dir.get_path(), name,
            'resources', 'native-binary', 'claude']);
        // eslint-disable-next-line no-await-in-loop
        if (path && await isExecutable(path))
            return path;
    }
    for (const path of [
        GLib.find_program_in_path('claude'),
        GLib.build_filenamev([home, '.local', 'bin', 'claude']),
        GLib.build_filenamev([home, '.claude', 'local', 'claude']),
    ]) {
        // eslint-disable-next-line no-await-in-loop
        if (path && await isExecutable(path))
            return path;
    }
    return null;
}

async function childNames(dir) {
    const names = [];
    try {
        const children = await dir.enumerate_children_async('standard::name',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
        for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const infos = await children.next_files_async(64, GLib.PRIORITY_DEFAULT, null);
            if (!infos.length)
                break;
            names.push(...infos.map(info => info.get_name()));
        }
    } catch (e) {
        // No such editor here.
    }
    return names;
}

async function isExecutable(path) {
    try {
        const info = await Gio.File.new_for_path(path).query_info_async(
            'access::can-execute,standard::type', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, null);
        return info.get_file_type() === Gio.FileType.REGULAR &&
            info.get_attribute_boolean('access::can-execute');
    } catch (e) {
        return false;
    }
}

// SIGTERM, then SIGKILL if `proc` still runs KILL_GRACE_S later, so a hung
// run cannot keep the refresher waiting.
function stopProcess(proc) {
    proc.send_signal(SIGTERM);
    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, KILL_GRACE_S, () => {
        if (proc.get_identifier() !== null) {
            console.warn(`Froonty: Claude Code's /usage ignored SIGTERM; killing it`);
            proc.send_signal(SIGKILL);
        }
        return GLib.SOURCE_REMOVE;
    });
}

/**
 * Runs Claude Code's /usage and waits for it, at most TIMEOUT_S. Stopped
 * with SIGTERM (Claude Code then ends cleanly, its cache file intact) on
 * timeout or when `cancellable` is cancelled, and with SIGKILL if it is
 * still there KILL_GRACE_S later.
 *
 * @returns {Promise<boolean>} whether it succeeded
 */
export async function runUsage(binary, cancellable) {
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
    });
    // /usage reads the local sessions; from the home folder, none is "this
    // project".
    launcher.set_cwd(GLib.get_home_dir());
    const proc = launcher.spawnv([binary, '-p', '--no-session-persistence', '/usage']);
    let timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TIMEOUT_S, () => {
        console.warn(`Froonty: Claude Code's /usage did not finish in ${TIMEOUT_S} s`);
        timeout = 0;
        stopProcess(proc);
        return GLib.SOURCE_REMOVE;
    });
    try {
        await proc.wait_async(cancellable);
        return proc.get_successful();
    } catch (e) {
        stopProcess(proc);
        throw e;
    } finally {
        if (timeout)
            GLib.source_remove(timeout);
    }
}

export class ClaudeRefresher extends Emitter {
    /**
     * @param {object} options
     * @param {Gio.Settings} options.settings
     * @param {object} [options.power] a PowerMonitor (tests: a fake)
     * @param {Function} [options.find] () → Promise<?path> (tests)
     * @param {Function} [options.run] (path, cancellable) → Promise<boolean> (tests)
     * @param {Function} [options.now] () → ms (tests)
     */
    constructor({settings, power = new PowerMonitor(), find = findClaudeCode, run = runUsage,
        now = Date.now}) {
        super();
        this._settings = settings;
        this._power = power;
        this._find = find;
        this._run = run;
        this._now = now;

        /** False when Claude Code was not found on the last try. */
        this.found = true;
        this._active = 0;
        this._running = null;
        this._lastRun = -Infinity;
        // Lives as long as the refresher: a run goes on when the island
        // closes (2-3 s), and is stopped only by destroy().
        this._cancellable = new Gio.Cancellable();
        this._destroyed = false;
        this._settingsId = settings.connect(`changed::${SETTING}`, () => this._onSetting());
        this._powerId = power.connect('changed', () => this._onPower());
        this._powerStarted = power.start().then(() => this._onPower());
    }

    destroy() {
        // A start still under way resolves later; it must not act then.
        this._destroyed = true;
        this._settings.disconnect(this._settingsId);
        this._power.disconnect(this._powerId);
        this._cancel();
        this._power.stop();
    }

    /**
     * {mode: 'claude-code' | 'status-line', reason}: reason null (running
     * Claude Code), 'off' (the user's choice), or the low power that turned
     * the setting off: 'power-saver' or 'battery'.
     */
    get mode() {
        if (this._settings.get_boolean(SETTING))
            return {mode: 'claude-code', reason: null};
        if (this._settings.get_boolean(PAUSED))
            return {mode: 'status-line', reason: this._power.reason ?? 'off'};
        return {mode: 'status-line', reason: 'off'};
    }

    // Turned on by hand while paused: the user's choice, nothing to restore.
    _onSetting() {
        if (this._settings.get_boolean(SETTING) && this._settings.get_boolean(PAUSED))
            this._settings.set_boolean(PAUSED, false);
        this.emit('changed');
    }

    // Acts once as low power begins and once as it ends; never on a power
    // state that cannot be read (power.js `known`).
    _onPower() {
        if (this._destroyed || !this._power.known)
            return;
        const low = this._power.reason !== null;
        const handled = this._settings.get_boolean(HANDLED);
        if (low && !handled) {
            this._settings.set_boolean(HANDLED, true);
            if (this._settings.get_boolean(SETTING)) {
                // PAUSED first: _onSetting must not take this for the user.
                this._settings.set_boolean(PAUSED, true);
                this._settings.set_boolean(SETTING, false);
            }
        } else if (!low && handled) {
            this._settings.set_boolean(HANDLED, false);
            if (this._settings.get_boolean(PAUSED)) {
                this._settings.set_boolean(PAUSED, false);
                this._settings.set_boolean(SETTING, true);
            }
        }
        this.emit('changed');
    }

    /** A view came on screen (true) or left it (false). */
    setActive(active) {
        this._active = Math.max(0, this._active + (active ? 1 : -1));
    }

    _cancel() {
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    /**
     * Runs Claude Code's /usage unless: the setting is off,
     * one runs already, one ran within a minute, or the cache is under a
     * minute old (Claude Code would not ask again anyway).
     *
     * @param {?number} fetchedAt the cache's age, ms since the epoch
     * @returns {Promise<boolean>} whether it ran (for tests)
     */
    async request(fetchedAt) {
        if (!this._active || this._running)
            return false;
        const cancellable = this._cancellable;
        this._running = (async () => {
            // Low power that just began turns the setting off first.
            await this._powerStarted;
            const now = this._now();
            if (this._destroyed || this.mode.mode !== 'claude-code' ||
                now - this._lastRun < MIN_INTERVAL_MS ||
                (fetchedAt !== null && now - fetchedAt < MIN_INTERVAL_MS))
                return false;
            this._lastRun = now;
            const binary = await this._find();
            const found = binary !== null;
            if (found !== this.found) {
                this.found = found;
                this.emit('changed');
            }
            if (!found || this._destroyed)
                return false;
            try {
                if (!await this._run(binary, cancellable))
                    console.warn(`Froonty: Claude Code's /usage failed (${binary})`);
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`Froonty: cannot run Claude Code's /usage: ${e.message}`);
                return false;
            }
            this.emit('done');
            return true;
        })().finally(() => {
            this._running = null;
        });
        return this._running;
    }
}

let shared = null;
let users = 0;

/**
 * The Shell's one refresher; each acquire() needs a releaseShared().
 *
 * @param {Gio.Settings} settings
 */
export function acquireShared(settings) {
    shared ??= new ClaudeRefresher({settings});
    users++;
    return shared;
}

export function releaseShared() {
    if (--users > 0)
        return;
    shared?.destroy();
    shared = null;
    users = 0;
}
