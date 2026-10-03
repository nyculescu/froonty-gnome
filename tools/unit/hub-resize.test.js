// SPDX-License-Identifier: GPL-3.0-or-later
import {clampAxis, clampHubSize, draggedSize, KEY_STEP, KEY_STEP_LARGE, nudgedSize} from
    '../../froonty@catalin/ui/hubResize.js';
import {done, eq, test} from './test.js';

// Notes' width key: 360-960; the hub needs 450; the work area has 1920.
const WIDTH = {min: 360, max: 960, need: 450, room: 1920};

test('a value inside every limit is kept, rounded', () => {
    eq(clampAxis(500, WIDTH), 500);
    eq(clampAxis(500.4, WIDTH), 500);
    eq(clampAxis(500.6, WIDTH), 501);
});

test('never below what the hub needs, nor the schema minimum', () => {
    eq(clampAxis(300, WIDTH), 450);
    eq(clampAxis(100, {min: 360, max: 960, need: 0}), 360);
    eq(clampAxis(100, {min: 360, max: 960}), 360);
});

test('never above the schema maximum, nor the work area', () => {
    eq(clampAxis(2000, WIDTH), 960);
    eq(clampAxis(2000, {...WIDTH, room: 800}), 800);
    eq(clampAxis(2000, {min: 360, max: 960}), 960);
});

test('the hub\'s need wins over a small work area', () => {
    eq(clampAxis(2000, {...WIDTH, room: 400}), 450);
    eq(clampAxis(100, {...WIDTH, room: 400}), 450);
});

test('the schema range wins over everything: the value can be written', () => {
    eq(clampAxis(2000, {...WIDTH, need: 1200}), 960);
    eq(clampAxis(100, {...WIDTH, need: 1200}), 960);
    eq(clampAxis(100, {...WIDTH, room: 100}), 450);
    eq(clampAxis(100, {min: 360, max: 960, room: 100}), 360);
});

test('both axes at once', () => {
    eq(clampHubSize({width: 2000, height: 50}, {
        width: WIDTH,
        height: {min: 200, max: 720, need: 410, room: 1046},
    }), {width: 960, height: 410});
});

test('a drag widens the centred island on both sides and lengthens it downward', () => {
    eq(draggedSize({width: 428, height: 319}, 30, 40), {width: 488, height: 359});
    eq(draggedSize({width: 428, height: 319}, -14, -9), {width: 400, height: 310});
    // Stage px at scale 2 are half as many logical px.
    eq(draggedSize({width: 428, height: 319}, 30, 40, 2), {width: 458, height: 339});
});

test('arrow keys step one axis; Shift takes the larger step', () => {
    const size = {width: 400, height: 300};
    eq(nudgedSize(size, 'right'), {width: 400 + KEY_STEP, height: 300});
    eq(nudgedSize(size, 'left'), {width: 400 - KEY_STEP, height: 300});
    eq(nudgedSize(size, 'down'), {width: 400, height: 300 + KEY_STEP});
    eq(nudgedSize(size, 'up', true), {width: 400, height: 300 - KEY_STEP_LARGE});
    eq(nudgedSize(size, 'sideways'), size);
});

await done();
