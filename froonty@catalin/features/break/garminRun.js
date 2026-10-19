// SPDX-License-Identifier: GPL-3.0-or-later
// Running the Garmin helper (docs/features/break.md, "Garmin"): Gio only,
// for GNOME Shell (today's activities) and the settings window (set up,
// sign in, sign out, remove).
//
// Isolated: the helper (garmin/helper.py) runs in a process of its own,
// with the Python of its own environment (a venv under
// ~/.local/share/froonty/garmin; Python's isolated mode, -I), a short
// fixed environment, that folder as its working folder, and a time limit;
// nothing of it is loaded into the Shell. Whatever goes wrong there
// (Garmin blocks the library, the network is down, the venv is gone) ends
// as {"ok": false, "error": ...}: Froonty goes on without it.
//
// The folder (0700) holds only the venv, the library's sign-in tokens
// (tokens/garmin_tokens.json, 0600) and the last status (status.json):
// never the password, never in a repository.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {stopProcess} from '../../core/subprocess.js';
import {deleteTree, ensurePrivateDir} from '../writing/setup/fs.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_all_async');

// The library, pinned: a new release is tried before it is used.
export const LIBRARY = 'garminconnect==0.3.19';
const SYSTEM_PYTHON = '/usr/bin/python3';
// A reading of today, a sign-in, a set-up: at most this long.
const TODAY_TIMEOUT_S = 60;
const LOGIN_TIMEOUT_S = 180;
const SETUP_TIMEOUT_S = 600;
const MAX_OUTPUT = 1024 * 1024;
const LABEL = 'the Garmin helper';

export const dataDir = () => GLib.build_filenamev([GLib.get_user_data_dir(), 'froonty', 'garmin']);
const venvDir = () => GLib.build_filenamev([dataDir(), 'venv']);
const venvPython = () => GLib.build_filenamev([venvDir(), 'bin', 'python3']);
const helperPath = () => Gio.File.new_for_uri(import.meta.url).get_parent()
    .get_child('garmin').get_child('helper.py').get_path();

/** Whether the helper's environment is there (Settings → Break → Set up). */
export function isSetUp() {
    return GLib.file_test(venvPython(), GLib.FileTest.IS_EXECUTABLE);
}

/** The last status the helper recorded, or null. */
export function readStatus() {
    try {
        const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([dataDir(), 'status.json']));
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}

// A short fixed environment: no PYTHON* variables, no LD_*; the proxies
// pass through, so the helper reaches Garmin as the desktop does.
function launcher(flags) {
    const l = new Gio.SubprocessLauncher({flags});
    const keep = {
        HOME: GLib.get_home_dir(),
        XDG_DATA_HOME: GLib.get_user_data_dir(),
        XDG_CACHE_HOME: GLib.get_user_cache_dir(),
        XDG_CONFIG_HOME: GLib.get_user_config_dir(),
        PATH: '/usr/bin:/bin',
        LANG: GLib.getenv('LANG') ?? 'C.UTF-8',
        PYTHONNOUSERSITE: '1',
    };
    for (const name of ['http_proxy', 'https_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
        const value = GLib.getenv(name);
        if (value)
            keep[name] = value;
    }
    l.set_environ(Object.entries(keep).map(([k, v]) => `${k}=${v}`));
    l.set_cwd(dataDir());
    return l;
}

const failed = (error, message) => ({ok: false, error, message});

// The last JSON line of `text` (the helper prints one).
export function lastJson(text) {
    const lines = String(text ?? '').trim().split('\n').reverse();
    for (const line of lines) {
        try {
            const value = JSON.parse(line);
            if (value && typeof value === 'object')
                return value;
        } catch {}
    }
    return null;
}

function arm(proc, seconds) {
    let timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
        timer = 0;
        console.warn(`Froonty: ${LABEL} did not finish in ${seconds} s`);
        stopProcess(proc, LABEL);
        return GLib.SOURCE_REMOVE;
    });
    return () => {
        if (timer)
            GLib.source_remove(timer);
        timer = 0;
    };
}

/**
 * One helper command whose answer is its last line.
 *
 * @param {string[]} args after helper.py
 * @param {object} [o]
 * @param {?Gio.Cancellable} [o.cancellable]
 * @returns {Promise<object>} the helper's answer, or {ok: false, error}
 */
