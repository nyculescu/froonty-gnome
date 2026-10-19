// SPDX-License-Identifier: GPL-3.0-or-later
// Running the LocalSend helper (docs/features/localsend.md): Gio only.
//
// Isolated: helper.py runs in a process of its own, with the system Python
// in isolated mode (-I) and a short fixed environment; nothing of it is
// loaded into the Shell. It reads its configuration and then commands on
// stdin and prints one JSON event a line; closing stdin stops it.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {stopProcess} from '../../core/subprocess.js';

Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_all_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');

const SYSTEM_PYTHON = '/usr/bin/python3';
const LABEL = 'the LocalSend helper';
// An event line longer than this is not one of the helper's.
const MAX_LINE = 512 * 1024;

const helperPath = () => Gio.File.new_for_uri(import.meta.url).get_parent()
    .get_child('helper.py').get_path();

/** Parses one line of the helper's output; null when it is not an event. */
export function parseEvent(line) {
    if (!line || line.length > MAX_LINE)
        return null;
    try {
        const value = JSON.parse(line);
        return value && typeof value === 'object' && typeof value.event === 'string' ? value : null;
    } catch {
        return null;
    }
}

/**
 * A running helper.
 *
 * @param {object} config {alias, folder, port, zerotier}
 * @param {(event: object) => void} onEvent
 * @param {(status: ?number) => void} onExit once, when it ends (null:
 *   it could not start)
 * @returns {{send: (command: object) => void, stop: () => void}}
 */
export function startHelper(config, onEvent, onExit) {
    let proc;
    try {
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_SILENCE,
        });
        launcher.set_environ([
            `HOME=${GLib.get_home_dir()}`,
            `XDG_DATA_HOME=${GLib.get_user_data_dir()}`,
            'PATH=/usr/bin:/bin',
            `LANG=${GLib.getenv('LANG') ?? 'C.UTF-8'}`,
            'PYTHONNOUSERSITE=1',
            'PYTHONDONTWRITEBYTECODE=1',
        ]);
        launcher.set_cwd(GLib.get_home_dir());
        proc = launcher.spawnv([SYSTEM_PYTHON, '-I', helperPath(), 'serve']);
    } catch (e) {
        console.warn(`Froonty: could not start ${LABEL}: ${e.message}`);
        GLib.idle_add_once(GLib.PRIORITY_DEFAULT, () => onExit(null));
        return {send() {}, stop() {}};
    }

    const stdin = proc.get_stdin_pipe();
    const stdout = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
    const cancellable = new Gio.Cancellable();
    let stopped = false;
    // Writes go one after another, in order.
    let writing = Promise.resolve();
    const send = command => {
        if (stopped)
            return;
        const bytes = new TextEncoder().encode(`${JSON.stringify(command)}\n`);
        writing = writing.then(() => stdin.write_all_async(bytes, GLib.PRIORITY_DEFAULT, cancellable))
            .catch(e => {
                if (!cancellable.is_cancelled())
                    console.warn(`Froonty: ${LABEL}: ${e.message}`);
            });
    };

    (async () => {
        try {
            for (;;) {
                // eslint-disable-next-line no-await-in-loop
                const [line] = await stdout.read_line_async(GLib.PRIORITY_DEFAULT, cancellable);
                if (line === null)
                    break;
                const event = parseEvent(new TextDecoder().decode(line));
                if (event)
                    onEvent(event);
            }
        } catch (e) {
            if (!cancellable.is_cancelled())
                console.warn(`Froonty: ${LABEL}: ${e.message}`);
        }
    })();
    proc.wait_async(null).catch(() => {}).then(() => {
        const status = proc.get_if_exited() ? proc.get_exit_status() : null;
        if (!stopped)
            onExit(status);
    });

    send(config);
    return {
        send,
        stop() {
            if (stopped)
                return;
            stopped = true;
            // Closing stdin ends it; SIGTERM, then SIGKILL, if it hangs.
            stdin.close_async(GLib.PRIORITY_DEFAULT, null, () => {});
            cancellable.cancel();
            stopProcess(proc, LABEL, 3);
        },
    };
}

/**
 * Lets the user pick files to send, in a GTK chooser of its own process;
 * resolves to their paths ([] when cancelled).
 */
export const chooseFiles = () => runChooser([]);

/** Lets the user pick a folder (starting at `start`); its path, or null. */
export async function chooseFolder(start) {
    const [path] = await runChooser(['folder', start]);
    return path ?? null;
}

async function runChooser(args) {
    const helper = Gio.File.new_for_uri(import.meta.url).get_parent()
        .get_child('pick-files-helper.js').get_path();
    const proc = Gio.Subprocess.new(['/usr/bin/gjs', '-m', helper, ...args],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    const input = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
    const [line] = await input.read_line_async(GLib.PRIORITY_DEFAULT, null);
    try {
        const paths = line ? JSON.parse(new TextDecoder().decode(line)) : [];
        return Array.isArray(paths) ? paths.filter(p => typeof p === 'string') : [];
    } catch {
        return [];
    }
}
