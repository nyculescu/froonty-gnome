// SPDX-License-Identifier: GPL-3.0-or-later
// Software brightness: which monitors are dimmed, how much, and where the
// Quick Settings slider stands (features/brightness/levels.js).

import {
    appliedLevel, levelFromSlider, overlayOpacity, sliderValue, TARGETS, targetMonitors,
} from '../../froonty@catalin/features/brightness/levels.js';
import {done, eq, ok, test} from './test.js';

test('the targets are the schema\'s choices, in the settings\' order', () => {
    eq(TARGETS, ['external', 'built-in', 'all']);
});

test('a laptop with a monitor: external is the monitor, built-in the panel', () => {
    // The panel is monitor 1 here: built-in is not the same as primary.
    const builtIn = new Set([1]);
    eq(targetMonitors('external', 2, builtIn), [0]);
    eq(targetMonitors('built-in', 2, builtIn), [1]);
    eq(targetMonitors('all', 2, builtIn), [0, 1]);
});

test('a desktop (no built-in panel): external is every monitor', () => {
    eq(targetMonitors('external', 3, new Set()), [0, 1, 2]);
    eq(targetMonitors('built-in', 3, new Set()), []);
});

test('no monitors: nothing to dim', () => {
    for (const target of TARGETS)
        eq(targetMonitors(target, 0, new Set()), []);
});

test('the level applied never goes below the minimum or above 100', () => {
    eq(appliedLevel(3, 10), 10);
    eq(appliedLevel(40, 10), 40);
    eq(appliedLevel(100, 10), 100);
    eq(appliedLevel(120, 10), 100);
});

test('the overlay: none at 100 %, black at 0 %', () => {
    eq(overlayOpacity(100), 0);
    eq(overlayOpacity(0), 255);
    eq(overlayOpacity(50), 128);
});

test('the slider spans the minimum to 100 %', () => {
    eq(sliderValue(10, 10), 0);
    eq(sliderValue(100, 10), 1);
    eq(sliderValue(55, 10), 0.5);
    // A level under a raised minimum shows at the left end.
    eq(sliderValue(5, 30), 0);
    eq(levelFromSlider(0, 10), 10);
    eq(levelFromSlider(1, 10), 100);
    eq(levelFromSlider(0.5, 10), 55);
    eq(levelFromSlider(-1, 10), 10);
    eq(levelFromSlider(2, 10), 100);
});

test('slider to level and back keeps every whole level', () => {
    for (const minimum of [5, 10, 33, 90]) {
        for (let level = minimum; level <= 100; level++) {
            ok(levelFromSlider(sliderValue(level, minimum), minimum) === level,
                `minimum ${minimum}, level ${level}`);
        }
    }
});

await done();
