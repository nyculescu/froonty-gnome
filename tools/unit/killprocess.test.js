// SPDX-License-Identifier: GPL-3.0-or-later
// Kill Process tab: parsers, safety rules, sorting, the sampler and the
// kill flow, over a fake /proc. Nothing here signals a real process: the
// fake io's run() only records the arguments it was given.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    cpuShare, displayName, pageSize, parseCmdline, parseProcStat, parseStatusRssKb,
    parseStatusUid,
} from '../../froonty@catalin/features/killprocess/parse.js';
import {
    ancestorsOf, countMatching, countText, isProtectedName, isValidPid, PROTECTED_NAMES,
    protectedReason, rankProcesses, SORTS,
} from '../../froonty@catalin/features/killprocess/rules.js';
import {PROCESS_IO} from '../../froonty@catalin/features/killprocess/io.js';
import {KILL_PATHS, killArgv} from '../../froonty@catalin/features/killprocess/kill.js';
import {BATCH, ProcessSampler} from '../../froonty@catalin/features/killprocess/sampler.js';
import {FORCE_AFTER_S, KillProcessService} from '../../froonty@catalin/features/killprocess/service.js';
import {done, eq, ok, test} from './test.js';

const UID = 1000;

/** A /proc/<pid>/stat line; fields as in man 5 proc. */
function statLine({pid, comm, state = 'S', ppid = 1, flags = 0, utime = 0, stime = 0,
    threads = 1, start = 100, rss = 10}) {
    return `${pid} (${comm}) ${state} ${ppid} ${pid} ${pid} 0 -1 ${flags} 0 0 0 0 ` +
        `${utime} ${stime} 0 0 20 0 ${threads} 0 ${start} 1000000 ${rss} 18446744073709551615 ` +
        '1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0\n';
}

const status = uid => `Name:\tx\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nVmRSS:\t   16000 kB\n`;

// GNOME Shell (2000) under systemd --user (1500), and what the user runs.
function machine() {
    return {
        self: {pid: 2000, uid: UID},
        machineTicks: 10000,
        procs: [
            {pid: 1, comm: 'systemd', uid: 0, ppid: 0, args: ['/sbin/init']},
            {pid: 1500, comm: 'systemd', ppid: 1, args: ['/usr/lib/systemd/systemd', '--user']},
            {pid: 2000, comm: 'gnome-shell', ppid: 1500, rss: 1000, utime: 500,
                args: ['/usr/bin/gnome-shell']},
            {pid: 3000, comm: 'firefox', ppid: 2000, rss: 5000, utime: 100, threads: 87,
                args: ['/usr/lib/firefox/firefox']},
            {pid: 3100, comm: 'Isolated Web Co', ppid: 3000, rss: 3000, utime: 50,
                args: ['/usr/lib/firefox/firefox', '-contentproc', '12']},
            {pid: 3200, comm: 'gnome-session-b', ppid: 1500, rss: 200,
                args: ['/usr/libexec/gnome-session-binary']},
            {pid: 3300, comm: 'sleep', ppid: 3000, rss: 50, start: 7777, args: ['sleep', '600']},
            {pid: 3400, comm: 'defunct', ppid: 3000, state: 'Z', args: []},
            {pid: 3500, comm: 'kworker/0:1', ppid: 2, flags: 0x00200000, args: []},
            {pid: 4000, comm: 'sshd', uid: 0, ppid: 1, args: ['/usr/sbin/sshd']},
        ],
    };
}

/**
 * A fake /proc (and kill) over `spec`, which tests may change between
 * samples. run() records each argv and, by default, ends the process on
 * SIGKILL and on SIGTERM unless it has `ignoresTerm`. pause() records
 * how many reads came before it, and runs `spec.onPause` if set.
 */
