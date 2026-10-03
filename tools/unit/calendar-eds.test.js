// SPDX-License-Identifier: GPL-3.0-or-later
// Calendar tab: the expansion scheduler, and EdsView over the real
// libecal and libical (gir1.2-ecal-2.0) with a fake calendar: no D-Bus,
// no Evolution Data Server. Without the bindings only the scheduler is
// tested.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Emitter} from '../../froonty@catalin/core/emitter.js';
import {Scheduler, TURN_BUDGET_US} from '../../froonty@catalin/features/calendar/scheduler.js';
import {done, eq, ok, test} from './test.js';

// ---------------------------------------------------------------- scheduler.js

function fakeIdle() {
    const queue = new Map();
    let next = 1;
    return {
        add: fn => {
            queue.set(next, fn);
            return next++;
        },
        cancel: id => queue.delete(id),
        // One main-loop iteration: every idle once.
        run() {
            for (const [id, fn] of [...queue]) {
                if (queue.has(id) && !fn())
                    queue.delete(id);
            }
        },
        get pending() {
            return queue.size;
        },
    };
}

// A worker whose steps take `cost` fake microseconds; `long` marks them.
function worker(clock, name, steps, {cost = 1000, long = false, log}) {
    return {
        left: steps,
        work(turn) {
            while (this.left > 0 && turn.step(long)) {
                clock.now += cost;
                this.left--;
                log.push(name);
                turn.done(long);
            }
            return this.left > 0;
        },
    };
}

test('scheduler: each turn stops once its budget is spent', () => {
    const clock = {now: 0};
    const idle = fakeIdle();
    const scheduler = new Scheduler({now: () => clock.now, idle});
    const log = [];
    scheduler.want(worker(clock, 'a', 20, {cost: 1000, log}));
    let turns = 0;
    while (idle.pending) {
        const before = clock.now;
        idle.run();
        turns++;
        ok(clock.now - before <= TURN_BUDGET_US, `turn ${turns}: ${clock.now - before} µs`);
    }
    eq([log.length, turns], [20, 7]);
});

test('scheduler: a long step runs alone in its turn; views take turns', () => {
    const clock = {now: 0};
    const idle = fakeIdle();
    const scheduler = new Scheduler({now: () => clock.now, idle});
    const log = [];
    scheduler.want(worker(clock, 'a', 2, {cost: 100, log}));
    scheduler.want(worker(clock, 'L', 2, {cost: 50000, long: true, log}));
    scheduler.want(worker(clock, 'b', 2, {cost: 100, log}));
    const turns = [];
    while (idle.pending) {
        const start = log.length;
        idle.run();
        turns.push(log.slice(start).join(''));
    }
    eq(turns, ['aa', 'bb', 'L', 'L']);
});

test('scheduler: paused, no turn runs; resumed, work goes on', () => {
    const clock = {now: 0};
    const idle = fakeIdle();
    const scheduler = new Scheduler({now: () => clock.now, idle});
    const log = [];
    scheduler.setPaused(true);
    scheduler.want(worker(clock, 'a', 3, {cost: 100, log}));
    eq(idle.pending, 0);
    scheduler.setPaused(false);
    eq(idle.pending, 1);
    idle.run();
    eq([log.length, idle.pending, scheduler.pending], [3, 0, false]);
});

test('scheduler: changes during a turn keep exactly the idle in use; stop() removes it', () => {
    const clock = {now: 0};
    const idle = fakeIdle();
    const scheduler = new Scheduler({now: () => clock.now, idle});
    const log = [];
    const b = worker(clock, 'b', 1, {cost: 10, log});
    const a = {
        work(turn) {
            // A view let go and another one wanting turns, mid-turn.
            scheduler.forget(a);
            scheduler.want(b);
            turn.done();
            return false;
        },
    };
    scheduler.want(a);
    idle.run();
    eq([log.join(''), idle.pending, scheduler.pending], ['b', 0, false]);
    scheduler.want(worker(clock, 'c', 50, {cost: 1000, log}));
    idle.run();
    eq(idle.pending, 1);
    scheduler.stop();
    eq([idle.pending, scheduler.pending], [0, false]);
    scheduler.want(worker(clock, 'd', 1, {log}));
    eq(idle.pending, 0, 'nothing after stop()');
});

