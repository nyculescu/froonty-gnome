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
// nvidia-smi answers in about 40 ms and llano.py (Fan) in about 0.15 s; one
// stuck on a broken driver or a hung device is stopped.
const RUN_TIMEOUT_S = 5;
// A process that writes without pause still hands its lines over in parts.
const MAX_BATCH = 64;
const decoder = new TextDecoder();
let followWarned = false;

/** A file's text, or null when it cannot be read. */
async function read(path, cancellable = null) {
    const contents = await readBytes(path, cancellable);
    return contents === null ? null : decoder.decode(contents);
}

/** A file's bytes (Uint8Array), or null when it cannot be read. */
async function readBytes(path, cancellable = null) {
    try {
        const [contents] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
        return contents;
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

/** Where a symbolic link points, or null (also for a path that is no link). */
async function link(path, cancellable = null) {
    try {
        const info = await Gio.File.new_for_path(path).query_info_async(
            'standard::is-symlink,standard::symlink-target', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_DEFAULT, cancellable);
        return info.get_is_symlink() ? info.get_symlink_target() : null;
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
 * Runs `argv` (no shell): {ok, stdout, stderr}; ok is false when it fails,
 * is cancelled or takes longer than RUN_TIMEOUT_S. `env`: variables to set
 * for it.
 */
export async function runCaptured(argv, cancellable = null, env = {}) {
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

/** Runs `argv` (no shell); resolves its standard output, or null (see runCaptured). */
async function run(argv, cancellable = null) {
    const {ok, stdout} = await runCaptured(argv, cancellable);
    return ok ? stdout : null;
}

/**
 * Starts `argv` (no shell, stderr discarded), a process that keeps writing
 * lines. `onLines` gets them a batch at a time: those read before the pipe
 * ran dry. `onEnd` follows once when its output ends. Neither is called
 * before follow() returns or after stop(), which kills it. Returns {stop},
 * or null when it cannot start.
 */
function follow(argv, onLines, onEnd) {
    let proc;
    try {
        proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (e) {
        return null;
    }
    const cancellable = new Gio.Cancellable();
    const stream = new Gio.DataInputStream({
        base_stream: proc.get_stdout_pipe(),
        close_base_stream: true,
    });
    const close = () => {
        try {
            stream.close(null);
        } catch (e) {}
    };
    let batch = [];
    const next = () => stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (_stream, result) => {
        let line = null;
        try {
            [line] = stream.read_line_finish_utf8(result);
        } catch (e) {
            // Cancelled by stop(), or not UTF-8: either way the end.
        }
        if (cancellable.is_cancelled()) {
            close();
            return;
        }
        if (line === null) {
            proc.force_exit();
            close();
            onEnd();
            return;
        }
        batch.push(line);
        if (stream.get_available() === 0 || batch.length >= MAX_BATCH) {
            const lines = batch;
            batch = [];
            // A throw must not stop the reads, or the pipe fills and the process blocks.
            try {
                onLines(lines);
            } catch (e) {
                if (!followWarned)
                    console.warn(`Froonty: handling ${argv[0]}'s output failed: ${e.message}`);
                followWarned = true;
            }
        }
        // onLines may have stopped it.
        if (cancellable.is_cancelled())
            close();
        else
            next();
    });
    next();
    return {
        stop() {
            cancellable.cancel();
            proc.force_exit();
        },
    };
}

export const SYSTEM_IO = {read, readBytes, list, link, exists, executable, filesystem, run, follow};
