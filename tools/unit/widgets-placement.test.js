// SPDX-License-Identifier: GPL-3.0-or-later
// Desktop items' placement: each its own position (a share of its room)
// and size; never overlapping each other or a dock; the room beside a
// fixed dock; the editor's drop (features/widgets/placement.js).

import {
    DEFAULT_PLACEMENT, DEFAULT_STICKY, GAP, ITEMS, MAX_POSITION, desktopRoom, isSticky, layoutItems,
    normalizePlacement, placementFromBox, snapBox, stickyId, storedPlacement,
} from '../../froonty@catalin/features/widgets/placement.js';
import {done, eq, ok, test} from './test.js';

// A 1920×1080 monitor: top bar 32 px, a fixed dock 64 px on the left, in
// the lower part of its strip.
const monitor = {x: 0, y: 0, width: 1920, height: 1080};
const work = {x: 64, y: 32, width: 1856, height: 1048};
const dock = {x: 0, y: 600, width: 64, height: 400};
const plain = {x: 0, y: 32, width: 1920, height: 1048};

// Items 386 px wide outside (360 + padding and border); natural heights.
const natural = {markets: 445, news: 600, system: 250};
// A sticky: its own width (plus padding and border), 200 px tall.
const measure = (id, cap, width = 360) => ({width: (isSticky(id) ? width : 360) + 26,
    height: Math.min(natural[id] ?? 200, cap)});
const item = (id, x = 0, y = 0, height = 0) => ({id, x, y, width: 360, height});
const overlapping = boxes => boxes.some((a, i) => boxes.slice(i + 1).some(b =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height));

test('the items, and the default: the widgets stacked top left, each sticky top right', () => {
    eq(ITEMS, ['markets', 'news', 'system']);
    eq(DEFAULT_STICKY, {x: MAX_POSITION, y: 0, width: 300, height: 300});
    const ids = [...ITEMS, stickyId('Shopping'), stickyId('Ideas')];
    eq(ids.slice(3).map(isSticky), [true, true]);
    const placement = normalizePlacement({}, ids);
    eq(placement['sticky:Ideas'], DEFAULT_STICKY, 'a sticky without an entry starts top right');
    const at = layoutItems({work: plain, monitor, dock: null}, ids.map(id => ({id, ...placement[id]})),
        (id, cap) => measure(id, cap, placement[id].width));
    eq(['markets', 'news', 'system'].map(id => at.get(id).x), [0, 0, 0]);
    eq(at.get('news').y, 32 + 445 + GAP);
    eq([at.get('sticky:Shopping').x, at.get('sticky:Shopping').y, at.get('sticky:Shopping').width], [1920 - 326, 32, 326]);
    eq([at.get('sticky:Ideas').x, at.get('sticky:Ideas').y], [1920 - 326, 32 + 200 + GAP], 'the second under the first');
    ok(!overlapping([...at.values()]));
});

test('each sticky keeps its own place and width', () => {
    const ids = [...ITEMS, stickyId('A'), stickyId('B')];
    const p = normalizePlacement({'sticky:A': [0, 10000, 500, 0], 'sticky:B': [5000, 0, 200, 0]}, ids);
    eq([p['sticky:A'].width, p['sticky:B'].width], [500, 200]);
    eq(Object.keys(storedPlacement(p)), ids);
});

test('the setting: defaults for missing or odd entries, values kept in range, and back', () => {
    eq(normalizePlacement({}), DEFAULT_PLACEMENT);
    eq(Object.keys(DEFAULT_PLACEMENT), ['markets', 'news', 'system']);
    const p = normalizePlacement({markets: [20000, -3, 5000, 50], news: ['top-left', 0, 0, 360, 0]});
    eq(p.markets, {x: 10000, y: 0, width: 1200, height: 120});
    eq(p.news, DEFAULT_PLACEMENT.news);
    eq(normalizePlacement(storedPlacement(p)), p);
});

