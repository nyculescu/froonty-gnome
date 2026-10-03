// SPDX-License-Identifier: GPL-3.0-or-later
// The Break tab's ledger (features/break/ledger.js): at the computer or
// away, day totals, standing time, midnights; and the service's idle,
// lock and suspend rules on a fake timeline.

import {done, eq, ok, test} from './test.js';
import {setup} from './breakWorld.js';
import {makeWorld} from './gnomeBreakManager.js';
import {Emitter} from '../../froonty@catalin/core/emitter.js';
import {
    addAway, addPresent, dayKey, freshState, nextMidnight, pushHistory, suspendDrift,
} from '../../froonty@catalin/features/break/ledger.js';

const RULES = {movementSeconds: 300, longRestSeconds: 900};
const MIN = 60 * 1000;

// Midnights every 24 h from 0, for exact day tests.
const DAYS = {
    dayKey: ms => `2026-10-${String(1 + Math.floor(ms / 86400000)).padStart(2, '0')}`,
    nextMidnight: ms => (Math.floor(ms / 86400000) + 1) * 86400000,
};

test('present time adds to today, screen time and the posture clock; standing only while standing', () => {
    const s = freshState(0, DAYS);
    addPresent(s, 10 * MIN, DAYS);
    eq([s.today.activeSeconds, s.ledger.screenSinceLongRest, s.posture.modeActiveSeconds], [600, 600, 600]);
    eq(s.today.standingSeconds, 0);
    s.posture.mode = 'standing';
    addPresent(s, 15 * MIN, DAYS);
    eq(s.today.standingSeconds, 300);
    // An away is not standing.
    addAway(s, 15 * MIN, 20 * MIN, RULES, DAYS);
    eq(s.today.standingSeconds, 300);
});

test('an away: long rest, stretch, posture clock and posture by its length', () => {
    const s = freshState(0, DAYS);
    addPresent(s, 60 * MIN, DAYS);
    s.posture.mode = 'standing';
    addAway(s, 60 * MIN, 62 * MIN, RULES, DAYS);
    eq([s.posture.modeActiveSeconds, s.posture.mode, s.ledger.stretchStart], [0, 'standing', 0]);
    addAway(s, 62 * MIN, 67 * MIN, RULES, DAYS);
    eq(s.ledger.stretchStart, 67 * MIN, 'an away of a movement break ends the stretch');
    eq(s.today.longRests, 0);
    addAway(s, 67 * MIN, 82 * MIN, RULES, DAYS);
    eq([s.today.longRests, s.ledger.screenSinceLongRest], [1, 0]);
    eq(s.posture.mode, 'standing');
    addAway(s, 82 * MIN, 142 * MIN, RULES, DAYS);
    eq(s.posture.mode, 'sitting', 'an hour away: sitting again');
    eq(s.today.longestStretchSeconds, 3600);
});

test('midnight splits present time; a day with nothing gets no history row', () => {
    const s = freshState(86400000 - 10 * MIN, DAYS);
    const closed = addPresent(s, 86400000 + 5 * MIN, DAYS);
    eq(closed.length, 1);
    eq([closed[0].day, closed[0].activeSeconds], ['2026-10-01', 600]);
    eq([s.today.day, s.today.activeSeconds], ['2026-10-02', 300]);
    // Away over a whole day: the empty day in between has no record.
    const gap = addAway(s, 86400000 + 5 * MIN, 3 * 86400000 + MIN, RULES, DAYS);
    eq(gap.map(d => d.day), ['2026-10-02']);
    eq(s.today.day, '2026-10-04');
    eq([s.today.longRests, s.ledger.screenSinceLongRest], [0, 0], 'a night away: rested, not a long rest of the day');
    let history = pushHistory([], closed[0], 98);
    history = pushHistory(history, freshState(2 * 86400000, DAYS).today, 98);
    eq(history.map(d => d.day), ['2026-10-01'], 'the empty day is not kept');
});

test('history is newest first and trimmed to break-history-days', () => {
    let history = [];
    for (let i = 1; i <= 10; i++) {
        const day = freshState(0, DAYS).today;
        day.day = `2026-10-${String(i).padStart(2, '0')}`;
        day.activeSeconds = 100;
        history = pushHistory(history, day, 7);
    }
    eq(history.length, 7);
    eq([history[0].day, history[6].day], ['2026-10-10', '2026-10-04']);
});

test('local days: keys and the next midnight', () => {
    const noon = new Date(2026, 9, 2, 12, 0, 0).getTime();
    eq(dayKey(noon), '2026-10-02');
    eq(nextMidnight(noon), new Date(2026, 9, 3, 0, 0, 0).getTime());
});

test('suspend drift: a wall-clock step 60 s or more beyond the monotonic one', () => {
    eq(suspendDrift(60 * 1000, 0), 60);
    eq(suspendDrift(60 * 1000, 30 * 1e6), null);
    eq(suspendDrift(600 * 1000, 60 * 1e6), 540);
});

test('service: a pause under 2 min is still at the computer; 2 min or more is away from when it began', async () => {
    const {world, service} = await setup({eyesight: {interval: 3600, duration: 20, delay: 30}});
    world.work(60);
    const active = () => service.model().today.activeSeconds;
    const before = active();
    world.advance(100);
    world.input();
    ok(Math.abs(active() - before - 100) < 2, `short pause counted: ${active() - before}`);
    const start = active();
    world.advance(200);
    world.input();
    // Idle began 10 s before the watch fired, at the last input.
    ok(Math.abs(active() - start) < 2, `away not counted: ${active() - start}`);
    service.stop();
});

test('service: a lock is away; an idle period open at the lock widens it', async () => {
    const world = makeWorld();
    const first = await setup({world, eyesight: {interval: 3600, duration: 20, delay: 30}});
    world.work(60);
    world.advance(30); // idle since 59 s, open
    first.service.stop();
    world.advance(600);
    world.input();
    const second = await setup({world, store: first.store, settings: first.settings,
        eyesight: {interval: 3600, duration: 20, delay: 30}});
    const today = second.service.model().today;
    ok(Math.abs(today.activeSeconds - 59) < 2, `active ${today.activeSeconds}`);
    second.service.stop();
});

test('service: a suspend without a lock is an away (WallClock tick)', async () => {
    const world = makeWorld();
    const wallClock = new Emitter();
    const {service} = await setup({world, wallClock, eyesight: {interval: 3600, duration: 20, delay: 30},
        froonty: {'posture-enabled': true}});
    service.setPosture('standing');
    world.work(60);
    wallClock.emit('notify::clock');
    world.suspend(3700);
    wallClock.emit('notify::clock');
    const m = service.model();
    ok(Math.abs(m.today.activeSeconds - 60) < 2, `active ${m.today.activeSeconds}`);
    eq(m.posture.mode, 'sitting', 'an hour away: sitting');
    eq(service.state.today.longRests, 1);
    eq(service.resources.wallClock, true);
    service.stop();
});

test('service: standing counts only while at the computer', async () => {
    const {world, service} = await setup({eyesight: {interval: 3600, duration: 20, delay: 30},
        froonty: {'posture-enabled': true}});
    service.setPosture('standing');
    world.work(120);
    world.advance(300);
    world.input();
    const standing = service.model().today.standingSeconds;
    ok(standing >= 118 && standing <= 122, `standing ${standing}`);
    service.stop();
});

await done();
