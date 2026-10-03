// SPDX-License-Identifier: GPL-3.0-or-later
// Notes: labels (pure).

import {test, eq, ok, done} from './test.js';
import * as L from '../../froonty@catalin/features/notes/labels.js';

const data = labels => ({version: 1, labels, extra: {}});
const parsed = text => {
    const result = L.parseLabels(text);
    ok(result.ok, `expected ${JSON.stringify(text)} to parse: ${result.reason}`);
    return result.data;
};

test('cleanLabel: trims, strips #, collapses whitespace, NFC', () => {
    eq(L.cleanLabel('  work  '), 'work');
    eq(L.cleanLabel('#work'), 'work');
    eq(L.cleanLabel('## home  office '), 'home office');
    eq(L.cleanLabel('a \t\n b'), 'a b');
    eq(L.cleanLabel('café'), 'café'); // NFD in, NFC out
    eq(L.cleanLabel('café').length, 4);
});

test('cleanLabel: rejects empty, control characters and over 40 code points', () => {
    for (const bad of ['', '   ', '#', '##  ', 'a\u0007b', 'x\u0000', '\u007f'])
        eq(L.cleanLabel(bad), null, JSON.stringify(bad));
    eq(L.cleanLabel('x'.repeat(41)), null);
    eq(L.cleanLabel('x'.repeat(40)), 'x'.repeat(40));
    // 40 emoji are 80 UTF-16 units but 40 code points.
    eq(L.cleanLabel('😀'.repeat(40)), '😀'.repeat(40));
    eq(L.cleanLabel('😀'.repeat(41)), null);
    eq(L.cleanLabel('ideas 💡'), 'ideas 💡');
    eq(L.cleanLabel('Ță'), 'Ță');
    eq(L.cleanLabel(null), null);
});

test('identity: case-insensitive, accent-sensitive', () => {
    eq(L.labelKey('Work'), L.labelKey('work'));
    ok(L.labelKey('café') !== L.labelKey('cafe'));
    eq(L.labelKey('café'), L.labelKey('café'));
});

test('withLabel: on and off, sorted, empty lists removed', () => {
    let d = L.emptyLabels();
    d = L.withLabel(d, 'Plan', 'work', true);
    d = L.withLabel(d, 'Plan', 'Q4', true);
    d = L.withLabel(d, 'Plan', 'home', true);
    eq(L.labelsOf(d, 'Plan'), ['home', 'Q4', 'work']);
    eq(L.withLabel(d, 'Plan', 'WORK', true), d, 'already on: unchanged');
    d = L.withLabel(d, 'Plan', 'Work', false);
    eq(L.labelsOf(d, 'Plan'), ['home', 'Q4']);
    d = L.withLabel(L.withLabel(d, 'Plan', 'home', false), 'Plan', 'q4', false);
    ok(!Object.hasOwn(d.labels, 'Plan'), 'no empty list left');
    eq(L.withLabel(d, 'Plan', '  ', true), d, 'an unusable label changes nothing');
});

test('withLabel: an existing spelling, on any note, wins', () => {
    let d = L.withLabel(L.emptyLabels(), 'A', 'Work', true);
    d = L.withLabel(d, 'B', 'work', true);
    eq(L.labelsOf(d, 'B'), ['Work']);
    d = L.withLabel(d, 'B', 'café', true);
    d = L.withLabel(d, 'B', 'cafe', true);
    eq(L.labelsOf(d, 'B').length, 3, 'café and cafe are two labels');
});

test('withRename moves the entry, replaces an old one at the target, handles case-only', () => {
    let d = data({Plan: ['work'], Ideas: ['old']});
    d = L.withRename(d, 'Plan', 'Ideas');
    eq(L.labelsOf(d, 'Ideas'), ['work']);
    eq(L.labelsOf(d, 'Plan'), []);
    d = L.withRename(d, 'Ideas', 'ideas');
    eq(Object.keys(d.labels), ['ideas']);
    d = L.withRename(data({x: ['a']}), 'none', 'x');
    eq(L.labelsOf(d, 'x'), [], 'a note without labels does not inherit an old entry');
    eq(L.labelsOf(L.withoutNote(data({x: ['a'], y: ['b']}), 'x'), 'x'), []);
});

test('parseLabels: refuses what it does not understand', () => {
    for (const bad of ['{', '[]', '"x"', 'null', '{"version": 1, "labels": []}',
        '{"version": 1, "labels": "x"}', '{"version": 2, "labels": {}}', '{"labels": {}}']) {
        const result = L.parseLabels(bad);
        ok(!result.ok && result.reason, bad);
    }
    eq(L.labelsOf(parsed(''), 'x'), [], 'an empty file is empty labels');
});

test('parseLabels: drops bad entries one by one, keeps the rest', () => {
    const d = parsed(JSON.stringify({version: 1, labels: {
        a: 'work', b: ['ok', 3, '', '#', 'x'.repeat(41), 'OK', ' two  words '], c: [], d: [null],
    }}));
    eq(Object.keys(d.labels), ['b']);
    eq(L.labelsOf(d, 'b'), ['ok', 'two words']);
});

test('unknown top-level keys survive a round trip; names are not properties', () => {
    const text = '{"later": {"x": [1]}, "version": 1, "labels": {"constructor": ["a"], "__proto__": ["b"]}}';
    let d = parsed(text);
    eq(L.labelsOf(d, 'constructor'), ['a']);
    eq(L.labelsOf(d, '__proto__'), ['b']);
    eq(L.labelsOf(d, 'toString'), []);
    d = L.withLabel(d, '__proto__', 'c', true);
    const back = JSON.parse(L.serializeLabels(d));
    eq(back.later, {x: [1]});
    eq(back.version, 1);
    eq(Object.keys(back.labels).sort(), ['__proto__', 'constructor']);
    eq(back.labels.__proto__, ['b', 'c']);
    ok(L.serializeLabels(d).endsWith('}\n'), 'trailing newline');
    ok(L.serializeLabels(d).includes('\n  "version": 1'), 'two-space indent');
});

test('allLabels counts existing notes only, sorted', () => {
    const d = data({a: ['work', 'home'], b: ['work'], gone: ['old', 'work']});
    eq(L.allLabels(d, ['a', 'b']), [{label: 'home', count: 1}, {label: 'work', count: 2}]);
    eq(L.allLabels(d, []), []);
});

test('matchesLabels: none selected, all (AND), any (OR)', () => {
    eq(L.matchesLabels(['a'], [], 'all'), true);
    eq(L.matchesLabels([], [], 'any'), true);
    eq(L.matchesLabels(['a', 'b'], ['A', 'b'], 'all'), true);
    eq(L.matchesLabels(['a'], ['a', 'b'], 'all'), false);
    eq(L.matchesLabels(['a'], ['a', 'b'], 'any'), true);
    eq(L.matchesLabels(['c'], ['a', 'b'], 'any'), false);
});

await done();
