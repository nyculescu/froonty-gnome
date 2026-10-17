// SPDX-License-Identifier: GPL-3.0-or-later
import {byteOffsets, lineAt, markdownSpans, markdownTasks, toggleTask} from '../../froonty@catalin/features/notes/render.js';
import {done, eq, test} from './test.js';

// Spans as "style:text" for readability.
const shown = text => markdownSpans(text).map(s => `${s.style}:${text.slice(s.start, s.end)}`);

test('inline formatting stays rendered, with markers hidden', () => {
    eq(shown('a **bold** b'), ['hidden:**', 'bold:bold', 'hidden:**']);
    eq(shown('_it_ and *it*'), ['hidden:*', 'italic:it', 'hidden:*', 'hidden:_', 'italic:it', 'hidden:_']);
    eq(shown('~~gone~~'), ['hidden:~~', 'strike:gone', 'hidden:~~']);
    eq(shown('`x**y**`'), ['hidden:`', 'code:x**y**', 'hidden:`'], 'no bold inside code');
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
    eq(shown('- [ ] todo'), ['hidden:- ', 'taskbox:[ ]']);
    eq(shown('- [x] done'), ['hidden:- ', 'taskbox:[x]', 'done:done']);
    eq(shown('> said'), ['marker:> ', 'quote:said']);
    eq(shown('- **b**'), ['marker:- ', 'hidden:**', 'bold:b', 'hidden:**']);
});

test('tasks: -, * and + are checkboxes; the marker hidden, done text struck through', () => {
    for (const marker of ['-', '*', '+']) {
        eq(shown(`${marker} [ ] todo`), [`hidden:${marker} `, 'taskbox:[ ]'], marker);
        eq(shown(`  ${marker} [x] done`), [`hidden:${marker} `, 'taskbox:[x]', 'done:done'], marker);
    }
    eq(shown('*  [X] **b**'), ['hidden:*  ', 'taskbox:[X]', 'done:**b**', 'hidden:**', 'bold:b', 'hidden:**'],
        'more spaces after the marker, as toggleTask() reads it');
    eq(shown('* [ ]no space'), ['marker:* '], 'no space after the box: a bullet');
    eq(shown('1. [ ] numbered'), ['marker:1. '], 'numbered items are not tasks');
});

test('tasks: markdownTasks finds every marker, not in code; toggleTask agrees', () => {
    const text = '- [ ] a\n* [x] b\n```\n+ [ ] code\n```\n  + [ ] c\n- not';
    const tasks = markdownTasks(text);
    eq(tasks.map(t => [text.slice(t.start, t.end), t.checked]), [['[ ]', false], ['[x]', true], ['[ ]', false]]);
    eq(tasks.map(t => t.start), [2, 10, 39]);
    // Each box the views draw toggles (toggleTask counts code points; ASCII here).
    for (const task of tasks)
        eq(toggleTask(text, task.start + 1) !== null, true);
    eq(toggleTask('* [ ] x', 3), '* [x] x');
    eq(toggleTask('+ [x] x', 3), '+ [ ] x');
    eq(markdownTasks('😀\n* [ ] x')[0].start, 5, 'UTF-16 offsets');
});

test('links: the label underlined, brackets and URL hidden', () => {
    eq(shown('see [docs](https://x.org/a) now'),
        ['hidden:[', 'link:docs', 'hidden:](https://x.org/a)']);
    eq(shown('[a](https://x.org/a_b_c)').filter(s => s.startsWith('italic')), [], 'no italics in URLs');
});

test('code blocks', () => {
    eq(shown('```\n**x**\n```\n**y**'),
        ['hidden:```', 'fence:**x**', 'hidden:```', 'hidden:**', 'bold:y', 'hidden:**']);
});

test('offsets: lines by code point, bytes for Pango', () => {
    eq(lineAt('ab\ncd\nef', 0), 0);
    eq(lineAt('ab\ncd\nef', 3), 1);
    eq(lineAt('😀\nx', 2), 1, 'an emoji is one position');
    eq(byteOffsets('aé€😀b'), [0, 1, 3, 6, 10, 10, 11]);
});

const styled = text => markdownSpans(text)
    .filter(span => !['hidden', 'marker'].includes(span.style))
    .map(span => `${span.style}:${text.slice(span.start, span.end)}`);

test('render: emphasis runs over a line break within a paragraph, as in CommonMark', () => {
    eq(styled('**test line 1\ntest line 1**'), ['bold:test line 1\ntest line 1']);
    eq(styled('*one\ntwo*'), ['italic:one\ntwo']);
    eq(styled('**a** and **b\nc** end'), ['bold:a', 'bold:b\nc']);
    const spans = markdownSpans('**x\ny**');
    eq(spans.filter(s => s.style === 'hidden').map(s => s.start), [0, 5], 'both lines\' markers hidden');
});

test('render: no emphasis across a blank line, a heading, a list item, spaced markers or snake_case', () => {
    eq(styled('**a\n\nb**'), []);
    eq(styled('# **head\nnot**'), ['h1:**head']);
    eq(styled('**x\n- y**'), []);
    eq(styled('a ** b\nc ** d'), []);
    eq(styled('snake_case\nother_name'), []);
});

await done();
