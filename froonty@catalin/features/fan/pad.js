// SPDX-License-Identifier: GPL-3.0-or-later
// The Fan tab's cooling pad (llano V12 Ultra), through its command-line
// tool llano.py: GJS has no ioctl, and the pad is driven by HID feature
// reports. Every command (status, speed N, release) prints the pad's state
// after it, ending in the raw 8-byte status report, which is what is read
// here. Also the user's systemd units that drive the pad by themselves
// (llanod, llano-guard), which would undo the slider within seconds, and
// llano.py's state in $XDG_STATE_HOME/llano: the panic lock (while it is
// there, every write through llano.py is refused) and the log of who
// drove the pad last (control.log; Froonty's own writes say "Froonty").
// No St.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {override} from '../writing/paths.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

// Absolute: other toolchains (e.g. SUMO) shadow the system's python3 on PATH.
const PYTHON = '/usr/bin/python3';
// The headless tests point it at a fake (writing/paths.js override).
const systemctl = () => override('FROONTY_SYSTEMCTL') ?? '/usr/bin/systemctl';
const SIGKILL = 9;
// A command takes about 0.15 s; one stuck on a hung device is stopped.
const RUN_TIMEOUT_S = 5;

/** Units that set the pad's speed on their own, in the order shown. */
export const CONTROLLER_UNITS = ['llano-guard.service', 'llanod.service'];

/**
 * The pad's state from llano.py's output ("speed 20% (software control)
 * lights off  raw 80 14 00 82 04 00 ff e6"), or null.
 *
 * @returns {?{speed: number, control: string, lightsOff: boolean, raw: string}}
 *   control is 'software' (status byte 0x80) or 'pad' (0x88)
 */
export function parseStatus(text) {
    const match = /raw ((?:[0-9a-f]{2} ){7}[0-9a-f]{2})\s*$/m.exec(text ?? '');
    if (!match)
        return null;
    const bytes = match[1].split(' ').map(hex => parseInt(hex, 16));
    if (bytes[0] !== 0x80 && bytes[0] !== 0x88)
        return null;
    return {
        speed: bytes[1],
        control: bytes[0] === 0x80 ? 'software' : 'pad',
        lightsOff: (bytes[3] & 0x80) !== 0,
        raw: match[1],
    };
}

/** Where llano.py keeps its lock and control log. */
export const stateDir = () => `${GLib.get_user_state_dir()}/llano`;

/**
 * The lock's record ({time, by, speed, ctl}) from the lock file's text,
 * or null when there is no lock (text null). Unreadable is still a lock.
 */
export function parseLock(text) {
    if (text === null || text === undefined)
        return null;
    try {
        return JSON.parse(text) ?? {};
    } catch (e) {
        return {};
    }
}

/** The latest control.log entry ({time, by, pid, action, speed}), or null. */
export function parseLastControl(text) {
    const last = (text ?? '').trim().split('\n').pop();
    try {
        const entry = JSON.parse(last);
        return entry && typeof entry.by === 'string' ? entry : null;
    } catch (e) {
        return null;
    }
}

/** Why llano.py failed, from its standard error. */
export function failureKind(stderr) {
    if (/locked off/.test(stderr))
        return 'locked';
    if (/can't open file|No such file or directory: '.*llano/.test(stderr))
        return 'no-script';
    if (/not found/.test(stderr))
        return 'not-found';
    if (/PermissionError|Permission denied/.test(stderr))
        return 'no-access';
    return 'failed';
}

/** The active ones of CONTROLLER_UNITS, from `systemctl is-active`'s lines. */
export function activeUnits(stdout) {
    const states = (stdout ?? '').split('\n');
    return CONTROLLER_UNITS.filter((_unit, i) => states[i]?.trim() === 'active');
}

/**
 * Runs `argv` (no shell): {ok, stdout, stderr}; ok is false on a failure or
 * timeout. `env`: variables to set for it.
 */
async function run(argv, cancellable = null, env = {}) {
    let proc;
    try {
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        for (const [name, value] of Object.entries(env))
            launcher.setenv(name, value, true);
        proc = launcher.spawnv(argv);
    } catch (e) {
        return {ok: false, stdout: '', stderr: e.message};
    }
    const cancelId = cancellable?.connect(() => proc.send_signal(SIGKILL)) ?? 0;
    let timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RUN_TIMEOUT_S, () => {
        timeoutId = 0;
        proc.send_signal(SIGKILL);
        return GLib.SOURCE_REMOVE;
    });
    try {
        const [stdout, stderr] = await proc.communicate_utf8_async(null, null);
        return {ok: proc.get_successful(), stdout: stdout ?? '', stderr: stderr ?? ''};
    } catch (e) {
        return {ok: false, stdout: '', stderr: e.message};
    } finally {
        if (timeoutId)
            GLib.source_remove(timeoutId);
        if (cancelId)
            cancellable.disconnect(cancelId);
    }
}

/**
 * Runs llano.py with `args` (['status'], ['speed', '40'], ['release'],
 * ['lock'], ['unlock']); its control log names Froonty.
 *
 * @returns {Promise<{status: ?object, error: ?string, message: string}>}
 *   status as parseStatus; error null or a failureKind
 */
export async function llano(script, args, cancellable = null) {
    const {ok, stdout, stderr} = await run([PYTHON, script, ...args], cancellable,
        {LLANO_CLIENT: 'Froonty'});
    const status = ok ? parseStatus(stdout) : null;
    if (status)
        return {status, error: null, message: ''};
    const message = (stderr || stdout).trim().split('\n').pop() ?? '';
    return {status: null, error: failureKind(stderr || stdout), message};
}

/** The active CONTROLLER_UNITS of the user's systemd. */
export async function controllers(cancellable = null) {
    // is-active exits non-zero when any unit is inactive; its lines still tell.
    const {stdout} = await run([systemctl(), '--user', 'is-active', ...CONTROLLER_UNITS],
        cancellable);
    return activeUnits(stdout);
}

/** Stops one of CONTROLLER_UNITS (each hands the pad back on SIGTERM). */
export async function stopUnit(unit) {
    if (!CONTROLLER_UNITS.includes(unit))
        return false;
    return (await run([systemctl(), '--user', 'stop', unit])).ok;
}
