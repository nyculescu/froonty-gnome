// SPDX-License-Identifier: GPL-3.0-or-later
// Notes: pure name and Markdown-formatting logic.

import GLib from 'gi://GLib';

import {test, eq, done} from './test.js';
import * as Names from '../../froonty@catalin/features/notes/names.js';
import * as Md from '../../froonty@catalin/features/notes/markdown.js';

// ---- names

test('timestamp name has no ":" and sorts chronologically', () => {
    const dt = GLib.DateTime.new_local(2026, 9, 8, 7, 5, 0);
    eq(Names.timestampName(dt), '2026-09-08 07.05');
});

test('uniqueName appends (2), (3), ignoring case', () => {
    eq(Names.uniqueName('A', []), 'A');
    eq(Names.uniqueName('A', ['a']), 'A (2)');
    eq(Names.uniqueName('A', ['A', 'A (2)']), 'A (3)');
});

test('cleanName rejects unusable file names', () => {
    eq(Names.cleanName('  Plan  '), 'Plan');
    for (const bad of ['', '   ', '.hidden', 'a/b', 'a:b', 'a\\b', 'a?b', 'a\nb'])
        eq(Names.cleanName(bad), null, `"${bad}"`);
});

test('noteName only accepts visible .md files', () => {
    eq(Names.noteName('Plan.md'), 'Plan');
    eq(Names.noteName('Plan.MD'), 'Plan');
    eq(Names.noteName('Plan.txt'), null);
    eq(Names.noteName('.x.md'), null);
    eq(Names.noteName('.md'), null);
    eq(Names.fileName('Plan'), 'Plan.md');
});

test('compareNames is natural and case-insensitive', () => {
    eq(['Note 10', 'note 2', 'Note 1'].sort(Names.compareNames),
        ['Note 1', 'note 2', 'Note 10']);
});

// ---- markdown

const s = (text, start, end = start) => ({text, start, end});

test('wrap: empty selection inserts markers, cursor between', () => {
    eq(Md.toggleWrap(s('ab', 1), '**'), s('a****b', 3));
});

test('wrap: selection is wrapped and stays selected', () => {
    eq(Md.toggleWrap(s('say hi', 4, 6), '**'), s('say **hi**', 6, 8));
});

test('wrap: toggles off, whether markers are inside or around', () => {
    eq(Md.toggleWrap(s('say **hi**', 4, 10), '**'), s('say hi', 4, 6));
    eq(Md.toggleWrap(s('say **hi**', 6, 8), '**'), s('say hi', 4, 6));
});

test('wrap: reversed selection and emoji positions', () => {
    // "😀 ok": the emoji is one character (two UTF-16 units).
    eq(Md.toggleWrap(s('😀 ok', 4, 2), '_'), s('😀 _ok_', 3, 5));
});

test('line prefix: toggles on every touched line', () => {
    eq(Md.toggleLinePrefix(s('a\nb\nc', 0, 3), '- '), s('- a\n- b\nc', 0, 7));
    eq(Md.toggleLinePrefix(s('- a\n- b\nc', 0, 7), '- '), s('a\nb\nc', 0, 3));
});

test('line prefix: at position 0 and on the last line', () => {
    eq(Md.toggleLinePrefix(s('x\ny', 0), '# '), s('# x\ny', 0, 3));
    eq(Md.toggleLinePrefix(s('x\ny', 3), '# '), s('x\n# y', 2, 5));
});

test('line prefix: selection ending at a line start excludes that line', () => {
    eq(Md.toggleLinePrefix(s('a\nb', 0, 2), '> '), s('> a\nb', 0, 3));
});

test('numbered list: numbers lines and toggles off', () => {
    eq(Md.toggleNumbered(s('a\nb', 0, 3)), s('1. a\n2. b', 0, 9));
    eq(Md.toggleNumbered(s('1. a\n2. b', 0, 9)), s('a\nb', 0, 3));
});

test('link: wraps the selection and selects the URL', () => {
    eq(Md.insertLink(s('see docs', 4, 8)), s('see [docs](https://)', 11, 19));
    eq(Md.insertLink(s('', 0)), s('[link](https://)', 7, 15));
});

await done();