// ---------------------------------------------------------------- eds.js

const eds = await import('../../froonty@catalin/features/calendar/eds.js');
let libs = null;
try {
    if (await eds.edsInstalled()) {
        libs = {
            ECal: (await import('gi://ECal?version=2.0')).default,
            EDataServer: (await import('gi://EDataServer?version=1.2')).default,
            ICalGLib: (await import('gi://ICalGLib?version=3.0')).default,
        };
    }
} catch (e) {
    print(`(EDS bindings not usable: ${e.message})`);
}

const TZ = 'Europe/Bucharest';
const BUCHAREST = GLib.TimeZone.new(TZ);
const at = (y, m, d, h = 0, min = 0, zone = BUCHAREST) => GLib.DateTime.new(zone, y, m, d, h, min, 0).to_unix();
// The October 2026 grid (Monday first), as the service asks for it.
const RANGE = {start: at(2026, 9, 28), end: at(2026, 11, 9)};

const PACIFIC_VTIMEZONE = 'BEGIN:VTIMEZONE\r\nTZID:Pacific Standard Time\r\nBEGIN:STANDARD\r\n' +
    'DTSTART:16010101T020000\r\nTZOFFSETFROM:-0700\r\nTZOFFSETTO:-0800\r\n' +
    'RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11\r\nEND:STANDARD\r\nBEGIN:DAYLIGHT\r\n' +
    'DTSTART:16010101T020000\r\nTZOFFSETFROM:-0800\r\nTZOFFSETTO:-0700\r\n' +
    'RRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\n';

// An ECal.ClientView: its signals, and its synchronous D-Bus calls counted.
class FakeClientView extends Emitter {
    constructor() {
        super();
        this.calls = [];
        this.handlers = 0;
    }

    connect(name, fn) {
        this.handlers++;
        return super.connect(name, fn);
    }

    disconnect(id) {
        this.handlers--;
        return super.disconnect(id);
    }

    start() {
        this.calls.push('start');
    }

    stop() {
        this.calls.push('stop');
    }

    set_flags() {
        this.calls.push('set_flags');
    }
}

// An ECal.Client: get_timezone answers after `delay` ms with `zone`, or
// fails with `error`; a series has no moved occurrences.
class FakeClient {
    constructor({zone = null, error = null, delay = 20} = {}) {
        this.zone = zone;
        this.error = error;
        this.delay = delay;
        this.requests = [];
    }

    get_timezone(tzid, cancellable, callback) {
        this.requests.push(tzid);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.delay, () => {
            callback(this, {cancellable});
            return GLib.SOURCE_REMOVE;
        });
    }

    get_timezone_finish({cancellable}) {
        if (cancellable?.is_cancelled())
            throw new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, 'Operation was cancelled');
        if (this.error)
            throw this.error;
        return [true, this.zone];
    }

    get_objects_for_uid(_uid, _cancellable, callback) {
        callback(this, null);
    }

    get_objects_for_uid_finish() {
        return [true, []];
    }
}

const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

async function waitUntil(predicate, timeoutMs = 20000) {
    for (let waited = 0; waited < timeoutMs; waited += 5) {
        if (predicate())
            return true;
        await sleep(5);
    }
    return predicate();
}

function component(lines, uid) {
    return libs.ICalGLib.Component.new_from_string(
        `BEGIN:VEVENT\r\nUID:${uid}\r\n${lines.join('\r\n')}\r\nEND:VEVENT\r\n`);
}

