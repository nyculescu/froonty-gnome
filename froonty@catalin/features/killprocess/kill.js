// SPDX-License-Identifier: GPL-3.0-or-later
// How the Kill Process tab signals a process (docs/features/kill-process.md).
//
// GJS cannot call kill(2) itself, and neither GLib, Gio nor GNOME Shell
// 50's Shell library offers it: Gio.Subprocess signals only the processes
// it started, and Meta.Window.kill() reaches only processes with a window
// (checked by introspection, 2026-10-02). So Froonty runs the system's
// kill(1) from procps, from a fixed location (never $PATH), with a fixed
// argument list (no shell), once per confirmed kill. Pure; no Gio, so it
// loads in tests.

import {isValidPid} from './rules.js';

// Fixed system locations only (as features/zerotier/cli.js).
export const KILL_PATHS = ['/usr/bin/kill', '/bin/kill'];
// SIGTERM asks a process to quit; SIGKILL ends it ("Force quit").
export const SIGNALS = ['TERM', 'KILL'];

/**
 * kill(1)'s arguments for one signal to one process. Throws on anything
 * else: another program, a signal not in SIGNALS, or a process id that is
 * not a whole number above 1 (0 and negative ids are process groups, -1
 * every process the user has).
 *
 * @param {string} killPath one of KILL_PATHS
 * @param {number} pid
 * @param {string} signal one of SIGNALS
 * @returns {string[]}
 */
export function killArgv(killPath, pid, signal) {
    if (!KILL_PATHS.includes(killPath))
        throw new Error('Not the system kill command.');
    if (!isValidPid(pid))
        throw new Error('Not a process id that can be signalled.');
    if (!SIGNALS.includes(signal))
        throw new Error('Unsupported signal.');
    return [killPath, '-s', signal, String(pid)];
}
