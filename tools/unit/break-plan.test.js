// SPDX-License-Identifier: GPL-3.0-or-later
// The standing target and its build-up (features/break/plan.js): pure.

import {done, eq, test} from './test.js';
import {builtTarget, evaluateStep, met, todayTarget} from '../../froonty@catalin/features/break/plan.js';

const PLAN = {base: 120, buildup: true, step: 15, ceiling: 240, built: 0};

// Working days, newest first: `metFlags` say which met their target.
function days(metFlags, {from = 20, minimumOnly = [], active = 4 * 3600} = {}) {
    return metFlags.map((ok, i) => ({
        day: `2026-10-${String(from - i).padStart(2, '0')}`,
        activeSeconds: active,
        standingSeconds: ok ? 7200 : 3600,
        targetSeconds: 7200,
        minimumOnly: minimumOnly.includes(i),
    }));
}

test('a step after meeting the target on 4 of the last 5 working days', () => {
    eq(evaluateStep(PLAN, days([true, true, false, true, true]), null, '2026-10-21'),
        {built: 135, lastStepDay: '2026-10-21'});
    eq(evaluateStep(PLAN, days([true, false, false, true, true]), null, '2026-10-21'), null);
    eq(evaluateStep(PLAN, days([true, true, true, true]), null, '2026-10-21'), null, 'fewer than 5 days');
});

test('at most once a week: no step 6 days after the last one', () => {
    const history = days([true, true, true, true, true]);
    eq(evaluateStep(PLAN, history, '2026-10-15', '2026-10-21'), null);
    eq(evaluateStep(PLAN, history, '2026-10-14', '2026-10-21').built, 135);
});

test('never above the ceiling', () => {
    const history = days([true, true, true, true, true]);
    eq(evaluateStep({...PLAN, built: 235}, history, null, '2026-10-21').built, 240);
    eq(evaluateStep({...PLAN, built: 240}, history, null, '2026-10-21'), null);
});

test('"just the minimum" days and short days do not count', () => {
    const history = days([true, true, true, true, true, true], {minimumOnly: [0]});
    // Without day 0, the last five are days 1-5: all met.
    eq(evaluateStep(PLAN, history, null, '2026-10-21').built, 135);
    eq(evaluateStep(PLAN, days([true, true, true, true, true], {active: 1800}), null, '2026-10-21'), null);
});

test('build-up off is the base; "just the minimum" is today only; build-up never steps down', () => {
    eq(todayTarget({...PLAN, built: 180}, false), 180);
    eq(todayTarget({...PLAN, built: 180, buildup: false}, false), 120);
    eq(todayTarget({...PLAN, built: 180}, true), 120);
    eq(evaluateStep({...PLAN, buildup: false}, days([true, true, true, true, true]), null, '2026-10-21'), null);
    eq(evaluateStep({...PLAN, built: 180}, days([false, false, false, false, false]), null, '2026-10-21'), null);
});

test('reset (0) and a base raised above the target: the base', () => {
    eq(builtTarget({...PLAN, built: 0}), 120);
    eq(builtTarget({...PLAN, base: 200, built: 150}), 200);
    eq(builtTarget({...PLAN, base: 300, ceiling: 240, built: 150}), 300);
});

test('met: standing reached the day\'s own target', () => {
    eq(met({standingSeconds: 7200, targetSeconds: 7200}), true);
    eq(met({standingSeconds: 7199, targetSeconds: 7200}), false);
    eq(met({standingSeconds: 100, targetSeconds: 0}), false);
});

await done();