// A started EdsView over a fake calendar, collecting what it emits.
function openView({client = new FakeClient(), entry = null, scheduler = new Scheduler()} = {}) {
    const {ICalGLib} = libs;
    const clientEntry = entry ?? new eds.ClientEntry(libs, client);
    const clientView = new FakeClientView();
    const view = new eds.EdsView(libs, clientEntry, clientView,
        {...RANGE, zone: ICalGLib.Timezone.get_builtin_timezone(TZ)}, scheduler);
    const items = new Map();
    const state = {complete: false};
    view.connect('items', (_v, list) => list.forEach(item => items.set(item.key, item)));
    view.connect('removed', (_v, keys) => keys.forEach(key => items.delete(key)));
    view.connect('complete', () => (state.complete = true));
    view.start();
    return {view, clientView, client, entry: clientEntry, scheduler, items, state};
}

// libecal's own expansion of the whole range in one call: what Froonty
// did before, and what GNOME's calendar shows.
function reference(c) {
    const {ECal, ICalGLib} = libs;
    const zone = ICalGLib.Timezone.get_builtin_timezone(TZ);
    const utc = ICalGLib.Timezone.get_utc_timezone();
    const out = [];
    ECal.recur_generate_instances_sync(c,
        ICalGLib.Time.new_from_timet_with_zone(RANGE.start, false, utc),
        ICalGLib.Time.new_from_timet_with_zone(RANGE.end, false, utc),
        (_i, s, e) => {
            out.push(s.is_date() ? `D${s.as_ical_string()}-${e.as_ical_string()}`
                : `${s.as_timet_with_zone(s.get_timezone() ?? zone)}-${e.as_timet_with_zone(e.get_timezone() ?? zone)}`);
            return out.length < eds.MAX_OCCURRENCES;
        }, tzid => ICalGLib.Timezone.get_builtin_timezone(tzid), zone, null);
    return out;
}

const shown = occurrence => occurrence.allDay
    ? `D${occurrence.startDate.replaceAll('-', '')}-${occurrence.endDate.replaceAll('-', '')}`
    : `${occurrence.start}-${occurrence.end}`;

function libsTest(name, fn) {
    test(name, async () => {
        if (!libs) {
            print(`  (skipped: gir1.2-ecal-2.0 is not installed) ${name}`);
            return;
        }
        await fn();
    });
}