function fakeIo(spec) {
    const reads = [];
    const runs = [];
    const pauses = [];
    const find = pid => spec.procs.find(p => p.pid === pid);
    const io = {
        pause: async () => {
            pauses.push(reads.length);
            spec.onPause?.();
        },
        owners: async path => path === '/proc'
            ? [...spec.procs.map(p => ({name: String(p.pid), uid: p.uid ?? UID})),
                {name: 'self', uid: 0}, {name: 'stat', uid: 0}]
            : [],
        read: async path => {
            reads.push(path);
            if (path === '/proc/stat')
                return `cpu  ${spec.machineTicks} 0 0 0 0 0 0 0 0 0\ncpu0 1 0 0 0\n`;
            if (path === '/proc/self/stat')
                return statLine({pid: spec.self.pid, comm: 'gnome-shell', rss: 1000});
            if (path === '/proc/self/status')
                return status(UID);
            const match = /^\/proc\/(\d+)\/(stat|status|cmdline)$/.exec(path);
            const proc = match && find(Number(match[1]));
            if (!proc)
                return null;
            if (match[2] === 'stat')
                return statLine(proc);
            if (match[2] === 'status')
                return status(proc.uid ?? UID);
            return proc.args.map(arg => `${arg}\0`).join('');
        },
        executable: async path => (spec.executables ?? KILL_PATHS).includes(path),
        run: async argv => {
            runs.push(argv);
            const pid = Number(argv.at(-1));
            const proc = find(pid);
            if (!proc)
                return null;
            if (argv.includes('KILL') || !proc.ignoresTerm)
                spec.procs = spec.procs.filter(p => p !== proc);
            return '';
        },
    };
    return {io, reads, runs, pauses};
}

// Lets fake reads (resolved promises) and their chains finish.
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

// ---------------------------------------------------------------- parsers

test('a stat line: comm with spaces and brackets, ticks, threads, start, memory', () => {
    const stat = parseProcStat(statLine({pid: 42, comm: 'a (b) c)', ppid: 7, utime: 30,
        stime: 12, threads: 23, start: 999, rss: 64}));
    eq(stat, {pid: 42, comm: 'a (b) c)', state: 'S', ppid: 7, ticks: 42, threads: 23,
        start: 999, rssPages: 64, kernel: false, ended: false, leaderExited: false});
    // num_threads is field 20, between nice (19) and itrealvalue (21).
    eq(parseProcStat(statLine({pid: 9, comm: 'x', threads: 1})).threads, 1);
    eq(parseProcStat(statLine({pid: 9, comm: 'x', threads: 'many'})), null);
    eq(parseProcStat(statLine({pid: 2401, comm: '(sd-pam)'})).comm, '(sd-pam)');
    ok(parseProcStat(statLine({pid: 9, comm: 'kworker', flags: 0x00208040})).kernel);
    ok(parseProcStat(statLine({pid: 9, comm: 'x', state: 'Z'})).ended);
    ok(!parseProcStat(statLine({pid: 9, comm: 'x'})).leaderExited);
    eq(parseProcStat(null), null);
    eq(parseProcStat(''), null);
    eq(parseProcStat('12 (short) S 1 2'), null);
    eq(parseProcStat('x (a) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22'), null);
});

test('a zombie main thread with other threads running is a live process', () => {
    // pthread_exit() in main: the kernel shows the main thread as a zombie
    // (state Z), with the others counted (checked on a real process,
    // 2026-10-02: Z, num_threads 2, rss 0, cmdline empty).
    const leader = parseProcStat(statLine({pid: 9, comm: 'python3', state: 'Z', threads: 2,
        utime: 99, rss: 0}));
    ok(!leader.ended && leader.leaderExited, JSON.stringify(leader));
    eq(leader.ticks, 99);
    // An exited process waiting to be reaped counts its one thread.
    for (const state of ['Z', 'X']) {
        const zombie = parseProcStat(statLine({pid: 9, comm: 'x', state, threads: 1}));
        ok(zombie.ended && !zombie.leaderExited, state);
    }
});

test('this test process\'s own stat parses (real /proc, read only)', () => {
    // The Threads line of /proc/self/status, read before and after (gjs
    // may start a thread in between).
    const threads = () => {
        const [, status] = GLib.file_get_contents('/proc/self/status');
        return Number(/^Threads:\s+(\d+)/m.exec(new TextDecoder().decode(status))[1]);
    };
    const before = threads();
    const [, bytes] = GLib.file_get_contents('/proc/self/stat');
    const after = threads();
    const stat = parseProcStat(new TextDecoder().decode(bytes));
    eq(stat.pid, new Gio.Credentials().get_unix_pid());
    ok(stat.start > 0 && stat.rssPages > 0 && !stat.kernel && !stat.ended);
    ok(stat.threads >= 1 && stat.threads >= Math.min(before, after) &&
        stat.threads <= Math.max(before, after), `${stat.threads}, status ${before}/${after}`);
});

