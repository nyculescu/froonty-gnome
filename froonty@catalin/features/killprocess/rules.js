// SPDX-License-Identifier: GPL-3.0-or-later
// What the Kill Process tab may kill, in which order it lists processes
// and how it counts them (docs/features/kill-process.md). Pure functions,
// so they load in the Shell, in the preferences window and in plain gjs tests.

/**
 * Programs whose death ends the session, or takes a core part of the
 * desktop with it until the next login. Froonty never offers to kill
 * them, whoever started them. Matched on the kernel's name (comm, cut to
 * 15 characters) and on argv[0]'s file name.
 *
 * The tab's first step is SIGTERM, and systemd restarts a user service
 * after a crash only: a SIGTERM counts as a clean exit (systemd.service(5),
 * Restart=). So gsd-* and ibus-daemon stay gone once asked to quit.
 * Services that D-Bus starts again when next needed (the portals,
 * Evolution's, GVfs, Online Accounts, the file indexer) are not here, nor
 * any app: anything else is the user's call.
 */
export const PROTECTED_NAMES = [
    'gnome-shell', // the compositor and desktop; Froonty runs inside it
    'gnome-session', // and every gnome-session-* helper (service, ctl, …)
    'gdm-wayland-session', // the login session's wrapper: its end is a logout
    'gdm-x-session',
    'systemd', // the user's service manager (systemd --user)
    '(sd-pam)', // its PAM session
    'Xwayland', // every X11 window
    'mutter-x11-frames', // X11 windows' title bars; mutter starts it again after a crash only
    'dbus-daemon', // the session and accessibility buses
    'dbus-broker',
    'dbus-broker-launch',
    'at-spi-bus-launcher', // the accessibility bus: screen reader, zoom following the focus
    'at-spi2-registryd', // its registry: which apps and events a screen reader is told of
    'pipewire', // sound, screen sharing and the panic mute buttons
    'pipewire-pulse',
    'wireplumber',
    'gnome-keyring-daemon', // passwords and keys of the session
    'gsd-', // GNOME's settings daemon, a process per job: power, media keys, Night Light, …
    'ibus-daemon', // typing through input methods (IBus), in every app and the Shell
    'ibus-x11', // the same for X11 apps (XIM); started once, when Xwayland starts
];

/**
 * Those of PROTECTED_NAMES matched as a prefix too: "gnome-session"
 * covers gnome-session-binary, -service, -ctl, …; "gsd-" every settings
 * daemon process (gsd-power, gsd-media-keys, gsd-xsettings, …).
 */
export const PROTECTED_PREFIXES = ['gnome-session', 'gsd-'];
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
        const prefix = PROTECTED_PREFIXES.includes(name);
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
 * @param {{pid: number, comm: string, args: string[], named?: boolean}}
 *   process; `named`, when given, is isProtectedName(comm, args) worked
 *   out earlier (the sampler keeps it for each process), and comm and
 *   args are then not needed
 * @param {{selfPid: number, ancestors: Set<number>}} context
 * @returns {?('shell'|'session')} 'shell' for GNOME Shell itself
 */
export function protectedReason({pid, comm, args, named = isProtectedName(comm, args)},
    {selfPid, ancestors}) {
    if (pid === selfPid)
        return 'shell';
    if (!isValidPid(pid) || ancestors.has(pid) || named)
        return 'session';
    return null;
}

export const SORTS = ['cpu', 'memory', 'threads'];

/**
 * The processes to list, all of those matching `filter` (name, command
 * line or process id, ignoring case): most CPU, memory or threads first.
 * Ties go to the busier process (CPU, then memory), then to the lower
 * process id, so the order holds still between equal readings. Without
 * a CPU reading yet (a visit's first sample), memory decides.
 *
 * @param {object[]} processes from ProcessSampler.sample
 * @param {{sort?: string, filter?: string}} [options] sort is one of SORTS
 * @returns {object[]} a new array
 */
export function rankProcesses(processes, {sort = 'cpu', filter = ''} = {}) {
    const matching = matchingProcesses(processes, filter);
    const cpu = p => p.cpu ?? -1;
    const byCpu = (a, b) => cpu(b) - cpu(a);
    const byMemory = (a, b) => b.memory - a.memory;
    const byThreads = (a, b) => b.threads - a.threads;
    const order = {
        cpu: [byCpu, byMemory],
        memory: [byMemory, byCpu],
        threads: [byThreads, byCpu, byMemory],
    }[sort] ?? [byCpu, byMemory];
    return matching.sort((a, b) => {
        for (const compare of order) {
            const result = compare(a, b);
            if (result)
                return result;
        }
        return a.pid - b.pid;
    });
}

// Those of `processes` that `filter` matches (all for an empty one), in
// a new array.
function matchingProcesses(processes, filter) {
    const needle = filter.trim().toLowerCase();
    return needle
        ? processes.filter(p => `${p.pid} ${p.name} ${p.command}`.toLowerCase().includes(needle))
        : [...processes];
}

/** How many of `processes` the filter matches, as rankProcesses lists them. */
export function countMatching(processes, filter = '') {
    return filter.trim() ? matchingProcesses(processes, filter).length : processes.length;
}

/**
 * The line over the list: how many processes it holds, "Your 256
 * processes" or, with a filter, "12 of your 256 processes match". Takes
 * the caller's ngettext (the Shell's, or a test's).
 *
 * @param {number} total all of the user's processes
 * @param {number} matching those the filter matches
 * @param {boolean} filtered whether a filter is typed
 * @param {Function} ngettext
 */
export function countText(total, matching, filtered, ngettext) {
    const [text, ...values] = filtered
        ? [ngettext('%d of your %d processes matches', '%d of your %d processes match',
            matching), matching, total]
        : [ngettext('Your %d process', 'Your %d processes', total), total];
    return values.reduce((result, value) => result.replace('%d', String(value)), text);
}
