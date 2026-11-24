// SPDX-License-Identifier: GPL-3.0-or-later
// Night Light's schedule in the brightness menu: From and To steps and All
// day (features/brightness/schedule.js).

import {
    allDaySchedule, clockFromHours, hoursFromClock, isAllDay, stepHour, stepMinutes, twoDigits,
} from '../../froonty@catalin/features/brightness/schedule.js';
import {done, eq, ok, test} from './test.js';

test('a stored time reads as hours and minutes, to the nearest minute', () => {
    eq(clockFromHours(20), [20, 0]);
    eq(clockFromHours(6.5), [6, 30]);
    eq(clockFromHours(hoursFromClock(7, 5)), [7, 5]);
    eq(clockFromHours(23.9999), [0, 0]);
    eq(clockFromHours(-0.5), [23, 30]);
});

test('two digits, as GNOME Settings shows them', () => {
    eq([twoDigits(6), twoDigits(0), twoDigits(20)], ['06', '00', '20']);
});

test('the hour steps round midnight and keeps the minutes', () => {
    eq(clockFromHours(stepHour(20.5, 1)), [21, 30]);
    eq(clockFromHours(stepHour(hoursFromClock(23, 15), 1)), [0, 15]);
    eq(clockFromHours(stepHour(0, -1)), [23, 0]);
});

test('the minutes step to the next multiple of 5, round the hour, and keep the hour', () => {
    eq(clockFromHours(stepMinutes(6, 1)), [6, 5]);
    eq(clockFromHours(stepMinutes(6, -1)), [6, 55]);
    eq(clockFromHours(stepMinutes(hoursFromClock(6, 3), 1)), [6, 5]);
    eq(clockFromHours(stepMinutes(hoursFromClock(6, 3), -1)), [6, 0]);
    eq(clockFromHours(stepMinutes(hoursFromClock(6, 55), 1)), [6, 0]);
});

test('All day sets To to From by hand, which GNOME runs all day', () => {
    const schedule = allDaySchedule({from: 20, to: 6, automatic: false});
    eq(schedule, {from: 20, to: 20, automatic: false});
    ok(isAllDay(schedule));
    ok(isAllDay(allDaySchedule({from: 20, to: 6, automatic: true})), 'over sunset to sunrise');
});

test('a schedule changed elsewhere is no longer All day', () => {
    ok(!isAllDay({from: 20, to: 6, automatic: false}));
    ok(!isAllDay({from: 20, to: 20, automatic: true}), 'sunset to sunrise ignores the times');
});

await done();