test('status: real user id and resident memory; cmdline: NUL-separated', () => {
    eq(parseStatusUid('Name:\tx\nUid:\t1000\t0\t0\t0\n'), 1000);
    eq(parseStatusUid('Name:\tx\n'), null);
    eq(parseStatusUid(null), null);
    eq(parseStatusRssKb(status(1)), 16000);
    eq(parseCmdline('sleep\x00600\x00'), ['sleep', '600']);
    eq(parseCmdline(''), []);
    eq(parseCmdline(null), []);
});

test('names: argv[0] when comm is it, cut or not; comm when the process renamed itself', () => {
    eq(displayName('gnome-session-b', ['/usr/libexec/gnome-session-binary']), 'gnome-session-binary');
    eq(displayName('sleep', ['sleep', '600']), 'sleep');
    eq(displayName('Isolated Web Co', ['/usr/lib/firefox/firefox']), 'Isolated Web Co');
    eq(displayName('python3', ['/usr/bin/python3', 'tool.py']), 'python3');
    eq(displayName('kthreadd', []), 'kthreadd');
});

test('page size from resident pages and kB; CPU share of the whole computer', () => {
    eq(pageSize(1000, 4000), 4096);
    eq(pageSize(1000, 16000), 16384);
    eq(pageSize(1001, 4003), 4096);
    eq(pageSize(0, 4000), 4096);
    eq(pageSize(undefined, null), 4096);
    eq(cpuShare(100, 150, 1000), 5);
    eq(cpuShare(undefined, 150, 1000), null);
    eq(cpuShare(100, 150, 0), null);
    eq(cpuShare(200, 150, 1000), null);
    eq(cpuShare(0, 5000, 1000), 100);
});

// ---------------------------------------------------------------- safety rules

test('only whole process ids above 1 can be signalled', () => {
    for (const pid of [2, 300, 4194304])
        ok(isValidPid(pid), `${pid} is valid`);
    for (const pid of [0, 1, -1, -300, 1.5, NaN, Infinity, 4194305, '300', null, undefined, '-1'])
        ok(!isValidPid(pid), `${pid} is not`);
});

test('kill argv: the system kill only, TERM or KILL only, one valid process id', () => {
    eq(killArgv('/usr/bin/kill', 3300, 'TERM'), ['/usr/bin/kill', '-s', 'TERM', '3300']);
    eq(killArgv('/bin/kill', 3300, 'KILL'), ['/bin/kill', '-s', 'KILL', '3300']);
    const throws = (args, why) => {
        let threw = false;
        try {
            killArgv(...args);
        } catch (e) {
            threw = true;
        }
        ok(threw, why);
    };
    throws(['kill', 3300, 'TERM'], '$PATH lookup');
    throws(['/home/u/bin/kill', 3300, 'TERM'], 'a user-writable kill');
    throws(['/usr/bin/kill', -1, 'TERM'], 'every process');
    throws(['/usr/bin/kill', 0, 'TERM'], 'the process group');
    throws(['/usr/bin/kill', 1, 'KILL'], 'init');
    throws(['/usr/bin/kill', '3300; rm -rf ~', 'TERM'], 'text');
    throws(['/usr/bin/kill', 3300, 'HUP'], 'another signal');
    throws(['/usr/bin/kill', 3300, '-9'], 'a raw option');
});

test('session programs are protected by comm (cut to 15) or by argv[0]', () => {
    for (const name of PROTECTED_NAMES)
        ok(isProtectedName(name.slice(0, 15), []), `${name} by comm`);
    ok(isProtectedName('gnome-session-s', ['/usr/libexec/gnome-session-service']));
    ok(isProtectedName('gnome-session-c', []), 'every gnome-session helper');
    ok(isProtectedName('gnome-keyring-d', []));
    ok(isProtectedName('renamed', ['/usr/bin/pipewire']), 'by argv[0]');
    ok(isProtectedName('(sd-pam)', ['(sd-pam)']));
    for (const [comm, args] of [['sleep', ['sleep']], ['gnome-shell-cal', []],
        ['systemd-run', ['/usr/bin/systemd-run']], ['firefox', ['/usr/lib/firefox/firefox']],
        ['pipewire-media', []]])
        ok(!isProtectedName(comm, args), `${comm} is not protected`);
});

