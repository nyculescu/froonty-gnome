// SPDX-License-Identifier: GPL-3.0-or-later
// The Break tab against GNOME's real break engine (misc/breakManager.js,
// loaded from the installed GNOME Shell) on a fake timeline: the
// scenarios the prototype recorded in a real GNOME Shell 50.1 (S1-S12).
// GNOME's settings and Froonty's are in memory (asserted in breakWorld.js).

import {done, eq, ok, test} from './test.js';
import {gnome, select, configure, setup} from './breakWorld.js';
import {makeWorld} from './gnomeBreakManager.js';
import {
    IDLE_WATCH_SECONDS, OVERDUE_SECONDS, STATE, UPCOMING_SECONDS,
} from '../../froonty@catalin/shell/breakEngine.js';
import {LEVEL} from '../../froonty@catalin/features/break/engine.js';

const eyes = service => service.state.today.eyesight;
const count = (manager, signal) => {
    const fired = [];
    manager.connect(signal, () => fired.push(signal));
    return fired;
};

test('GNOME contract: state numbers and the 10 s idle watch match the installed Shell', async () => {
    const {module, source} = await gnome();
    eq(module.BreakState, STATE);
    eq(module.MIN_BREAK_LENGTH_SECONDS, IDLE_WATCH_SECONDS);
    ok(source.includes(`BREAK_OVERDUE_TIME_SECONDS = ${OVERDUE_SECONDS};`), 'overdue constant');
    ok(source.includes(`BREAK_UPCOMING_NOTIFICATION_TIME_SECONDS = [${UPCOMING_SECONDS / 60} * 60]`),
        'upcoming constant');
    ok(source.includes('this._breakLastEnd = new Map()'), 'the private per-type map');
});

test('S1: Take with nothing due only emits take-break; the tab offers no Take', async () => {
    const {world, manager, service} = await setup();
    world.work(5);
    const ends = count(manager, 'notify::last-break-end-time');
    const takes = count(manager, 'take-break');
    const before = [...manager._breakLastEnd];
    service._engine.take();
    eq(takes.length, 1);
    eq(ends.length, 0);
    eq([...manager._breakLastEnd], before);
    eq(service.model().actions.take, false);
    service.stop();
});

test('S1: Delay and Skip with nothing due change nothing and are not counted', async () => {
    const {world, manager, service} = await setup();
    world.work(5);
    const before = [...manager._breakLastEnd];
    service._engine.delay();
    service._engine.skip();
    eq([...manager._breakLastEnd], before);
    eq(eyes(service), {taken: 0, delayed: 0, skipped: 0});
    eq(service.model().actions.skip, false);
    service.stop();
});

test('S1: Delay when due moves it by delay-seconds, an own delay, consecutive 1', async () => {
    const {world, manager, service} = await setup();
    world.work(61);
    eq(manager.state, STATE.BREAK_DUE);
    const m = service.model();
    eq(m.level.level, LEVEL.DUE);
    eq([m.actions.take, m.actions.delay, m.actions.skip], [true, true, true]);
    const dueBefore = m.lastEnd.eyesight + 60;
    service.delay();
    const after = service.model();
    eq(after.lastEnd.eyesight + 60 - dueBefore, 30);
    eq(eyes(service).delayed, 1);
    eq(service.state.breaks.eyesight.consecutive, 1);
    eq(service.lastEvent, {type: 'eyesight', kind: 'delay', source: 'froonty'});
    ok(after.level.level < LEVEL.DUE, `level ${after.level.level}`);
    service.stop();
});

test('S1 t125: Delay is hidden once a break is overdue by more than delay-seconds', async () => {
    const {world, service} = await setup();
    world.work(92);
    const a = service.model().actions;
    eq(a.delay, false);
    eq(a.delayHidden.reason, 'overdue');
    eq(a.skip, true);
    service.stop();
});

