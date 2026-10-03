// SPDX-License-Identifier: GPL-3.0-or-later
import Pango from 'gi://Pango';

import {byteOffsets, lineAt, markdownSpans} from '../../froonty@catalin/features/notes/render.js';
import {markdownAttributes} from '../../froonty@catalin/features/notes/styler.js';
import {done, eq, test} from './test.js';

// Spans as "style:text" for readability.
const shown = (text, active = -1) =>
    markdownSpans(text, active).map(s => `${s.style}:${text.slice(s.start, s.end)}`);

test('inline formatting, markers hidden off the edited line', () => {
    eq(shown('a **bold** b'), ['hidden:**', 'bold:bold', 'hidden:**']);
    eq(shown('_it_ and *it*'), ['hidden:*', 'italic:it', 'hidden:*', 'hidden:_', 'italic:it', 'hidden:_']);
    eq(shown('~~gone~~'), ['hidden:~~', 'strike:gone', 'hidden:~~']);
    eq(shown('`x**y**`'), ['hidden:`', 'code:x**y**', 'hidden:`'], 'no bold inside code');
});

test('the edited line keeps its markers, dimmed', () => {
    eq(shown('**a**\n**b**', 1), ['hidden:**', 'bold:a', 'hidden:**', 'marker:**', 'bold:b', 'marker:**']);
});

test('nested and adjacent spans', () => {
    eq(shown('**_both_**'), ['hidden:**', 'bold:_both_', 'hidden:**', 'hidden:_', 'italic:both', 'hidden:_']);
    eq(shown('**a** and **b**').filter(s => s.startsWith('bold')), ['bold:a', 'bold:b']);
});

test('not formatting: snake_case, lone markers, spaces inside', () => {
    eq(shown('snake_case_name'), []);
    eq(shown('2 * 3 * 4'), []);
    eq(shown('** not bold **'), []);
});

test('headings, lists, checklists, quotes', () => {
    eq(shown('## Title'), ['hidden:## ', 'h2:Title']);
    eq(shown('- item'), ['marker:- ']);
    eq(shown('12. item'), ['marker:12. ']);
    eq(shown('- [ ] todo'), ['marker:- [ ] ']);
    eq(shown('- [x] done'), ['marker:- [x] ', 'done:done']);
    eq(shown('> said'), ['marker:> ', 'quote:said']);
    eq(shown('- **b**'), ['marker:- ', 'hidden:**', 'bold:b', 'hidden:**']);
});

test('links: the label underlined, brackets and URL hidden', () => {
    eq(shown('see [docs](https://x.org/a) now'),
        ['hidden:[', 'link:docs', 'hidden:](https://x.org/a)']);
    eq(shown('[a](https://x.org/a_b_c)').filter(s => s.startsWith('italic')), [], 'no italics in URLs');
});

test('code blocks', () => {
    eq(shown('```\n**x**\n```\n**y**'),
        ['marker:```', 'fence:**x**', 'marker:```', 'hidden:**', 'bold:y', 'hidden:**']);
});

test('offsets: lines by code point, bytes for Pango', () => {
    eq(lineAt('ab\ncd\nef', 0), 0);
    eq(lineAt('ab\ncd\nef', 3), 1);
    eq(lineAt('😀\nx', 2), 1, 'an emoji is one position');
    eq(byteOffsets('aé€😀b'), [0, 1, 3, 6, 10, 10, 11]);
});

test('Pango attributes land on the right bytes after accented text', () => {
    const grey = {red: 128, green: 128, blue: 128};
    // "é " is 3 bytes; "**" then sits at bytes 3-5 and "b" at 5-6.
    const attributes = markdownAttributes('é **b**', -1, grey).get_attributes();
    const where = list => list.map(a => [a.start_index, a.end_index]);
    eq(where(attributes.filter(a => a.as_int()?.value === Pango.Weight.BOLD)), [[5, 6]]);
    // Hidden markers: drawn at 5%.
    eq(where(attributes.filter(a => Math.abs((a.as_float()?.value ?? 0) - 0.05) < 1e-6)),
        [[3, 5], [6, 8]]);
});

const styled = (text, active = -1) => markdownSpans(text, active)
    .filter(span => !['hidden', 'marker'].includes(span.style))
    .map(span => `${span.style}:${text.slice(span.start, span.end)}`);

test('render: emphasis runs over a line break within a paragraph, as in CommonMark', () => {
    eq(styled('**test line 1\ntest line 1**'), ['bold:test line 1\ntest line 1']);
    eq(styled('*one\ntwo*'), ['italic:one\ntwo']);
    eq(styled('**a** and **b\nc** end'), ['bold:a', 'bold:b\nc']);
    const spans = markdownSpans('**x\ny**', 1);
    eq(spans.filter(s => s.style === 'hidden').map(s => s.start), [0], 'the first line\'s marker hidden');
    eq(spans.filter(s => s.style === 'marker').map(s => s.start), [5], 'the edited line\'s marker shown');
});

test('render: no emphasis across a blank line, a heading, a list item, spaced markers or snake_case', () => {
    eq(styled('**a\n\nb**'), []);
    eq(styled('# **head\nnot**'), ['h1:**head']);
    eq(styled('**x\n- y**'), []);
    eq(styled('a ** b\nc ** d'), []);
    eq(styled('snake_case\nother_name'), []);
});

await done();
