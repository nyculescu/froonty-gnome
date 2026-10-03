// SPDX-License-Identifier: GPL-3.0-or-later
// Panic buttons: the catalog rules (pure).

import {test, eq, done} from './test.js';
import * as Catalog from '../../froonty@catalin/panic/catalog.js';

test('sanitize keeps known ids in order, drops unknown and duplicates', () => {
    eq(Catalog.sanitize(['mute-sound', 'nope', 'mute-sound', 'mute-microphone']),
        ['mute-sound', 'mute-microphone']);
});

test('sanitize caps the bar at 5 buttons', () => {
    const many = Array.from({length: 8}, () => Catalog.PANIC_BUTTONS.map(b => b.id)).flat();
    eq(Catalog.MAX_PANIC_BUTTONS, 5);
    // Only as many distinct buttons exist as the catalog has; the cap still holds.
    eq(Catalog.sanitize(many).length <= 5, true);
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
