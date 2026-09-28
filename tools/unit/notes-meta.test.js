// SPDX-License-Identifier: GPL-3.0-or-later
// Notes: order and colour metadata (pure).

import {test, eq, done} from './test.js';
import * as Meta from '../../froonty@catalin/features/notes/meta.js';

const meta = (order, colors = {}) => ({version: 1, order, colors});

test('parse: tolerates garbage, drops unknown and default colours', () => {
    eq(Meta.parseMeta('not json'), Meta.emptyMeta());
    eq(Meta.parseMeta('{"order": "x"}'), Meta.emptyMeta());
    eq(Meta.parseMeta('{"order": ["a", 3, "a"], "colors": {"a": "green", "b": "neon", "c": "yellow"}}'),
        meta(['a'], {a: 'green'}));
});

test('order: creation order first, then unknown notes by name', () => {
    eq(Meta.orderedNames(['28.09.26 10.00', '01.10.26 09.00', 'zeta', 'Alpha'],
        meta(['28.09.26 10.00', 'gone', '01.10.26 09.00'])),
    ['28.09.26 10.00', '01.10.26 09.00', 'Alpha', 'zeta']);
});

test('colour: yellow by default, set, reset to default removes the entry', () => {
    let m = Meta.emptyMeta();
    eq(Meta.colorOf(m, 'a'), 'yellow');
    m = Meta.withColor(m, 'a', 'pink');
    eq(Meta.colorOf(m, 'a'), 'pink');
    m = Meta.withColor(m, 'a', 'yellow');
    eq(m.colors, {});
});

test('rename keeps position and colour; remove drops both', () => {
    let m = meta(['a', 'b', 'c'], {b: 'blue'});
    m = Meta.withRename(m, 'b', 'B');
    eq(m, meta(['a', 'B', 'c'], {B: 'blue'}));
    m = Meta.withoutNote(m, 'B');
    eq(m, meta(['a', 'c'], {}));
});

test('withNote appends once; snapshot keeps only existing notes', () => {
    eq(Meta.withNote(meta(['a', 'b']), 'a').order, ['b', 'a']);
    eq(Meta.snapshot(meta(['x', 'a'], {x: 'gray', a: 'green'}), ['a']),
        meta(['a'], {a: 'green'}));
});

await done();