test('S2: input during IN_BREAK: still due, "interrupted", no Take, Skip offered', async () => {
    const {world, manager, service} = await setup();
    world.work(61);
    world.advance(12);
    eq(manager.state, STATE.IN_BREAK);
    world.work(2);
    eq(manager.state, STATE.IN_BREAK, 'GNOME stays IN_BREAK while the user types');
    const m = service.model();
    ok(m.level.level >= LEVEL.DUE, `level ${m.level.level}`);
    eq([m.actions.take, m.actions.skip, m.actions.interrupted], [false, true, true]);
    eq(eyes(service).taken, 0);
    service.stop();
});

test('S2 t84-100: IDLE while working with a break owed: level ≥ 2, Skip offered', async () => {
    const {world, manager, service} = await setup();
    world.work(61);
    world.advance(12);
    world.work(20);
    world.advance(12);
    world.work(5);
    eq(manager.state, STATE.IDLE, 'GNOME reports IDLE while the user works');
    const m = service.model();
    ok(m.level.level >= LEVEL.DUE, `level ${m.level.level}`);
    eq([m.actions.take, m.actions.skip], [false, true]);
    eq(eyes(service).taken, 0);
    service.stop();
});

test('S3a: a 15 s idle with a 20 s break credits nothing, although both notifies fire', async () => {
    const {world, manager, service} = await setup();
    world.work(30);
    const ends = count(manager, 'notify::last-break-end-time');
    const dues = count(manager, 'notify::next-break-due-time');
    const before = [...manager._breakLastEnd];
    world.advance(15);
    world.input();
    ok(ends.length > 0 && dues.length > 0, 'GNOME notifies on every return');
    eq([...manager._breakLastEnd], before);
    eq(eyes(service), {taken: 0, delayed: 0, skipped: 0});
    service.stop();
});

async function takenAfterIdle(reverse) {
    const world = makeWorld();
    world.reverseActiveOrder = reverse;
    const {manager, service} = await setup({world});
    world.work(30);
    service.state.breaks.eyesight.consecutive = 2;
    world.advance(24);
    world.input();
    eq(manager._breakLastEnd.get('eyesight'), world.now() / 1000);
    eq(eyes(service).taken, 1);
    eq(service.state.breaks.eyesight.consecutive, 0);
    eq(service.lastEvent.kind, 'taken');
    service.stop();
}

test('S3a: a 24 s idle is an eye break taken; the skip streak resets', () => takenAfterIdle(false));

test('S3b: a break that falls due while away is taken on return', async () => {
    const {world, service} = await setup();
    world.work(50);
    world.advance(40);
    world.input();
    eq(eyes(service).taken, 1);
    service.stop();
});

test('S9: turning a type on is not a break; an interval change moves the due time; [] and back neither', async () => {
    const {world, service} = await setup();
    world.work(5);
    configure(world, 'movement', {interval: 600, duration: 60});
    select(world, ['eyesight', 'movement']);
    world.work(2);
    const due = () => service.model().lastEnd.eyesight + service.model().types.eyesight.interval;
    const before = due();
    configure(world, 'eyesight', {interval: 100});
    eq(due() - before, 40);
    select(world, []);
    world.work(2);
    eq(service.model().state, STATE.DISABLED);
    select(world, ['eyesight']);
    world.work(2);
    for (const t of ['eyesight', 'movement'])
        eq(service.state.today[t], {taken: 0, delayed: 0, skipped: 0}, t);
    service.stop();
});

async function bothCredited(reverse) {
    const world = makeWorld();
    world.reverseActiveOrder = reverse;
    const {service} = await setup({
        world,
        eyesight: {interval: 100, duration: 20, delay: 30},
        movement: {interval: 110, duration: 40, delay: 30},
        selected: ['eyesight', 'movement'],
    });
    world.work(111);
    const m = service.model();
    eq([m.level.level, m.level.type], [LEVEL.DUE, 'movement']);
    eq([m.actions.type, m.actions.skipBoth], ['movement', true]);
    world.advance(45);
    world.input();
    eq([service.state.today.eyesight.taken, service.state.today.movement.taken], [1, 1]);
    service.stop();
}

test('S10: one idle period ≥ the movement break credits both; movement is the reported type',
    () => bothCredited(false));

