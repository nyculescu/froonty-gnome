// SPDX-License-Identifier: GPL-3.0-or-later
// The Kill Process tab's access to /proc and to the kill command: the Btop
// tab's asynchronous reads and subprocess (features/sysmon/io.js), plus a
// listing that tells who owns each entry, and a pause that lets the Shell
// draw between batches of reads. The sampler and the service take an
// object of this shape, so tests can hand them a fake /proc (and a fake
// kill that signals nothing) instead. No St.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {SYSTEM_IO} from '../sysmon/io.js';

// sysmon/io.js promisifies these too; doing it again is harmless.
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');

/** A folder's entries with their owner's user id, or [] when it cannot be listed. */
async function owners(path, cancellable = null) {
    try {
        const enumerator = await Gio.File.new_for_path(path).enumerate_children_async(
            'standard::name,unix::uid', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT, cancellable);
        const entries = [];
        for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const infos = await enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT,
                cancellable);
            if (!infos.length)
                break;
            entries.push(...infos.map(info => ({
                name: info.get_name(),
                uid: info.get_attribute_uint32('unix::uid'),
            })));
        }
        await enumerator.close_async(GLib.PRIORITY_DEFAULT, null);
        return entries;
    } catch (e) {
        return [];
    }
}

/**
 * Resolves once the main loop has nothing more urgent to do: an idle at
 * PRIORITY_DEFAULT_IDLE runs after due frames (Clutter draws at
 * PRIORITY_REDRAW, 50) and after IO completions (PRIORITY_DEFAULT).
 * Cancelling `cancellable` removes the idle and resolves at once.
 */
function pause(cancellable = null) {
    return new Promise(resolve => {
        if (cancellable?.is_cancelled()) {
            resolve();
            return;
        }
        let cancelId = 0;
        const sourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (cancelId)
                cancellable.disconnect(cancelId);
            resolve();
            return GLib.SOURCE_REMOVE;
        });
        // Not disconnected here: g_cancellable_disconnect() must not be
        // called from the handler; the visit's cancellable goes with it.
        cancelId = cancellable?.connect(() => {
            GLib.source_remove(sourceId);
            resolve();
        }) ?? 0;
    });
}

export const PROCESS_IO = {...SYSTEM_IO, owners, pause};

/** GNOME Shell's own process id and user id (the process Froonty runs in). */
export function currentProcess() {
    const credentials = new Gio.Credentials();
    return {pid: credentials.get_unix_pid(), uid: credentials.get_unix_user()};
}
