// SPDX-License-Identifier: GPL-3.0-or-later
// Panic buttons: the catalog rules (pure).

import {test, eq, done} from './test.js';
import * as Catalog from '../../froonty@catalin/panic/catalog.js';

test('sanitize keeps known ids in order, drops unknown and duplicates', () => {
    eq(Catalog.sanitize(['mute-sound', 'nope', 'mute-sound', 'mute-microphone']),
        ['mute-sound', 'mute-microphone']);
});

test('sanitize caps the bar at 8 buttons', () => {
    const many = Array.from({length: 8}, () => Catalog.PANIC_BUTTONS.map(b => b.id)).flat();
    eq(Catalog.MAX_PANIC_BUTTONS, 8);
    // Only as many distinct buttons exist as the catalog has; the cap still holds.
    eq(Catalog.sanitize(many).length <= 8, true);
});

test('sanitize keeps 8 buttons and drops a 9th, in order', () => {
    // More buttons than Froonty has yet: stand-ins, for this test only.
    const extra = Array.from({length: 10}, (_, i) => ({id: `test-${i}`, icon: 'x-symbolic', title: s => s}));
    Catalog.PANIC_BUTTONS.push(...extra);
    try {
        const ids = extra.map(b => b.id);
        eq(Catalog.sanitize(ids.slice(0, 8)), ids.slice(0, 8));
        eq(Catalog.sanitize(ids.slice(0, 9)), ids.slice(0, 8));
        eq(Catalog.sanitize([...ids].reverse()), [...ids].reverse().slice(0, 8));
    } finally {
        Catalog.PANIC_BUTTONS.splice(-extra.length);
    }
});

test('panicGroups: half on each side of the date pill, the right one more when odd', () => {
    const ids = Array.from({length: 8}, (_, i) => `p${i + 1}`);
    const sizes = n => Catalog.panicGroups(ids.slice(0, n)).map(g => g.length);
    eq(Catalog.panicGroups([]), [[], []]);
    eq(Catalog.panicGroups(ids.slice(0, 1)), [[], ['p1']]);
    eq(Catalog.panicGroups(ids.slice(0, 3)), [['p1'], ['p2', 'p3']]);
    eq([2, 4, 5, 6, 7].map(sizes), [[1, 1], [2, 2], [2, 3], [3, 3], [3, 4]]);
    eq(Catalog.panicGroups(ids), [['p1', 'p2', 'p3', 'p4'], ['p5', 'p6', 'p7', 'p8']]);
});

test('every catalog entry has an id, an icon and a translatable title', () => {
    for (const b of Catalog.PANIC_BUTTONS) {
        eq(typeof b.id, 'string');
        eq(b.icon.endsWith('-symbolic'), true, b.id);
        eq(b.title(s => `[${s}]`).startsWith('['), true, b.id);
    }
});

test('byId finds entries and returns null for unknown ids', () => {
    eq(Catalog.byId('mute-sound').icon, 'audio-volume-muted-symbolic');
    eq(Catalog.byId('nope'), null);
});

test('the Break tab\'s "Sitting or standing" is offered, with its bundled icon', () => {
    const entry = Catalog.byId('sit-stand');
    eq(entry.icon, 'froonty-stand-symbolic');
    eq(entry.title(s => s), 'Sitting or standing');
    eq(entry.description(s => s).includes('sit/stand'), true);
});

await done();
