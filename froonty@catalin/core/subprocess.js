// SPDX-License-Identifier: GPL-3.0-or-later
// Stopping a subprocess Froonty started: SIGTERM, so it can end cleanly,
// then SIGKILL if it is still there a few seconds later, so a hung one
// cannot keep anything waiting. Used by the Claude tab's /usage refresh
// (features/claude/refresher.js) and, in working-tree builds, by others.

import GLib from 'gi://GLib';

const SIGTERM = 15;
const SIGKILL = 9;
// How long a stopped process gets to end on SIGTERM before SIGKILL.
export const KILL_GRACE_S = 5;

/**
 * @param {Gio.Subprocess} proc
 * @param {string} label names the process in the warning, e.g.
 *   "Claude Code's /usage"
 * @param {number} [graceS]
 */
export function stopProcess(proc, label, graceS = KILL_GRACE_S) {
    if (proc.get_identifier() === null)
        return;
    proc.send_signal(SIGTERM);
    // One-shot; it only ever sends a signal to a child of this process. It
    // is removed as soon as the process ends, so it outlives the caller
    // (a disable(), say) only while the process ignores SIGTERM.
    let timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, graceS, () => {
        timer = 0;
        if (proc.get_identifier() !== null) {
            console.warn(`Froonty: ${label} ignored SIGTERM; killing it`);
            proc.send_signal(SIGKILL);
        }
        return GLib.SOURCE_REMOVE;
    });
    proc.wait_async(null, (_proc, result) => {
        try {
            proc.wait_finish(result);
        } catch (e) {
            // Only its end matters here.
        }
        if (timer)
            GLib.source_remove(timer);
        timer = 0;
    });
}