test('GNOME Shell\'s ancestors, and why a process is protected', () => {
    const parents = new Map([[2000, 1500], [1500, 1], [3000, 2000]]);
    eq([...ancestorsOf(2000, parents)], [1500]);
    eq([...ancestorsOf(2000, new Map([[2000, 10], [10, 11], [11, 10]]))], [10, 11]);
    eq([...ancestorsOf(2000, new Map())], []);
    const context = {selfPid: 2000, ancestors: new Set([1500])};
    eq(protectedReason({pid: 2000, comm: 'x', args: []}, context), 'shell');
    eq(protectedReason({pid: 1500, comm: 'x', args: []}, context), 'session');
    eq(protectedReason({pid: 3200, comm: 'Xwayland', args: []}, context), 'session');
    eq(protectedReason({pid: 3300, comm: 'sleep', args: ['sleep']}, context), null);
    eq(protectedReason({pid: 1, comm: 'x', args: []}, context), 'session');
    // A protected name worked out earlier (the sampler keeps it).
    eq(protectedReason({pid: 3300, named: true}, context), 'session');
    eq(protectedReason({pid: 3300, named: false}, context), null);
    eq(protectedReason({pid: 2000, named: false}, context), 'shell');
});

test('ranking: CPU, memory or threads first, no CPU yet means memory, filter', () => {
    const p = (pid, name, cpu, memory, threads, command = name) =>
        ({pid, name, cpu, memory, threads, command});
    const list = [p(10, 'a', 1, 500, 4), p(11, 'b', 9, 100, 4), p(12, 'c', null, 900, 1),
        p(13, 'd', 9, 300, 30, '/opt/d --flag')];
    const pids = ranked => ranked.map(x => x.pid);
    eq(SORTS, ['cpu', 'memory', 'threads']);
    eq(pids(rankProcesses(list, {sort: 'cpu'})), [13, 11, 10, 12]);
    eq(pids(rankProcesses(list, {sort: 'memory'})), [12, 10, 13, 11]);
    // Equal thread counts: the busier first (11 has more CPU than 10).
    eq(pids(rankProcesses(list, {sort: 'threads'})), [13, 11, 10, 12]);
    eq(pids(rankProcesses(list.map(x => ({...x, cpu: null})), {sort: 'cpu'})), [12, 10, 13, 11]);
    eq(pids(rankProcesses(list, {filter: ' --FLAG '})), [13]);
    eq(pids(rankProcesses(list, {filter: '12'})), [12]);
    eq(rankProcesses(list, {filter: 'nothing'}).length, 0);
    eq(pids(rankProcesses(list, {sort: 'nonsense'})), [13, 11, 10, 12], 'unknown: by CPU');
    ok(rankProcesses(list) !== list && pids(list).join() === '10,11,12,13', 'a new array');
});

test('ranking ties: threads, then CPU, then memory, then the lower process id', () => {
    const p = (pid, cpu, memory, threads) =>
        ({pid, name: 'x', command: 'x', cpu, memory, threads});
    const list = [p(50, 1, 100, 8), p(40, 1, 100, 8), p(30, 1, 200, 8), p(20, 2, 100, 8),
        p(10, null, 900, 8)];
    const pids = ranked => ranked.map(x => x.pid);
    eq(pids(rankProcesses(list, {sort: 'threads'})), [20, 30, 40, 50, 10]);
    eq(pids(rankProcesses(list, {sort: 'cpu'})), [20, 30, 40, 50, 10]);
    eq(pids(rankProcesses(list, {sort: 'memory'})), [10, 30, 20, 40, 50]);
    // The same readings in another order give the same list.
    eq(pids(rankProcesses([...list].reverse(), {sort: 'threads'})), [20, 30, 40, 50, 10]);
});

test('every process is listed: no limit, a thousand in, a thousand out', () => {
    const list = Array.from({length: 1000}, (_, i) =>
        ({pid: 100 + i, name: `p${i}`, command: `p${i}`, cpu: i % 7, memory: i, threads: i % 13}));
    for (const sort of SORTS) {
        const ranked = rankProcesses(list, {sort});
        eq(ranked.length, 1000, sort);
        eq(new Set(ranked.map(x => x.pid)).size, 1000, sort);
        ok(ranked.every((x, i) => i === 0 || ranked[i - 1][sort] >= x[sort]), `${sort} descending`);
    }
    eq(rankProcesses(list, {filter: 'p99'}).length, 11, 'p99 and p990-p999');
});

