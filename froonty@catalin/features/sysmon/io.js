// SPDX-License-Identifier: GPL-3.0-or-later
// The Btop tab's file system and process access, all asynchronous
// (nothing blocks the compositor). Sampler takes an object of this shape,
// so tests can hand it a fake /proc and /sys instead. No St.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'query_filesystem_info_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const SIGKILL = 9;
// nvidia-smi answers in about 40 ms; one stuck on a broken driver is stopped.
const RUN_TIMEOUT_S = 5;
const decoder = new TextDecoder();

/** A file's text, or null when it cannot be read. */
async function read(path, cancellable = null) {
    try {
        const [contents] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
        return decoder.decode(contents);
    } catch (e) {
        return null;
    }
}

/** A folder's entry names (links not followed), or [] when it cannot be listed. */
async function list(path, cancellable = null) {
    try {
        const enumerator = await Gio.File.new_for_path(path).enumerate_children_async(
            'standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT, cancellable);
        const names = [];
        for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const infos = await enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT,
                cancellable);
            if (!infos.length)
                break;
            names.push(...infos.map(info => info.get_name()));
        }
        await enumerator.close_async(GLib.PRIORITY_DEFAULT, null);
        return names;
    } catch (e) {
        return [];
    }
}

/** Where a symbolic link points, or null. */
async function link(path, cancellable = null) {
    try {
        const info = await Gio.File.new_for_path(path).query_info_async(
            'standard::symlink-target', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT, cancellable);
        return info.get_symlink_target();
    } catch (e) {
        return null;
    }
}

/** Whether `path` exists (links followed). */
async function exists(path, cancellable = null) {
    try {
        await Gio.File.new_for_path(path).query_info_async('standard::type',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
        return true;
    } catch (e) {
        return false;
    }
}

/** Whether `path` is an executable regular file. */
async function executable(path, cancellable = null) {
    try {
        const info = await Gio.File.new_for_path(path).query_info_async(
            'access::can-execute,standard::type', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, cancellable);
        return info.get_file_type() === Gio.FileType.REGULAR &&
            info.get_attribute_boolean('access::can-execute');
    } catch (e) {
        return false;
    }
}

/** The size and used bytes of the file system holding `path`, or null. */
async function filesystem(path, cancellable = null) {
    try {
        const info = await Gio.File.new_for_path(path).query_filesystem_info_async(
            'filesystem::size,filesystem::used', GLib.PRIORITY_DEFAULT, cancellable);
        if (!info.has_attribute('filesystem::size') || !info.has_attribute('filesystem::used'))
            return null;
        return {
            total: info.get_attribute_uint64('filesystem::size'),
            used: info.get_attribute_uint64('filesystem::used'),
        };
    } catch (e) {
        return null;
    }
}

/**
 * Runs `argv` (no shell); resolves its standard output, or null when it
 * fails, is cancelled or takes longer than RUN_TIMEOUT_S.
 */
async function run(argv, cancellable = null) {
    let proc;
    try {
        proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (e) {
        return null;
    }
    const cancelId = cancellable?.connect(() => proc.send_signal(SIGKILL)) ?? 0;
    let timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RUN_TIMEOUT_S, () => {
        timeoutId = 0;
        proc.send_signal(SIGKILL);
        return GLib.SOURCE_REMOVE;
    });
    try {
        const [stdout] = await proc.communicate_utf8_async(null, null);
        return proc.get_successful() ? stdout ?? '' : null;
    } catch (e) {
        return null;
    } finally {
        if (timeoutId)
            GLib.source_remove(timeoutId);
        if (cancelId)
            cancellable.disconnect(cancelId);
    }
}

export const SYSTEM_IO = {read, list, link, exists, executable, filesystem, run};
