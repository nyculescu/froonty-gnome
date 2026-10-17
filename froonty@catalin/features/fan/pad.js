// SPDX-License-Identifier: GPL-3.0-or-later
// Fan settings' cooling pad (llano V12 Ultra), through its command-line
// tool llano.py: GJS has no ioctl, and the pad is driven by HID feature
// reports. Every command (status, speed N, release) prints the pad's state
// after it, ending in the raw 8-byte status report, which is what is read
// here. Also the user's systemd units that drive the pad by themselves
// (llanod, llano-guard), which would undo the slider within seconds, and
// llano.py's panic lock in $XDG_STATE_HOME/llano (while it is there,
// every write through llano.py is refused). No St.

import GLib from 'gi://GLib';

import {runCaptured as run} from '../sysmon/io.js';
import {override} from '../writing/paths.js';

// Absolute: other toolchains (e.g. SUMO) shadow the system's python3 on PATH.
const PYTHON = '/usr/bin/python3';
// The headless tests point it at a fake (writing/paths.js override).
const systemctl = () => override('FROONTY_SYSTEMCTL') ?? '/usr/bin/systemctl';

/** Units that set the pad's speed on their own, in the order shown. */
const CONTROLLER_UNITS = ['llano-guard.service', 'llanod.service'];

/**
 * The pad's state from llano.py's output ("speed 20% (software control)
 * lights off  raw 80 14 00 82 04 00 ff e6"), or null.
 *
 * @returns {?{speed: number, control: string, off: boolean, lightsOff: boolean}}
 *   control is 'software' (status byte 0x80) or 'pad' (0x88); off when
 *   byte 2 (on_off) switched the whole pad off, fan and lights (llano.py
 *   speed 0 or lock: at 0 % with the pad on, the fan still turns)
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
        off: bytes[2] === 1,
        lightsOff: bytes[2] === 1 || (bytes[3] & 0x80) !== 0,
    };
}

/** Where llano.py keeps its lock. */
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

/**
 * llano.py's `noise {json}` line: the speed's rpm and dB at the ears, its
 * band, and compatibility metadata; null when there is none (an older llano.py).
 */
export function parseNoise(text) {
    const match = /^noise (\{.*\})\s*$/m.exec(text ?? '');
    if (!match)
        return null;
    try {
        const noise = JSON.parse(match[1]);
        return noise && typeof noise.rpm === 'number' && noise.limit ? noise : null;
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
 * Runs llano.py with `args` (['status'], ['speed', '40'], ['rpm', '600'],
 * ['release'], ['lock'], ['unlock']); its control log names Froonty.
 *
 * @returns {Promise<{status: ?object, noise: ?object, error: ?string, message: string}>}
 *   status as parseStatus, noise as parseNoise; error null or a failureKind
 */
export async function llano(script, args) {
    const {ok, stdout, stderr} = await run([PYTHON, script, ...args], null,
        {LLANO_CLIENT: 'Froonty'});
    const status = ok ? parseStatus(stdout) : null;
    if (status)
        return {status, noise: parseNoise(stdout), error: null, message: ''};
    const message = (stderr || stdout).trim().split('\n').pop() ?? '';
    return {status: null, noise: null, error: failureKind(stderr || stdout), message};
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
    await run([systemctl(), '--user', 'stop', unit]);
}