test('the count line: all processes, or how many match the filter', () => {
    const ngettext = (one, many, n) => n === 1 ? one : many;
    eq(countText(256, 256, false, ngettext), 'Your 256 processes');
    eq(countText(1, 1, false, ngettext), 'Your 1 process');
    eq(countText(256, 12, true, ngettext), '12 of your 256 processes match');
    eq(countText(256, 1, true, ngettext), '1 of your 256 processes matches');
    eq(countText(256, 0, true, ngettext), '0 of your 256 processes match');
    // The filter decides, not the count: everything may match it.
    eq(countText(5, 5, true, ngettext), '5 of your 5 processes match');
    // Counted as rankProcesses filters (the view counts today's processes
    // this way while its rows are held).
    const list = [{pid: 10, name: 'sleep', command: 'sleep 611.123'},
        {pid: 11, name: 'sleep', command: 'sleep 611.124'}, {pid: 611, name: 'x', command: 'x'}];
    eq(countMatching(list, ''), 3);
    eq(countMatching(list, ' 611.12 '), 2);
    eq(countMatching(list, '611'), rankProcesses(list, {filter: '611'}).length);
    eq(countMatching(list, 'nothing'), 0);
});

// ---------------------------------------------------------------- sampler

test('the sampler lists this user\'s live processes only, with names and protection', async () => {
    const spec = machine();
    const sampler = new ProcessSampler(fakeIo(spec).io, spec.self);
    const processes = await sampler.sample();
    const byPid = new Map(processes.map(p => [p.pid, p]));
    // Not root's (1, 4000), not the zombie (3400), not the kernel thread (3500).
    eq([...byPid.keys()].sort(), [1500, 2000, 3000, 3100, 3200, 3300]);
    eq(byPid.get(3300), {
        key: '3300:7777', pid: 3300, start: 7777, name: 'sleep', command: 'sleep 600',
        cpu: null, memory: 50 * 16384, threads: 1, protected: null,
    });
    eq(byPid.get(3000).threads, 87);
    eq(byPid.get(3200).name, 'gnome-session-binary');
    eq(byPid.get(3100).name, 'Isolated Web Co');
    eq(byPid.get(2000).protected, 'shell');
    eq(byPid.get(1500).protected, 'session');
    eq(byPid.get(3200).protected, 'session');
    eq(byPid.get(3000).protected, null);
});

test('a process whose main thread exited is listed, memory unknown, and may be killed', async () => {
    const spec = machine();
    spec.procs.push({pid: 3600, comm: 'python3', ppid: 3000, state: 'Z', threads: 2, rss: 0,
        start: 8888, args: []});
    const fake = fakeIo(spec);
    const sampler = new ProcessSampler(fake.io, spec.self);
    const leader = (await sampler.sample()).find(p => p.pid === 3600);
    eq(leader, {
        key: '3600:8888', pid: 3600, start: 8888, name: 'python3', command: '[python3]',
        cpu: null, memory: null, threads: 2, protected: null,
    });
    eq(await sampler.verify(leader), 'ok');
    // Its last other thread ended: now it has.
    spec.procs.find(p => p.pid === 3600).threads = 1;
    eq((await sampler.sample()).find(p => p.pid === 3600), undefined);
    eq(await sampler.verify(leader), 'gone');
    eq(fake.runs.length, 0);
});

test('reads come in batches with a pause between, each batch parsed as it comes', async () => {
    const spec = machine();
    for (let i = 0; i < 100; i++)
        spec.procs.push({pid: 10000 + i, comm: `w${i}`, ppid: 3000, args: [`/opt/w${i}`]});
    const fake = fakeIo(spec);
    const sampler = new ProcessSampler(fake.io, spec.self);
    const statReads = () => fake.reads.filter(path => /^\/proc\/\d+\/stat$/.test(path)).length;
    const listed = await sampler.sample();
    // The user's 108 stat files, then the command lines of the 106 live
    // ones (not the zombie's nor the kernel thread's): BATCH at a time,
    // with a pause between two batches.
    const statBatches = Math.ceil(108 / BATCH);
    const cmdlineBatches = Math.ceil(106 / BATCH);
    eq(listed.length, 106);
    eq(fake.pauses.length, statBatches - 1 + cmdlineBatches - 1, `pauses after ${fake.pauses}`);
    ok(fake.pauses.every((reads, i) => i === 0 || reads > fake.pauses[i - 1]), 'reads between');
    ok(BATCH > 1 && BATCH <= 64, `${BATCH} files at once`);
    // Then only the stat files.
    fake.pauses.length = 0;
    await sampler.sample();
    eq(fake.pauses.length, statBatches - 1);
    // Cancelled during a pause: no batch after it, and no list.
    const cancellable = new Gio.Cancellable();
    const before = statReads();
    spec.onPause = () => cancellable.cancel();
    eq(await sampler.sample(cancellable), null);
    eq(statReads() - before, BATCH, 'only the first batch was read');
});

