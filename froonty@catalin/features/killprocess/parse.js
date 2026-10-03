// SPDX-License-Identifier: GPL-3.0-or-later
// Parsers for what the Kill Process tab reads from /proc
// (docs/features/kill-process.md). Pure functions of text, so they load
// in plain gjs tests. /proc/stat (the whole machine's CPU time) is parsed
// by the Btop tab's parseStat (features/sysmon/parse.js).

// /proc/<pid>/stat flags: a kernel thread (PF_KTHREAD, include/linux/sched.h).
const PF_KTHREAD = 0x00200000;
// States of a process whose main thread has ended (a zombie, or dead).
const ENDED_STATES = new Set(['Z', 'X', 'x']);
// The fields read: from "state" (3) to "rss" (24).
const FIELDS = 22;

/**
 * One process's /proc/<pid>/stat, or null when it is not one. comm is
 * between the first "(" and the last ")": it may hold spaces and
 * brackets of its own ("(sd-pam)").
 *
 * A process has ended (waits for its parent to reap it) when its main
 * thread is a zombie and no other thread is left. A zombie main thread
 * with others still running (it called pthread_exit) is a live process:
 * the kernel then reports no memory and no command line for it
 * (`leaderExited`), but its CPU time is all of its threads', and a
 * signal still reaches them.
 *
 * @returns {?{pid: number, comm: string, state: string, ppid: number,
 *   ticks: number, threads: number, start: number, rssPages: number,
 *   kernel: boolean, ended: boolean, leaderExited: boolean}} ticks is
 *   user + system CPU time, start the start time since boot, both in
 *   clock ticks
 */
export function parseProcStat(text) {
    if (typeof text !== 'string')
        return null;
    const open = text.indexOf('(');
    const close = text.lastIndexOf(')');
    if (open < 1 || close < open)
        return null;
    const pid = Number(text.slice(0, open).trim());
    // Fields from the third ("state") on; man 5 proc numbers them from 1.
    // The kernel separates them with one space; only those needed are
    // split off (this runs for every process at every reading).
    const fields = text.slice(close + 1).trimStart().split(' ', FIELDS);
    if (!Number.isSafeInteger(pid) || pid < 1 || fields.length < FIELDS)
        return null;
    const field = n => Number(fields[n - 3]);
    // ppid, flags, utime, stime, num_threads, starttime, rss.
    const values = [4, 9, 14, 15, 20, 22, 24].map(field);
    if (!values.every(Number.isFinite))
        return null;
    const [ppid, flags, utime, stime, threads, start, rssPages] = values;
    const state = fields[0];
    const zombie = ENDED_STATES.has(state);
    return {
        pid,
        comm: text.slice(open + 1, close),
        state,
        ppid,
        ticks: utime + stime,
        threads,
        start,
        rssPages,
        kernel: (flags & PF_KTHREAD) !== 0,
        ended: zombie && threads <= 1,
        leaderExited: zombie && threads > 1,
    };
}

/** The real user id from /proc/<pid>/status ("Uid: real effective saved fs"), or null. */
export function parseStatusUid(text) {
    const match = /^Uid:\s+(\d+)/m.exec(text ?? '');
    return match ? Number(match[1]) : null;
}

/** VmRSS from /proc/<pid>/status, in kB, or null. */
export function parseStatusRssKb(text) {
    const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(text ?? '');
    return match ? Number(match[1]) : null;
}

/** /proc/<pid>/cmdline's arguments (NUL-separated); [] when empty. */
export function parseCmdline(text) {
    const args = (text ?? '').split('\0');
    while (args.length && args.at(-1) === '')
        args.pop();
    return args;
}

/**
 * The name to show: the executable's name from argv[0] when comm is
 * that name (the kernel cuts comm to 15 characters, "gnome-session-b"),
 * otherwise comm, which a process may set itself ("Isolated Web Co").
 */
export function displayName(comm, args) {
    const base = args[0]?.split('/').pop() ?? '';
    if (base && (base === comm || (comm.length >= 15 && base.startsWith(comm))))
        return base;
    return comm || base;
}

/**
 * The kernel's page size in bytes, from one process's resident size
 * in pages (stat) and in kB (status): 4 KiB on x86, 4, 16 or 64 KiB on
 * Arm. 4096 when they do not tell.
 */
export function pageSize(rssPages, rssKb) {
    if (!(rssPages > 0) || !(rssKb > 0))
        return 4096;
    const size = 2 ** Math.round(Math.log2(rssKb * 1024 / rssPages));
    return size >= 4096 && size <= 262144 ? size : 4096;
}

/**
 * A process's share of the whole computer's CPU time between two
 * samples, in percent (0-100, as GNOME System Monitor shows it by
 * default), or null when unknown: the first sample of a process, or
 * a counter that went back.
 *
 * @param {number|undefined} previous the process's ticks then
 * @param {number} current its ticks now
 * @param {number} machineTicks all CPUs' ticks in between (/proc/stat)
 */
export function cpuShare(previous, current, machineTicks) {
    if (previous === undefined || previous === null || !(machineTicks > 0) || current < previous)
        return null;
    return Math.min(100, 100 * (current - previous) / machineTicks);
}
