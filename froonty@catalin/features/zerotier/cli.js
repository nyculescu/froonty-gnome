// SPDX-License-Identifier: GPL-3.0-or-later
// What the ZeroTier tab and its settings page share: where ZeroTier's
// commands are, running them, and the argv of the elevated actions. No St
// or Gtk, so it loads in the Shell, in prefs and in plain gjs tests.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');

export const UNIT = 'zerotier-one.service';
// zerotier-cli reads this root-only token unless the user has a copy at
// USER_TOKEN; Froonty never reads either, it only has the copy made.
export const NODE_TOKEN = '/var/lib/zerotier-one/authtoken.secret';
export const USER_TOKEN_NAME = '.zeroTierOneAuthToken';
// zerotier-cli's message when the user cannot read the node's API token.
export const NO_TOKEN = /authtoken\.secret/;
const SIGTERM = 15;

const PATHS = {
    'zerotier-cli': ['/usr/sbin/zerotier-cli', '/usr/bin/zerotier-cli',
        '/usr/local/sbin/zerotier-cli', '/usr/local/bin/zerotier-cli'],
    systemctl: ['/usr/bin/systemctl', '/bin/systemctl'],
    pkexec: ['/usr/bin/pkexec', '/bin/pkexec'],
    install: ['/usr/bin/install', '/bin/install'],
};

async function isExecutable(path) {
    try {
        const info = await Gio.File.new_for_path(path).query_info_async(
            'access::can-execute,standard::type', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, null);
        return info.get_file_type() === Gio.FileType.REGULAR &&
            info.get_attribute_boolean('access::can-execute');
    } catch (e) {
        return false;
    }
}

/**
 * Fixed system locations only, so an elevated argv never comes from $PATH
 * or a user-writable place.
 *
 * @returns {Promise<?string>}
 */
export async function findExecutable(name) {
    for (const path of PATHS[name] ?? []) {
        // eslint-disable-next-line no-await-in-loop
        if (await isExecutable(path))
            return path;
    }
    return null;
}

/** Whether ZeroTier is installed: its command-line client is there. */
export async function isInstalled(find = findExecutable) {
    return Boolean(await find('zerotier-cli'));
}

export function userTokenPath() {
    return GLib.build_filenamev([GLib.get_home_dir(), USER_TOKEN_NAME]);
}

/**
 * The elevated argv of a settings or tab action.
 *
 * @param {string} action 'start', 'stop' or 'allow'
 * @param {object} paths {pkexec, systemctl, install} from findExecutable
 * @param {object} [user] {name, tokenPath} for 'allow'
 */
export function actionArgv(action, {pkexec, systemctl, install} = {}, user = {}) {
    if (action === 'start' || action === 'stop') {
        if (!pkexec || !systemctl)
            throw new Error('Polkit and systemctl are required for service control.');
        return [pkexec, systemctl, action, UNIT];
    }
    if (action === 'allow') {
        if (!pkexec || !install)
            throw new Error('Polkit and install are required to allow status access.');
        if (!user.name || !user.tokenPath)
            throw new Error('No user to allow.');
        return [pkexec, install, '-m', '600', '-o', user.name, NODE_TOKEN, user.tokenPath];
    }
    throw new Error('Unsupported ZeroTier action.');
}

/** Runs `argv` (no shell); resolves {success, stdout, stderr}. */
export async function run(argv, cancellable = null) {
    const proc = Gio.Subprocess.new(argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const cancelId = cancellable?.connect(() => proc.send_signal(SIGTERM)) ?? 0;
    try {
        const [stdout, stderr] = await proc.communicate_utf8_async(null, cancellable);
        return {
            success: proc.get_successful(),
            stdout: stdout ?? '',
            stderr: stderr ?? '',
        };
    } finally {
        if (cancelId)
            cancellable.disconnect(cancelId);
    }
}

/**
 * `systemctl is-enabled`: true (starts at boot), false, or null when it
 * cannot tell (e.g. a static or generated unit). Froonty only reports it;
 * it is changed in ZeroTier's own setup.
 */
export function parseEnabled(stdout) {
    const status = stdout.trim();
    if (status === 'enabled' || status === 'enabled-runtime')
        return true;
    if (status === 'disabled' || status === 'masked' || status === 'masked-runtime')
        return false;
    return null;
}