test('a name, command and protection are worked out once, again only on a rename', async () => {
    const spec = machine();
    const sampler = new ProcessSampler(fakeIo(spec).io, spec.self);
    await sampler.sample();
    const again = (await sampler.sample()).find(p => p.pid === 3100);
    eq([again.name, again.command, again.protected],
        ['Isolated Web Co', '/usr/lib/firefox/firefox -contentproc 12', null]);
    // The process renamed itself (prctl PR_SET_NAME) to a protected name.
    spec.procs.find(p => p.pid === 3100).comm = 'Xwayland';
    const renamed = (await sampler.sample()).find(p => p.pid === 3100);
    eq([renamed.name, renamed.protected], ['Xwayland', 'session']);
});

test('CPU shares from the second sample; command lines are read once', async () => {
    const spec = machine();
    const fake = fakeIo(spec);
    const sampler = new ProcessSampler(fake.io, spec.self);
    await sampler.sample();
    spec.machineTicks += 1000;
    spec.procs.find(p => p.pid === 3000).utime += 250;
    const processes = await sampler.sample();
    const byPid = new Map(processes.map(p => [p.pid, p]));
    eq(byPid.get(3000).cpu, 25);
    eq(byPid.get(3300).cpu, 0);
    eq(fake.reads.filter(path => path === '/proc/3000/cmdline').length, 1);
    eq(fake.reads.filter(path => path === '/proc/4000/stat').length, 0, 'root\'s are not read');
    // A new visit starts over.
    sampler.reset();
    eq((await sampler.sample()).find(p => p.pid === 3000).cpu, null);
});

test('verify: same process, this user\'s, not protected; a reused id is "gone"', async () => {
    const spec = machine();
    const fake = fakeIo(spec);
    const sampler = new ProcessSampler(fake.io, spec.self);
    const listed = await sampler.sample();
    const sleep = listed.find(p => p.pid === 3300);
    eq(await sampler.verify(sleep), 'ok');
    // The kernel gave 3300 to a new process: another start time.
    eq(await sampler.verify({...sleep, start: sleep.start + 1}), 'gone');
    spec.procs.find(p => p.pid === 3300).uid = 0;
    eq(await sampler.verify(sleep), 'not-yours');
    spec.procs.find(p => p.pid === 3300).state = 'Z';
    eq(await sampler.verify(sleep), 'gone');
    spec.procs = spec.procs.filter(p => p.pid !== 3300);
    eq(await sampler.verify(sleep), 'gone');
    for (const pid of [2000, 1500, 3200]) {
        // eslint-disable-next-line no-await-in-loop
        eq(await sampler.verify(listed.find(p => p.pid === pid)), 'protected', `${pid}`);
    }
    for (const pid of [-1, 0, 1, '3300', 2.5])
        // eslint-disable-next-line no-await-in-loop
        eq(await sampler.verify({pid, start: 7777}), 'invalid', `${pid}`);
    eq(fake.runs.length, 0, 'verify never signals');
});

test('an ancestor started after the last sample is still protected', async () => {
    const spec = machine();
    const sampler = new ProcessSampler(fakeIo(spec).io, spec.self);
    // GNOME Shell was reparented to a new process, never sampled.
    spec.procs.push({pid: 6000, comm: 'shell-wrapper', ppid: 1500, args: ['/opt/wrapper']});
    spec.procs.find(p => p.pid === 2000).ppid = 6000;
    eq(await sampler.verify({pid: 6000, start: 100}), 'protected');
});

// ---------------------------------------------------------------- service

// Just what KillProcessService uses of Gio.Settings.
function fakeSettings(values = {}) {
    const handlers = new Map();
    let nextId = 1;
    return {
        get_int: key => values[key] ?? 3,
        get_string: key => values[key] ?? 'cpu',
        set_string: (key, value) => {
            values[key] = value;
            for (const [, {signal, fn}] of handlers) {
                if (signal === `changed::${key}`)
                    fn();
            }
        },
        connect: (signal, fn) => {
            handlers.set(nextId, {signal, fn});
            return nextId++;
        },
        disconnect: id => handlers.delete(id),
        handlers,
    };
}

