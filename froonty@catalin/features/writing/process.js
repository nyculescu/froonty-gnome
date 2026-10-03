// SPDX-License-Identifier: GPL-3.0-or-later
// Running one of the Writing tab's subprocesses (docs/features/writing.md
// §4.3): a fixed argv, no shell, a chosen working folder and environment,
// text on stdin, a timeout, and SIGTERM (then SIGKILL) when it is
// cancelled or times out. No St or Gtk.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {stopProcess} from '../../core/subprocess.js';
import {WritingError} from './errors.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

/**
 * @param {object} options
 * @param {string[]} options.argv
 * @param {?string} [options.cwd]
 * @param {string[]} [options.unset] environment variables to remove
 * @param {object} [options.set] environment variables to set
 * @param {?string} [options.stdin]
 * @param {?Gio.Cancellable} [options.cancellable]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.label] names the process in a warning
 * @returns {Promise<{stdout: string, stderr: string, exitOk: boolean, status: number}>}
 * @throws {WritingError} 'cancelled', 'timeout', or 'failed' (could not run)
 */
export async function runProcess({argv, cwd = null, unset = [], set = {}, stdin = null,
    cancellable = null, timeoutMs = 10000, label = 'A Writing subprocess'}) {
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE |
            Gio.SubprocessFlags.STDERR_PIPE,
    });
    if (cwd)
        launcher.set_cwd(cwd);
    for (const name of unset)
        launcher.unsetenv(name);
    for (const [name, value] of Object.entries(set))
        launcher.setenv(name, value, true);

    // Cancelled before it started (Cancel, a screen lock or disable() during
    // an earlier step): nothing is started.
    if (cancellable?.is_cancelled())
        throw new WritingError('cancelled', 'Cancelled.');
    let proc;
    try {
        proc = launcher.spawnv(argv);
    } catch (e) {
        throw new WritingError('failed', `Could not start ${argv[0]}: ${e.message}`);
    }

    // Our own cancellable: the caller's, the timeout, or both stop it.
    const local = new Gio.Cancellable();
    let timedOut = false;
    let timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
        timer = 0;
        timedOut = true;
        local.cancel();
        return GLib.SOURCE_REMOVE;
    });
    const stopId = local.connect(() => stopProcess(proc, label));
    const parentId = cancellable?.connect(() => local.cancel()) ?? 0;
    try {
        const [stdout, stderr] = await proc.communicate_utf8_async(stdin, local);
        return {
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            exitOk: proc.get_successful(),
            status: proc.get_if_exited() ? proc.get_exit_status() : -1,
        };
    } catch (e) {
        if (timedOut)
            throw new WritingError('timeout', `${label} did not finish in ${Math.round(timeoutMs / 1000)} s.`);
        if (local.is_cancelled())
            throw new WritingError('cancelled', 'Cancelled.');
        stopProcess(proc, label);
        throw new WritingError('failed', `${label} failed: ${e.message}`);
    } finally {
        if (timer)
            GLib.source_remove(timer);
        if (parentId)
            cancellable.disconnect(parentId);
        local.disconnect(stopId);
    }
}
