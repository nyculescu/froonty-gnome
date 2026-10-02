// SPDX-License-Identifier: GPL-3.0-or-later
// What the Kill Process tab may kill, and in which order it lists
// processes (docs/features/kill-process.md). Pure functions, so they load
// in the Shell, in the preferences window and in plain gjs tests.

/**
 * Programs whose death ends the session or takes the desktop with it.
 * Froonty never offers to kill them, whoever started them. Matched on the
 * kernel's name (comm, cut to 15 characters) and on argv[0]'s file name.
 * Short on purpose; anything else is the user's call.
 */
export const PROTECTED_NAMES = [
    'gnome-shell', // the compositor and desktop; Froonty runs inside it
    'gnome-session', // and every gnome-session-* helper (service, ctl, …)
    'gdm-wayland-session', // the login session's wrapper: its end is a logout
    'gdm-x-session',
    'systemd', // the user's service manager (systemd --user)
    '(sd-pam)', // its PAM session
    'Xwayland', // every X11 window
    'dbus-daemon', // the session and accessibility buses
    'dbus-broker',
    'dbus-broker-launch',
    'pipewire', // sound, screen sharing and the panic mute buttons
    'pipewire-pulse',
    'wireplumber',
    'gnome-keyring-daemon', // passwords and keys of the session
];

// Names matched as a prefix too: "gnome-session" covers
// gnome-session-binary, gnome-session-service, gnome-session-ctl, …
const PREFIXES = ['gnome-session'];
const COMM_LENGTH = 15;
// The kernel's largest process id (PID_MAX_LIMIT on 64-bit, 2^22).
const PID_MAX = 4194304;

/**
 * Whether `pid` may be signalled at all: a whole number above 1. 0 and
 * negative numbers mean process groups, -1 every process; 1 is init.
 */
export function isValidPid(pid) {
    return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1 && pid <= PID_MAX;
}

/** Whether a process is one of PROTECTED_NAMES, by comm or by argv[0]. */
export function isProtectedName(comm, args = []) {
    const base = args[0]?.split('/').pop() ?? '';
    return PROTECTED_NAMES.some(name => {
        const prefix = PREFIXES.includes(name);
        const short = name.slice(0, COMM_LENGTH);
        return comm === short || base === name ||
            (prefix && (comm.startsWith(name) || base.startsWith(name)));
    });
}

/**
 * GNOME Shell's ancestors: whatever started it (systemd --user,
 * gnome-session, gdm's session wrapper). Ending one ends the Shell.
 *
 * @param {number} selfPid GNOME Shell's process id
 * @param {Map<number, number>} parents pid -> parent pid, as far as known
 * @returns {Set<number>}
 */
export function ancestorsOf(selfPid, parents) {
    const ancestors = new Set();
    for (let pid = parents.get(selfPid); pid > 1 && !ancestors.has(pid); pid = parents.get(pid))
        ancestors.add(pid);
    return ancestors;
}

/**
 * Why a process must not be killed from the tab, or null when it may be.
 *
 * @param {{pid: number, comm: string, args: string[]}} process
 * @param {{selfPid: number, ancestors: Set<number>}} context
 * @returns {?('shell'|'session')} 'shell' for GNOME Shell itself
 */
export function protectedReason({pid, comm, args}, {selfPid, ancestors}) {
    if (pid === selfPid)
        return 'shell';
    if (!isValidPid(pid) || ancestors.has(pid) || isProtectedName(comm, args))
        return 'session';
    return null;
}

export const SORTS = ['cpu', 'memory'];

/**
 * The processes to list: those matching `filter` (name, command line or
 * process id, ignoring case), most CPU or memory first, at most `limit`.
 * Without a CPU reading yet (a visit's first sample), memory decides.
 *
 * @returns {{shown: object[], matching: number}}
 */
export function rankProcesses(processes, {sort = 'cpu', filter = '', limit = 30} = {}) {
    const needle = filter.trim().toLowerCase();
    const matching = needle
        ? processes.filter(p => `${p.pid} ${p.name} ${p.command}`.toLowerCase().includes(needle))
        : [...processes];
    const cpu = p => p.cpu ?? -1;
    const byCpu = (a, b) => cpu(b) - cpu(a);
    const byMemory = (a, b) => b.memory - a.memory;
    const [first, second] = sort === 'memory' ? [byMemory, byCpu] : [byCpu, byMemory];
    matching.sort((a, b) => first(a, b) || second(a, b) || a.pid - b.pid);
    return {shown: matching.slice(0, limit), matching: matching.length};
}