async function shownService(spec, options = {}) {
    const fake = fakeIo(spec);
    const clock = {now: 100};
    const settings = fakeSettings();
    const service = new KillProcessService(settings, {
        io: fake.io, self: spec.self, now: () => clock.now, ...options,
    });
    service.start();
    service.setActive(true);
    await settle();
    return {service, fake, clock, settings};
}

async function resample(service) {
    service._tick();
    await settle();
}

test('the service reads processes only while its tab is on screen', async () => {
    const spec = machine();
    const {service, settings} = await shownService(spec);
    eq(service.polling, true);
    ok(service._followUpId !== 0, 'a quick second sample is due');
    ok(service.processes.length === 6);
    service.setActive(false);
    eq(service.polling, false);
    eq(service._followUpId, 0);
    service.stop();
    eq(settings.handlers.size, 0);
});

test('a sample taken for a visit that ended is dropped', async () => {
    const spec = machine();
    const service = new KillProcessService(fakeSettings(), {io: fakeIo(spec).io, self: spec.self});
    let changes = 0;
    service.connect('changed', () => changes++);
    service.start();
    service.setActive(true);
    service.setActive(false);
    await settle();
    eq(changes, 0);
    eq(service.processes, null);
    service.stop();
});

test('kill: SIGTERM through the fixed kill command, then "ended"', async () => {
    const spec = machine();
    const {service, fake} = await shownService(spec);
    const sleep = service.processes.find(p => p.pid === 3300);
    const done = service.kill(sleep);
    eq(service.killState(sleep.key).phase, 'sending');
    await done;
    eq(fake.runs, [['/usr/bin/kill', '-s', 'TERM', '3300']]);
    eq(service.killState(sleep.key).phase, 'ending');
    await resample(service);
    eq(service.killState(sleep.key), null);
    eq(service.lastResult, {outcome: 'ended', name: 'sleep', pid: 3300});
    // An ended process is never signalled again.
    await service.kill(sleep);
    eq(fake.runs.length, 1);
    eq(service.lastResult.outcome, 'gone');
    service.stop();
});

test('force quit: offered only when SIGTERM did not end it in time', async () => {
    const spec = machine();
    spec.procs.find(p => p.pid === 3300).ignoresTerm = true;
    const {service, fake, clock} = await shownService(spec);
    const sleep = service.processes.find(p => p.pid === 3300);
    // Not before it was asked to quit.
    await service.forceQuit(sleep);
    eq(fake.runs.length, 0);
    await service.kill(sleep);
    await resample(service);
    eq(service.killState(sleep.key).phase, 'ending');
    await service.forceQuit(sleep);
    eq(fake.runs.length, 1, 'not while it may still be quitting');
    clock.now += FORCE_AFTER_S;
    await resample(service);
    eq(service.killState(sleep.key).phase, 'stuck');
    await service.forceQuit(sleep);
    eq(fake.runs.at(-1), ['/usr/bin/kill', '-s', 'KILL', '3300']);
    eq(service.killState(sleep.key).phase, 'forcing');
    await resample(service);
    eq(service.lastResult, {outcome: 'ended', name: 'sleep', pid: 3300});
    service.stop();
});

test('a process that will not end is followed closely for 10 s only', async () => {
    const spec = machine();
    // Stuck in the kernel (state D): even SIGKILL leaves it listed.
    Object.assign(spec.procs.find(p => p.pid === 3300), {ignoresTerm: true, ignoresKill: true});
    const {service, fake, clock} = await shownService(spec);
    fake.io.run = async argv => {
        fake.runs.push(argv);
        return '';
    };
    const sleep = service.processes.find(p => p.pid === 3300);
    const dropFollowUp = () => {
        if (service._followUpId)
            GLib.source_remove(service._followUpId);
        service._followUpId = 0;
    };
    await service.kill(sleep);
    clock.now += FORCE_AFTER_S;
    await resample(service);
    await service.forceQuit(sleep);
    dropFollowUp();
    await resample(service);
    eq(service.killState(sleep.key).phase, 'forcing');
    ok(service._followUpId !== 0, 'read again soon while it may still end');
    dropFollowUp();
    clock.now += 10;
    await resample(service);
    eq(service._followUpId, 0, 'then only every interval');
    eq(service.polling, true);
    service.stop();
});

