// SPDX-License-Identifier: GPL-3.0-or-later
// Garmin in the Break tab (features/break/garminData.js, and the service
// with a fake helper): which activities count, when Garmin is asked, the
// backoff after a refusal, and what a reading changes. Nothing reaches
// Garmin: the helper is a fake.

import {done, eq, ok, test} from './test.js';
import {setup} from './breakWorld.js';
import {
    WORKOUT_MIN_SECONDS, afterRead, coversAway, freshGarmin, intensityOf, shouldRead, todaysActivities,
    workoutOf,
} from '../../froonty@catalin/features/break/garminData.js';
import {lastJson} from '../../froonty@catalin/features/break/garminRun.js';
import {makeWorld} from './gnomeBreakManager.js';

String.prototype.format ??= imports.format.format;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const dayOf = ms => (ms < 86400000 ? '2026-10-01' : '2026-10-02');

test('when to ask: every 15 min, 5 after an away, at once when turned on, never during a backoff', () => {
    const g = {...freshGarmin(), lastTry: 100 * MIN};
    eq(shouldRead(g, 110 * MIN, 'tab'), false);
    eq(shouldRead(g, 115 * MIN, 'tab'), true);
    eq(shouldRead(g, 105 * MIN, 'return'), true);
    eq(shouldRead(g, 101 * MIN, 'setting'), true);
    eq(shouldRead({...g, nextTry: 200 * MIN}, 150 * MIN, 'start'), false);
});

test('after an answer: a refusal waits 6 h, the network 15 min; a success clears the error', () => {
    const g = freshGarmin();
    const blocked = afterRead(g, {ok: false, error: 'blocked'}, 0);
    eq([blocked.error, blocked.nextTry], ['blocked', 6 * HOUR]);
    eq(afterRead(g, {ok: false, error: 'network'}, 0).nextTry, 15 * MIN);
    eq(afterRead(g, {ok: false, error: 'weird'}, 0).error, 'other');
    eq(afterRead(blocked, {ok: true}, 10), {lastTry: 10, lastSync: 10, nextTry: 0, error: null});
});

test('today\'s activities only, with their end; anything odd left out', () => {
    const result = {ok: true, activities: [
        {id: '1', type: 'strength_training', start: 8 * HOUR, seconds: 2700},
        {id: '2', type: 'walking', start: 30 * HOUR, seconds: 1800},
        {id: 3, start: 9 * HOUR, seconds: 1800},
        {id: '4', start: 9 * HOUR, seconds: -5},
    ]};
    eq(todaysActivities(result, '2026-10-01', dayOf),
        [{id: '1', type: 'strength_training', start: 8 * HOUR, end: 8 * HOUR + 2700000, minutes: 45}]);
    eq(todaysActivities({ok: false}, '2026-10-01', dayOf), []);
    eq(intensityOf({ok: true, intensity: {moderate: 20, vigorous: 10}}), {moderate: 20, vigorous: 10});
    eq(intensityOf({ok: true}), null);
});

test('a workout day: by hand plus Garmin\'s activities of 20 min or more', () => {
    const day = {workoutMinutes: 30, workoutEnd: 5 * HOUR, garmin: [
        {id: 'a', type: 'walking', start: 6 * HOUR, end: 6 * HOUR + 15 * MIN, minutes: 15},
        {id: 'b', type: 'cycling', start: 9 * HOUR, end: 10 * HOUR, minutes: 60},
    ]};
    ok(WORKOUT_MIN_SECONDS === 20 * 60);
    const w = workoutOf(day);
    eq([w.minutes, w.end, w.garmin.map(a => a.id)], [90, 10 * HOUR, ['b']]);
    eq(workoutOf({workoutMinutes: 0, workoutEnd: null}).minutes, 0);
});

test('an activity covering most of a long away answers "Was that a workout?"', () => {
    const a = [{start: 10 * HOUR, end: 11 * HOUR}];
    eq(coversAway(a, {from: 10 * HOUR, to: 11.5 * HOUR}), true);
    eq(coversAway(a, {from: 7 * HOUR, to: 10.25 * HOUR}), false);
    eq(coversAway(a, null), false);
});

test('the helper\'s answer is its last JSON line', () => {
    eq(lastJson('noise\n{"need": "mfa"}\n{"ok": true}\n'), {ok: true});
    eq(lastJson('nothing'), null);
});

// A fake helper: records the days asked for and answers `answer`.
function fakeGarmin(answer) {
    const calls = [];
    return {
        calls,
        read: day => {
            calls.push(day);
            return {promise: Promise.resolve(typeof answer === 'function' ? answer() : answer), cancel: () => {}};
        },
    };
}
const settle = async () => {
    for (let i = 0; i < 5; i++)
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
};

test('off (the default): Garmin is never asked', async () => {
    const garmin = fakeGarmin({ok: true, activities: []});
    const {service} = await setup({garmin});
    service.syncGarmin('tab');
    await settle();
    eq(garmin.calls, []);
    service.stop();
});

test('on: asked at the start; a workout from Garmin makes a workout day', async () => {
    let start = 0;
    const garmin = fakeGarmin(() => ({ok: true, activities: [
        {id: '7', type: 'strength_training', start, seconds: 3000},
    ], intensity: {moderate: 25, vigorous: 5}}));
    const world = makeWorld({start: Date.UTC(2026, 9, 1, 17)}); // 10 a.m. local, away from midnight.
    const {service, settings} = await setup({world, garmin, froonty: {'break-garmin': true}});
    start = world.now() - 2 * HOUR;
    await settle();
    eq(garmin.calls.length, 1, 'at the start');
    // The start's answer came before `start` was set: ask again.
    settings.set_boolean('break-garmin', false);
    settings.set_boolean('break-garmin', true);
    await settle();
    const m = service.model();
    eq([m.workout.minutes, m.workout.garmin.length, m.workout.after], [50, 1, true]);
    eq(m.workout.intensity, {moderate: 25, vigorous: 5});
    eq(m.garmin.error, null);
    world.work(5);
    service.stop();
});

test('a refusal: no question to Garmin for hours, and the tab says so', async () => {
    const garmin = fakeGarmin({ok: false, error: 'blocked', message: '403'});
    const {world, service} = await setup({garmin, froonty: {'break-garmin': true}});
    await settle();
    eq(service.model().garmin.error, 'blocked');
    world.work(20 * 60);
    service.syncGarmin('tab');
    await settle();
    eq(garmin.calls.length, 1, 'still the first one only');
    service.stop();
});

test('back from an away of 20 min or more: Garmin is asked', async () => {
    const garmin = fakeGarmin({ok: true, activities: []});
    const {world, service} = await setup({garmin, froonty: {'break-garmin': true}});
    await settle();
    world.work(10 * 60);
    world.advance(25 * 60);
    world.work(2);
    await settle();
    eq(garmin.calls.length, 2);
    service.stop();
});

await done();