export async function runHelper(args, {cancellable = null, timeoutS = TODAY_TIMEOUT_S} = {}) {
    if (!isSetUp())
        return failed('setup', 'not set up');
    let proc;
    try {
        await ensurePrivateDir(dataDir());
        proc = launcher(Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE)
            .spawnv([venvPython(), '-I', helperPath(), ...args]);
    } catch (e) {
        return failed('setup', e.message);
    }
    const disarm = arm(proc, timeoutS);
    try {
        const [stdout] = await proc.communicate_utf8_async(null, cancellable);
        if ((stdout?.length ?? 0) > MAX_OUTPUT)
            return failed('other', 'too much output');
        return lastJson(stdout) ?? failed('other', `exited with status ${proc.get_exit_status()}`);
    } catch (e) {
        stopProcess(proc, LABEL);
        return failed('other', e.message);
    } finally {
        disarm();
    }
}

/** Today's (`day`, "YYYY-MM-DD") activities and intensity minutes. */
export const readToday = (day, options) => runHelper(['today', day], options);

/**
 * Signs in: the email and password go to the helper on its stdin only
 * (never in argv or the environment); `askCode` is called if Garmin wants
 * a code (two-step verification) and resolves to it.
 *
 * @returns {Promise<object>} {ok, name} or {ok: false, error, message}
 */
export async function signIn(email, password, askCode) {
    if (!isSetUp())
        return failed('setup', 'not set up');
    await ensurePrivateDir(dataDir());
    const proc = launcher(Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE |
        Gio.SubprocessFlags.STDERR_SILENCE).spawnv([venvPython(), '-I', helperPath(), 'login']);
    const disarm = arm(proc, LOGIN_TIMEOUT_S);
    const stdin = proc.get_stdin_pipe();
    const stdout = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
    const send = value => stdin.write_all_async(new TextEncoder().encode(`${JSON.stringify(value)}\n`),
        GLib.PRIORITY_DEFAULT, null);
    try {
        await send({email, password});
        for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const [line] = await stdout.read_line_async(GLib.PRIORITY_DEFAULT, null);
            if (line === null)
                return failed('other', 'the helper stopped');
            const answer = lastJson(new TextDecoder().decode(line));
            if (answer?.need === 'mfa') {
                // eslint-disable-next-line no-await-in-loop
                const code = await askCode();
                if (code === null) {
                    stopProcess(proc, LABEL);
                    return failed('auth', 'cancelled');
                }
                // eslint-disable-next-line no-await-in-loop
                await send({mfa: code});
            } else if (answer) {
                return answer;
            }
        }
    } catch (e) {
        stopProcess(proc, LABEL);
        return failed('other', e.message);
    } finally {
        disarm();
        stdin.close_async(GLib.PRIORITY_DEFAULT, null, null);
    }
}

/** Signs out: the tokens are deleted (the venv stays). */
export const signOut = () => runHelper(['logout']);

async function runStep(argv, onLine) {
    const proc = launcher(Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE)
        .spawnv(argv);
    const disarm = arm(proc, SETUP_TIMEOUT_S);
    const out = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
    try {
        for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const [line] = await out.read_line_async(GLib.PRIORITY_DEFAULT, null);
            if (line === null)
                break;
            onLine?.(new TextDecoder().decode(line));
        }
        await proc.wait_async(null);
        return proc.get_successful();
    } finally {
        disarm();
    }
}

/**
 * Makes the helper's environment: a venv with the pinned library, from
 * PyPI (the only download; on the user's click in Settings).
 *
 * @param {Function} [onLine] each line pip prints
 * @returns {Promise<object>} {ok} or {ok: false, error, message}
 */
export async function setUp(onLine) {
    try {
        await ensurePrivateDir(dataDir());
        if (!await runStep([SYSTEM_PYTHON, '-I', '-m', 'venv', venvDir()], onLine))
            return failed('setup', 'python3 -m venv failed (Debian/Ubuntu: apt install python3-venv)');
        const pip = [venvPython(), '-I', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input',
            '--require-virtualenv', LIBRARY];
        if (!await runStep(pip, onLine))
            return failed('setup', 'pip could not install the library');
        return await runHelper(['check']);
    } catch (e) {
        return failed('setup', e.message);
    }
}

/** Removes everything: the tokens, the venv, the status (after signing out). */
export async function removeAll() {
    await signOut().catch(() => null);
    const root = GLib.build_filenamev([GLib.get_user_data_dir(), 'froonty']);
    await deleteTree(dataDir(), root);
}
