// SPDX-License-Identifier: GPL-3.0-or-later
// Software brightness: which monitors are dimmed, how much, and where the
// Quick Settings slider stands (features/brightness/levels.js).

import {
    appliedLevel, levelFromSlider, mergedMonitors, overlayOpacity, sliderFromTemperature, sliderValue,
    TARGETS, targetMonitors, temperatureFromSlider,
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

test('a laptop open and joined to a monitor: the monitor joins GNOME\'s slider', () => {
    // The panel (index 1) has the backlight; the monitor is 0.
    eq(mergedMonitors('external', 2, new Set([1]), new Set([1])), [0]);
    eq(mergedMonitors('external', 3, new Set([0]), new Set([0])), [1, 2]);
});

test('two sliders when GNOME shows none, or a dimmed monitor has a backlight', () => {
    // Lid closed: the panel is off, so no backlight and no GNOME slider.
    eq(mergedMonitors('external', 1, new Set(), new Set()), null);
    // The laptop alone, or mirrored (one logical monitor, built-in): nothing external.
    eq(mergedMonitors('external', 1, new Set([0]), new Set([0])), null);
    // The panel dimmed on top of its own backlight.
    eq(mergedMonitors('built-in', 2, new Set([1]), new Set([1])), null);
    eq(mergedMonitors('all', 2, new Set([1]), new Set([1])), null);
    // A desktop where GNOME dims one of two monitors.
    eq(mergedMonitors('external', 2, new Set(), new Set([0])), null);
});

test('the level applied never goes below the minimum', () => {
    eq(appliedLevel(3, 10), 10);
    eq(appliedLevel(40, 10), 40);
    eq(appliedLevel(100, 10), 100);
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

test('Night Light warmth: 6500 K (neutral) at the left, 1700 K at the right, in 100 K steps', () => {
    eq([temperatureFromSlider(0), temperatureFromSlider(1), temperatureFromSlider(0.5)], [6500, 1700, 4100]);
    eq([temperatureFromSlider(-1), temperatureFromSlider(2), temperatureFromSlider(0.01)], [6500, 1700, 6500]);
    eq([sliderFromTemperature(6500), sliderFromTemperature(1700), sliderFromTemperature(3300)],
        [0, 1, 2 / 3]);
});

test('Night Light warmth: a temperature outside the range sits at an end', () => {
    eq([sliderFromTemperature(8000), sliderFromTemperature(1000)], [0, 1]);
});

test('Night Light warmth: every 100 K step survives slider and back', () => {
    for (let kelvin = 1700; kelvin <= 6500; kelvin += 100)
        eq(temperatureFromSlider(sliderFromTemperature(kelvin)), kelvin);
});

await done();