test('nothing is signalled for a reused id, a protected process, or off screen', async () => {
    const spec = machine();
    const {service, fake} = await shownService(spec);
    const sleep = service.processes.find(p => p.pid === 3300);
    await service.kill({...sleep, key: '3300:1', start: 1});
    eq(service.lastResult.outcome, 'gone');
    for (const pid of [2000, 1500, 3200]) {
        // eslint-disable-next-line no-await-in-loop
        await service.kill(service.processes.find(p => p.pid === pid));
        eq(service.lastResult.outcome, 'protected', `${pid}`);
    }
    // A forged entry: -1 would be every process of the user.
    await service.kill({key: '-1:0', pid: -1, start: 0, name: 'all'});
    eq(service.lastResult.outcome, 'invalid');
    service.setActive(false);
    await service.kill(sleep);
    eq(fake.runs.length, 0);
    service.stop();
});

test('without the kill command, it says so', async () => {
    const spec = {...machine(), executables: []};
    const {service, fake} = await shownService(spec);
    await service.kill(service.processes.find(p => p.pid === 3300));
    eq(service.lastResult.outcome, 'no-tool');
    eq(fake.runs.length, 0);
    service.stop();
});

test('a slow reading spaces the timer\'s next ones; early readings are not held back', async () => {
    const spec = machine();
    const {service, fake, clock} = await shownService(spec);
    // The reading takes 0.5 s (the fake clock moves while it reads).
    spec.onPause = () => {
        clock.now += 0.5;
    };
    for (let i = 0; i < 40; i++)
        spec.procs.push({pid: 20000 + i, comm: 'w', ppid: 3000, args: ['w']});
    await resample(service);
    spec.onPause = null;
    // Two batches of stat files and two of command lines: two pauses.
    const took = service._sampled.took;
    eq(took, 1);
    const reads = () => fake.reads.filter(path => path === '/proc/stat').length;
    let before = reads();
    // The interval's tick, 3 s later: too soon after a reading of 1 s.
    clock.now = service._sampled.end + 3;
    service._tick(true);
    await settle();
    eq(reads(), before, 'skipped');
    // An early reading (after a kill, or the visit's second) still runs.
    service._tick();
    await settle();
    eq(reads(), before + 1);
    // A fast reading: the interval's next tick runs.
    before = reads();
    clock.now = service._sampled.end + 3;
    service._tick(true);
    await settle();
    eq(reads(), before + 1);
    service.stop();
});

test('the list is passed on after a pause of its own (the view refreshes apart)', async () => {
    const spec = machine();
    const {service, fake} = await shownService(spec);
    let pausesAtChange = -1;
    service.connect('changed', () => {
        pausesAtChange = fake.pauses.length;
    });
    fake.pauses.length = 0;
    await resample(service);
    // Six processes: one batch, no pause between batches; one before 'changed'.
    eq(pausesAtChange, 1);
    service.stop();
});

test('the pause comes after due frames and IO completions, and ends when cancelled', async () => {
    // Clutter's redraws come at 50 (Clutter.PRIORITY_REDRAW), IO
    // completions at GLib.PRIORITY_DEFAULT: both before the pause.
    const order = [];
    const paused = PROCESS_IO.pause().then(() => order.push('pause'));
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        order.push('io');
        return GLib.SOURCE_REMOVE;
    });
    GLib.idle_add(50, () => {
        order.push('redraw');
        return GLib.SOURCE_REMOVE;
    });
    await paused;
    eq(order, ['io', 'redraw', 'pause']);
    // Cancelled: resolves at once, and its idle source is removed.
    const idleAdd = GLib.idle_add;
    let ran = false;
    GLib.idle_add = (priority, fn) => idleAdd(priority, () => {
        ran = true;
        return fn();
    });
    const cancellable = new Gio.Cancellable();
    let pending;
    try {
        pending = PROCESS_IO.pause(cancellable);
    } finally {
        GLib.idle_add = idleAdd;
    }
    cancellable.cancel();
    await pending;
    await new Promise(resolve => setTimeout(resolve, 20));
    ok(!ran, 'the idle never ran');
    // Already cancelled: at once.
    await PROCESS_IO.pause(cancellable);
});

test('the sort setting is kept, and only to known values', async () => {
    const spec = machine();
    const {service, settings} = await shownService(spec);
    service.setSort('memory');
    eq(service.sort, 'memory');
    service.setSort('threads');
    eq(service.sort, 'threads');
    service.setSort('pid; rm');
    eq(service.sort, 'threads');
    eq(settings.get_string('killprocess-sort'), 'threads');
    service.stop();
});

await done();