test('S11: a late stop is not counted on a short return', async () => {
    const {world, manager, service} = await setup({
        eyesight: {interval: 600, duration: 20, delay: 30},
        movement: {interval: 60, duration: 30, delay: 30},
        selected: ['movement'],
    });
    world.work(75);
    const finished = count(manager, 'break-finished');
    world.advance(20);
    world.input();
    eq(finished.length, 1, 'GNOME finished its break');
    eq(service.state.today.movement.taken, 0, 'but it did not count it');
    service.stop();
});

test('S12b: Delay after an interrupted break goes back to ACTIVE', async () => {
    const {world, manager, service} = await setup();
    world.work(61);
    world.advance(12);
    world.work(1);
    eq(manager.state, STATE.IN_BREAK);
    ok(service.model().actions.delay);
    service.delay();
    eq(manager.state, STATE.ACTIVE);
    eq(eyes(service).delayed, 1);
    service.stop();
});

test('Own skip and a skip from GNOME\'s notification: both skips, the source recorded', async () => {
    const {world, manager, service} = await setup();
    world.work(61);
    service.skip();
    eq(service.lastEvent, {type: 'eyesight', kind: 'skip', source: 'froonty'});
    world.work(61);
    eq(manager.state, STATE.BREAK_DUE);
    // Closing GNOME's notification calls skipBreak() (breakManager.js).
    manager.skipBreak();
    eq(service.lastEvent, {type: 'eyesight', kind: 'skip', source: 'gnome'});
    eq(eyes(service).skipped, 2);
    eq(service.state.breaks.eyesight.consecutive, 2);
    service.stop();
});

test('Order independence: Mutter runs the active watches in either order', async () => {
    await takenAfterIdle(true);
    await bothCredited(true);
});

test('Start after a gap, same Shell: a break GNOME credited meanwhile is taken; new Shell: nothing', async () => {
    for (const [pid, expected] of [[4242, 1], [9999, 0]]) {
        const world = makeWorld();
        const first = await setup({world});
        world.work(30);
        first.service.stop();
        // "Locked": away 30 s; GNOME credits the 20 s eye break on return.
        world.advance(30);
        world.input();
        // eslint-disable-next-line no-await-in-loop
        const second = await setup({world, store: first.store, settings: first.settings, pid});
        eq(second.service.state.today.eyesight.taken, expected, `pid ${pid}`);
        second.service.stop();
    }
});

test('Fallback without GNOME\'s per-type map: the next break only, levels still computed', async () => {
    // Everything the engine reads, except _breakLastEnd.
    const wrap = m => ({
        get state() {
            return m.state;
        },
        get currentBreakType() {
            return m.currentBreakType;
        },
        get nextBreakDueTime() {
            return m.nextBreakDueTime;
        },
        getNextBreakDue: t => m.getNextBreakDue(t),
        getCurrentTime: () => m.getCurrentTime(),
        delayBreak: () => m.delayBreak(),
        skipBreak: () => m.skipBreak(),
        takeBreak: () => m.takeBreak(),
        connect: (signal, callback) => m.connect(signal, callback),
        disconnect: id => m.disconnect(id),
    });
    const {world, service} = await setup({wrap});
    world.work(10);
    let m = service.model();
    eq([m.fallback, m.lastEnd, m.nextType], [true, null, 'eyesight']);
    // Due in 50 s.
    eq([m.level.level, m.level.type], [LEVEL.SOON, 'eyesight']);
    world.work(52);
    m = service.model();
    eq(m.level.level, LEVEL.DUE);
    eq(m.actions.skip, true);
    service.stop();
});

test('Stopped: no watch, timer or GNOME signal left', async () => {
    const {world, service} = await setup();
    world.work(3);
    ok(service.resources.idleWatch && service.resources.engineSignals && service.resources.boundaryTimer);
    world.advance(12);
    ok(service.resources.activeWatch, 'an active watch while idle');
    service.stop();
    eq(service.resources, {idleWatch: false, activeWatch: false, boundaryTimer: false,
        wallClock: false, engineSignals: false});
});

await done();