test('a position is a share of the room left: 0 at one edge, 10000 at the other', () => {
    const at = layoutItems({work: plain, monitor, dock: null},
        [item('markets', 10000, 10000), item('system', 5000, 0)], measure);
    eq([at.get('markets').x, at.get('markets').y], [1920 - 386, 1080 - 445]);
    eq(at.get('system').x, Math.round((1920 - 386) / 2));
});

test('side by side: Horizon right of Markets stays there', () => {
    const right = placementFromBox({x: 386 + GAP, y: 32, width: 386, height: 600}, plain);
    const at = layoutItems({work: plain, monitor, dock: null},
        [item('markets'), item('news', right.x, right.y)], measure);
    eq([at.get('news').x, at.get('news').y], [386 + GAP, 32]);
});

test('never overlapping: one in the way is pushed down; near the bottom it is cut to fit', () => {
    const at = layoutItems({work: plain, monitor, dock: null},
        [item('markets'), item('news', 0, 100), item('system', 0, 1000)], measure);
    ok(!overlapping([...at.values()]), JSON.stringify([...at]));
    eq(at.get('news').y, 32 + 445 + GAP);
    ok(at.get('news').height <= 1080 - at.get('news').y);
});

test('beside the dock: its strip is room, the dock itself is in the way', () => {
    const screen = {work, monitor, dock};
    eq(desktopRoom(screen).area, {x: 0, y: 32, width: 1920, height: 1048});
    eq(desktopRoom({work: plain, monitor, dock: null}).obstacles, []);
    const at = layoutItems(screen, [item('markets'), item('news')], measure);
    eq([at.get('markets').x, at.get('markets').y], [0, 32], 'Markets above the dock, from the screen\'s edge');
    // Under Markets the dock is in the way and below it there is no room:
    // beside what was in its way at the top, Markets.
    eq([at.get('news').x, at.get('news').y], [386 + GAP, 32]);
    ok(!overlapping([...at.values(), dock]));
});

test('a dock filling its strip leaves it no room: items start at the work area', () => {
    const full = {x: 0, y: 40, width: 64, height: 1000};
    eq(desktopRoom({work, monitor, dock: full}), {area: work, obstacles: []});
    const at = layoutItems({work, monitor, dock: full}, [item('news')], measure);
    eq([at.get('news').x, at.get('news').y], [64, 32]);
});

test('above a dock that fills part of its strip: from the screen\'s edge, cut at its top', () => {
    const low = {x: 0, y: 232, width: 64, height: 848};
    const at = layoutItems({work, monitor, dock: low}, [item('markets')], measure);
    const m = at.get('markets');
    eq([m.x, m.y, m.cap], [0, 32, 232 - GAP - 32]);
    ok(m.y + m.height <= low.y - GAP);
});

test('the editor\'s drop: dropped over Markets, Horizon goes beside it; edges line up', () => {
    const markets = {x: 0, y: 32, width: 386, height: 445};
    const over = snapBox({x: 300, y: 40, width: 386, height: 600}, [markets], plain);
    eq([over.x, over.y], [386 + GAP, 32], 'to its right, tops lined up');
    const near = snapBox({x: 386 + GAP + 10, y: 50, width: 386, height: 300}, [markets], plain);
    eq([near.x, near.y], [386 + GAP, 32], 'within SNAP it lines up');
    const far = snapBox({x: 900, y: 600, width: 100, height: 100}, [markets], plain);
    eq([far.x, far.y], [900, 600], 'away from everything it stays');
});

test('the drop\'s position: a share of the room it can move in', () => {
    eq(placementFromBox({x: 0, y: 32, width: 386, height: 400}, plain), {x: 0, y: 0});
    eq(placementFromBox({x: 1920 - 386, y: 1080 - 400, width: 386, height: 400}, plain), {x: 10000, y: 10000});
    eq(placementFromBox({x: -50, y: 2000, width: 386, height: 400}, plain), {x: 0, y: 10000});
});

await done();