// Series whose start is moved (and walked) before each slice, and series
// expanded in one call: the occurrences must be libecal's own.
const SERIES = {
    'daily since 2016': ['DTSTART;TZID=Europe/Bucharest:20160104T090000',
        'DTEND;TZID=Europe/Bucharest:20160104T091500', 'RRULE:FREQ=DAILY'],
    'every 3 days across midnight': ['DTSTART;TZID=Europe/Bucharest:20160105T233000',
        'DTEND;TZID=Europe/Bucharest:20160106T003000', 'RRULE:FREQ=DAILY;INTERVAL=3'],
    'weekly MO,WE,FR in New York, a day excluded': ['DTSTART;TZID=America/New_York:20180103T080000',
        'DTEND;TZID=America/New_York:20180103T090000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR',
        'EXDATE;TZID=America/New_York:20261005T080000'],
    'every other week, WKST=SU': ['DTSTART:20170103T140000Z', 'DTEND:20170103T150000Z',
        'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;WKST=SU'],
    'a start that is not an occurrence': ['DTSTART;TZID=Europe/Bucharest:20200107T100000',
        'DTEND;TZID=Europe/Bucharest:20200107T110000', 'RRULE:FREQ=WEEKLY;BYDAY=MO'],
    'twice a day': ['DTSTART;TZID=Europe/Bucharest:20190101T090000',
        'DTEND;TZID=Europe/Bucharest:20190101T093000', 'RRULE:FREQ=DAILY;BYHOUR=9,17'],
    'all day, every other day': ['DTSTART;VALUE=DATE:20150101', 'DTEND;VALUE=DATE:20150102',
        'RRULE:FREQ=DAILY;INTERVAL=2'],
    'three days long, weekly, all day': ['DTSTART;VALUE=DATE:20150105', 'DTEND;VALUE=DATE:20150108',
        'RRULE:FREQ=WEEKLY'],
    'three days long, from before the range': ['DTSTART;TZID=Europe/Bucharest:20160101T120000',
        'DTEND;TZID=Europe/Bucharest:20160104T120000', 'RRULE:FREQ=DAILY;INTERVAL=5'],
    'counted, still going': ['DTSTART:20250101T090000Z', 'DTEND:20250101T100000Z', 'RRULE:FREQ=DAILY;COUNT=650'],
    'counted, over': ['DTSTART:20250101T090000Z', 'DTEND:20250101T100000Z', 'RRULE:FREQ=DAILY;COUNT=200'],
    'counted with BY parts (one call)': ['DTSTART:20250101T090000Z', 'DTEND:20250101T100000Z',
        'RRULE:FREQ=WEEKLY;COUNT=200;BYDAY=MO,TH'],
    'until mid-range': ['DTSTART:20200101T090000Z', 'DTEND:20200101T100000Z',
        'RRULE:FREQ=DAILY;UNTIL=20261015T090000Z'],
    'with RDATEs': ['DTSTART:20200101T090000Z', 'DTEND:20200101T100000Z', 'RRULE:FREQ=WEEKLY',
        'RDATE:20261007T120000Z,20260927T230000Z'],
    'floating time': ['DTSTART:20190601T073000', 'DTEND:20190601T080000', 'RRULE:FREQ=DAILY'],
    'monthly on the 31st (one call)': ['DTSTART:20100131T090000Z', 'DTEND:20100131T100000Z', 'RRULE:FREQ=MONTHLY'],
    'a birthday (one call)': ['DTSTART;VALUE=DATE:19800930', 'DTEND;VALUE=DATE:19801001', 'RRULE:FREQ=YEARLY'],
    'every 30 minutes since January (capped)': ['DTSTART:20260101T090000Z', 'DTEND:20260101T091500Z',
        'RRULE:FREQ=MINUTELY;INTERVAL=30'],
    'hourly since 2024 (capped)': ['DTSTART:20240101T090000Z', 'DTEND:20240101T091500Z', 'RRULE:FREQ=HOURLY'],
    'every 7 minutes, no length (capped)': ['DTSTART:20260927T000000Z', 'RRULE:FREQ=MINUTELY;INTERVAL=7'],
    'every 5 hours in Bucharest, across DST changes (walked)': ['DTSTART;TZID=Europe/Bucharest:20240101T000000',
        'DTEND;TZID=Europe/Bucharest:20240101T001000', 'RRULE:FREQ=HOURLY;INTERVAL=5'],
    'every 6 hours from a DST day (walked)': ['DTSTART;TZID=Europe/Bucharest:20160327T023000',
        'DTEND;TZID=Europe/Bucharest:20160327T043000', 'RRULE:FREQ=HOURLY;INTERVAL=6'],
    'every 2 hours, floating (walked)': ['DTSTART:20250101T003000', 'DTEND:20250101T004500',
        'RRULE:FREQ=HOURLY;INTERVAL=2'],
    'every 5 hours in UTC': ['DTSTART:20200101T000000Z', 'DTEND:20200101T001000Z', 'RRULE:FREQ=HOURLY;INTERVAL=5'],
};

libsTest('eds: sliced and moved series give libecal\'s own occurrences (calendar-1)', async () => {
    const differences = [];
    for (const [name, lines] of Object.entries(SERIES)) {
        const uid = `s${Object.keys(SERIES).indexOf(name)}`;
        const expected = reference(component(lines, uid));
        const h = openView();
        h.clientView.emit('objects-added', [component(lines, uid)]);
        h.clientView.emit('complete', null);
        ok(await waitUntil(() => h.state.complete), `${name}: complete`);
        const got = (h.items.get(`${uid}\n`)?.occurrences ?? []).map(shown);
        if (JSON.stringify(got) !== JSON.stringify(expected))
            differences.push(`${name}: ${got.length} vs ${expected.length}, first ${got[0]} vs ${expected[0]}`);
        h.view.release();
    }
    eq(differences, []);
});

