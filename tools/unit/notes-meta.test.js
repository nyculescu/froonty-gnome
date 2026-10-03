// SPDX-License-Identifier: GPL-3.0-or-later
// Notes: order and colour metadata (pure).

import {test, eq, done} from './test.js';
import * as Meta from '../../froonty@catalin/features/notes/meta.js';

const meta = (order, colors = {}, extra = {}) => ({version: 1, order, colors, extra});

test('parse: odd entries are dropped; a file that is not understood is reported', () => {
    eq(Meta.parseMeta('{"order": "x"}'), {ok: true, meta: Meta.emptyMeta()});
    eq(Meta.parseMeta('{"order": ["a", 3, "a"], "colors": {"a": "green", "b": "neon", "c": "yellow"}}'),
        {ok: true, meta: meta(['a'], {a: 'green'})});
    eq(Meta.parseMeta(''), {ok: true, meta: Meta.emptyMeta()}, 'empty: nothing, and writable');
    for (const text of ['not json', '{"version": 1, "order": ["B", "A"], "colors": {"A": "green"',
        '{"version": 1, "order": ["B", "A"],}', '[1, 2]', 'null', '{"version": 2, "order": []}'])
        eq(Meta.parseMeta(text).ok, false, text);
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

test('unknown top-level keys survive parse, snapshot and serialize', () => {
    const text = JSON.stringify({future: {a: [1, 2]}, version: 1, order: ['a', 'b'],
        colors: {a: 'green'}, note: 'kept', __proto__x: 1});
    const {meta: m} = Meta.parseMeta(text);
    eq(m.extra, {future: {a: [1, 2]}, note: 'kept', __proto__x: 1});
    const written = JSON.parse(Meta.serializeMeta(Meta.snapshot(Meta.withColor(m, 'b', 'pink'), ['a', 'b'])));
    eq(written, {future: {a: [1, 2]}, note: 'kept', __proto__x: 1, version: 1, order: ['a', 'b'],
        colors: {a: 'green', b: 'pink'}});
    // A key named __proto__ stays a plain key, not a prototype.
    const {meta: odd} = Meta.parseMeta('{"version": 1, "order": [], "colors": {}, "__proto__": {"x": 1}}');
    eq(JSON.parse(Meta.serializeMeta(odd)).__proto__, {x: 1});
    eq(Meta.colorOf(Meta.emptyMeta(), 'constructor'), 'yellow', 'names are not object properties');
});

await done();
