// SPDX-License-Identifier: GPL-3.0-or-later
// The user's processes, read from /proc (docs/features/kill-process.md),
// and the check made right before one is killed.
//
// sample() lists every process of this user: its name, command line,
// CPU share since the previous sample and resident memory, and whether
// it is protected (rules.js). Only the user's own processes are read:
// /proc/<pid> belongs to the process's user, so one listing of /proc
// tells which they are. A command line is read once per process.
// verify() reads one process again just before a signal, so a process
// id the kernel has since given to another process is never signalled.
// No St.

import {parseStat} from '../sysmon/parse.js';
import {
    cpuShare, displayName, pageSize, parseCmdline, parseProcStat, parseStatusRssKb,
    parseStatusUid,
} from './parse.js';
import {ancestorsOf, isValidPid, protectedReason} from './rules.js';

const keyOf = (pid, start) => `${pid}:${start}`;
// GNOME Shell's ancestors are a handful (systemd --user, then init); a
// chain this long is not a real one.
const MAX_DEPTH = 64;

export class ProcessSampler {
    /**
     * @param {object} io PROCESS_IO (io.js) or a fake of the same shape
     * @param {{pid: number, uid: number}} self GNOME Shell's process and user
     */
    constructor(io, self) {
        this._io = io;
        this._self = self;
        this._pageSize = null;
        this.reset();
    }

    /** Forgets the previous sample and the command lines (a new visit). */
    reset() {
        this._previous = {machine: null, ticks: new Map()};
        this._commands = new Map();
    }

    /**
     * Every process of this user, unsorted, or null when `cancellable`
     * was cancelled meanwhile. A process is {key, pid, start, name,
     * command, cpu, memory, protected}: key is "pid:start", which no other
     * process has had since boot; cpu is null on its first sample; memory
     * is its resident size in bytes; protected is null or the reason
     * (rules.js protectedReason).
     */
    async sample(cancellable = null) {
        const io = this._io;
        const read = path => io.read(path, cancellable);
        const [entries, statText] = await Promise.all([
            io.owners('/proc', cancellable),
            read('/proc/stat'),
            this._pageSize === null ? this._readPageSize(cancellable) : null,
        ]);
        const pids = entries
            .filter(entry => entry.uid === this._self.uid && /^[1-9]\d*$/.test(entry.name))
            .map(entry => Number(entry.name));
        const stats = await Promise.all(pids.map(pid => read(`/proc/${pid}/stat`)));
        const live = stats.map(parseProcStat)
            .filter(stat => stat && !stat.kernel && !stat.ended);
        for (const stat of live)
            stat.key = keyOf(stat.pid, stat.start);

        // Command lines: once per process, for the name, the filter and
        // the tooltip.
        const missing = live.filter(stat => !this._commands.has(stat.key));
        const cmdlines = await Promise.all(missing.map(stat => read(`/proc/${stat.pid}/cmdline`)));
        if (cancellable?.is_cancelled())
            return null;
        missing.forEach((stat, i) => this._commands.set(stat.key, parseCmdline(cmdlines[i])));
        const keys = new Set(live.map(stat => stat.key));
        for (const key of this._commands.keys()) {
            if (!keys.has(key))
                this._commands.delete(key);
        }

        const machine = statText === null ? null : parseStat(statText).all?.total ?? null;
        const machineTicks = machine !== null && this._previous.machine !== null
            ? machine - this._previous.machine : 0;
        const context = {
            selfPid: this._self.pid,
            ancestors: ancestorsOf(this._self.pid, new Map(live.map(stat => [stat.pid, stat.ppid]))),
        };

        const processes = live.map(stat => {
            const args = this._commands.get(stat.key);
            return {
                key: stat.key,
                pid: stat.pid,
                start: stat.start,
                name: displayName(stat.comm, args),
                command: args.length ? args.join(' ') : `[${stat.comm}]`,
                cpu: cpuShare(this._previous.ticks.get(stat.key), stat.ticks, machineTicks),
                memory: stat.rssPages * this._pageSize,
                protected: protectedReason({pid: stat.pid, comm: stat.comm, args}, context),
            };
        });
        this._previous = {
            machine,
            ticks: new Map(live.map(stat => [stat.key, stat.ticks])),
        };
        return processes;
    }

    /**
     * Whether `target` ({pid, start} from sample()) may be signalled now:
     * 'ok', or why not: 'invalid' (not a process id that can be
     * signalled), 'gone' (it ended; its id may be another process's
     * now), 'not-yours' or 'protected'.
     */
    async verify(target, cancellable = null) {
        if (!isValidPid(target?.pid))
            return 'invalid';
        const dir = `/proc/${target.pid}`;
        const [statText, status, cmdline] = await Promise.all(
            ['stat', 'status', 'cmdline'].map(file => this._io.read(`${dir}/${file}`, cancellable)));
        const stat = parseProcStat(statText);
        if (!stat || stat.pid !== target.pid || stat.start !== target.start || stat.ended)
            return 'gone';
        if (stat.kernel || parseStatusUid(status) !== this._self.uid)
            return 'not-yours';
        const args = parseCmdline(cmdline);
        const ancestors = await this._ancestorsNow(cancellable);
        if (protectedReason({pid: stat.pid, comm: stat.comm, args},
            {selfPid: this._self.pid, ancestors}))
            return 'protected';
        return 'ok';
    }

    // GNOME Shell's ancestors as they are now, read up the chain of
    // parents (whoever owns them); MAX_DEPTH guards against a loop.
    async _ancestorsNow(cancellable) {
        const parents = new Map();
        let pid = this._self.pid;
        for (let depth = 0; depth < MAX_DEPTH && pid > 1 && !parents.has(pid); depth++) {
            // eslint-disable-next-line no-await-in-loop
            const stat = parseProcStat(await this._io.read(`/proc/${pid}/stat`, cancellable));
            if (!stat)
                break;
            parents.set(pid, stat.ppid);
            pid = stat.ppid;
        }
        return ancestorsOf(this._self.pid, parents);
    }

    // From GNOME Shell's own stat and status; once per Shell session.
    async _readPageSize(cancellable) {
        const [statText, status] = await Promise.all([
            this._io.read('/proc/self/stat', cancellable),
            this._io.read('/proc/self/status', cancellable),
        ]);
        this._pageSize = pageSize(parseProcStat(statText)?.rssPages, parseStatusRssKb(status));
    }
}