libsTest('eds: 50 daily series since 2016 and minutely ones keep every turn under a frame (calendar-1)', async () => {
    const lines = [];
    for (let i = 0; i < 50; i++) {
        const year = 2016 + (i % 8);
        const hour = String(8 + (i % 10)).padStart(2, '0');
        lines.push([`DTSTART;TZID=Europe/Bucharest:${year}0104T${hour}0000`,
            `DTEND;TZID=Europe/Bucharest:${year}0104T${hour}1500`,
            i % 2 ? 'RRULE:FREQ=DAILY' : 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR']);
    }
    lines.push(['DTSTART:20261001T090000Z', 'DTEND:20261001T090100Z', 'RRULE:FREQ=MINUTELY']);
    lines.push(['DTSTART:20240101T090000Z', 'DTEND:20240101T091500Z', 'RRULE:FREQ=HOURLY']);
    lines.push(['DTSTART:20260101T090000Z', 'DTEND:20260101T091500Z', 'RRULE:FREQ=MINUTELY;INTERVAL=30']);
    const h = openView();
    h.clientView.emit('objects-added', lines.map((l, i) => component(l, `big${i}`)));
    h.clientView.emit('complete', null);
    ok(await waitUntil(() => h.state.complete));
    const longest = h.scheduler.longestTurn / 1000;
    print(`  ${h.scheduler.turns} turns, longest ${longest.toFixed(1)} ms; ${h.view.calls} libecal calls, ` +
        `longest ${(h.view.longestCall / 1000).toFixed(1)} ms`);
    ok(longest < 16, `longest turn ${longest} ms`);
    const counts = lines.map((_l, i) => h.items.get(`big${i}\n`)?.occurrences.length);
    eq(counts.slice(0, 50).every((n, i) => n === (i % 2 ? 42 : 30)), true, `${counts.slice(0, 50)}`);
    eq(counts.slice(50), [eds.MAX_OCCURRENCES, eds.MAX_OCCURRENCES, eds.MAX_OCCURRENCES]);
    eq(h.items.get('big50\n').occurrences[0].start, at(2026, 10, 1, 9, 0, GLib.TimeZone.new_utc()),
        'the minutely one from its first minute');
    h.view.release();
});

function pacific() {
    const {ICalGLib} = libs;
    const zone = ICalGLib.Timezone.new();
    zone.set_component(ICalGLib.Component.new_from_string(PACIFIC_VTIMEZONE));
    return zone;
}

const LOS_ANGELES = GLib.TimeZone.new('America/Los_Angeles');
const pacificEvents = (n, prefix = 'pst') => Array.from({length: n}, (_, i) => component([
    `DTSTART;TZID=Pacific Standard Time:202610${String(1 + (i % 28)).padStart(2, '0')}T140000`,
    `DTEND;TZID=Pacific Standard Time:202610${String(1 + (i % 28)).padStart(2, '0')}T150000`], `${prefix}${i}`));
const atTwoPm = i => at(2026, 10, 1 + (i % 28), 14, 0, LOS_ANGELES);

libsTest('eds: a zone libical does not know, fetched once, fixes every event that waited for it (calendar-2)', async () => {
    const client = new FakeClient({zone: pacific(), delay: 20});
    const h = openView({client});
    h.clientView.emit('objects-added', pacificEvents(160));
    h.clientView.emit('complete', null);
    const right = () => [...Array(160).keys()].filter(i =>
        h.items.get(`pst${i}\n`)?.occurrences[0]?.start === atTwoPm(i)).length;
    ok(await waitUntil(() => right() === 160, 5000), `${right()} of 160 at 14:00 Pacific`);
    eq(client.requests, ['Pacific Standard Time'], 'one request');
    // An event delivered later, by this view or another, needs none.
    h.clientView.emit('objects-added', pacificEvents(1, 'late'));
    const other = openView({entry: h.entry});
    other.clientView.emit('objects-added', pacificEvents(3, 'other'));
    ok(await waitUntil(() => h.items.get('late0\n')?.occurrences[0]?.start === atTwoPm(0) &&
        [0, 1, 2].every(i => other.items.get(`other${i}\n`)?.occurrences[0]?.start === atTwoPm(i))));
    eq(client.requests.length, 1);
    h.view.release();
    other.view.release();
});

libsTest('eds: a view let go before the answer: the next view of the calendar still gets the zone (calendar-2)', async () => {
    const client = new FakeClient({zone: pacific(), delay: 30});
    const h = openView({client});
    h.clientView.emit('objects-added', pacificEvents(3));
    ok(await waitUntil(() => client.requests.length === 1));
    h.view.release();
    await sleep(60);
    ok(h.entry.zones.get('Pacific Standard Time'), 'the answer kept for the calendar');
    const next = openView({entry: h.entry});
    next.clientView.emit('objects-added', pacificEvents(3));
    ok(await waitUntil(() => [0, 1, 2].every(i => next.items.get(`pst${i}\n`)?.occurrences[0]?.start === atTwoPm(i))));
    eq(client.requests.length, 1);
    next.view.release();
});

libsTest('eds: a failed request is asked again; only "not found" is remembered (calendar-2)', async () => {
    const client = new FakeClient({error: new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.FAILED, 'Timeout'), delay: 5});
    const h = openView({client});
    h.clientView.emit('objects-added', pacificEvents(1));
    ok(await waitUntil(() => client.requests.length === 1 && h.view._asked.size === 0));
    eq(h.entry.zones.has('Pacific Standard Time'), false, 'nothing cached');
    client.error = null;
    client.zone = pacific();
    h.clientView.emit('objects-modified', pacificEvents(1));
    ok(await waitUntil(() => h.items.get('pst0\n')?.occurrences[0]?.start === atTwoPm(0)), 'asked again, fixed');
    eq(client.requests.length, 2);
    h.view.release();

    const unknown = new FakeClient({delay: 5,
        error: new GLib.Error(GLib.quark_from_string('e-cal-client-error-quark'), libs.ECal.ClientError.OBJECT_NOT_FOUND,
            'Object not found')});
    const u = openView({client: unknown});
    u.clientView.emit('objects-added', pacificEvents(2));
    ok(await waitUntil(() => u.entry.zones.has('Pacific Standard Time')));
    eq(u.entry.zones.get('Pacific Standard Time'), null, 'unknown to the calendar: floating times');
    u.clientView.emit('objects-modified', pacificEvents(2));
    await sleep(30);
    eq(unknown.requests.length, 1, 'not asked again');
    u.view.release();
});

libsTest('eds: release() makes no D-Bus call; start() makes one (calendar-3)', () => {
    const h = openView();
    h.view.start();
    eq(h.clientView.calls, ['start']);
    h.clientView.emit('objects-added', pacificEvents(1));
    h.view.release();
    eq([h.clientView.calls, h.clientView.handlers, h.scheduler.pending], [['start'], 0, false]);
    h.clientView.emit('objects-added', pacificEvents(1));
    eq(h.view._queue.length, 0, 'nothing taken after release');
});

libsTest('eds: while paused, an event changed many times waits once; a removal drops it', async () => {
    const scheduler = new Scheduler();
    scheduler.setPaused(true);
    const h = openView({scheduler});
    for (let i = 0; i < 100; i++)
        h.clientView.emit('objects-modified', pacificEvents(5));
    eq(h.view._pendingAdds.size, 5);
    h.clientView.emit('objects-removed', [{get_uid: () => 'pst0', get_rid: () => null}]);
    eq(h.view._pendingAdds.size, 4);
    await sleep(20);
    eq(h.items.size, 0, 'nothing expanded while paused');
    scheduler.setPaused(false);
    ok(await waitUntil(() => h.items.size === 4));
    ok(!h.items.has('pst0\n'));
    h.view.release();
});

await done();
