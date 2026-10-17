// SPDX-License-Identifier: GPL-3.0-or-later
// Notes: the part of a note a click edits in place in the rendered views
// (editUnits.js), the note offset under a click there, and the code under
// a right-click (Copy code).

import {markdownBlocks, markdownPreview} from '../../froonty@catalin/features/notes/blocks.js';
import {codeAt, editUnitAt, sourceOffset} from '../../froonty@catalin/features/notes/editUnits.js';
import {done, eq, test} from './test.js';

const unitText = (text, offset) => {
    const unit = editUnitAt(text, offset, markdownBlocks(text));
    return unit && text.slice(unit.start, unit.end);
};

test('edit units: a paragraph, a heading, a list item, a task\'s text, a fence', () => {
    const text = '# Title\none\ntwo\n\n- item\n- [ ] milk\n> quote\n```\ncode\n```\nlast';
    eq(unitText(text, 2), '# Title', 'a heading, whole');
    eq(unitText(text, 9), 'one\ntwo', 'a paragraph: its lines');
    eq(unitText(text, 13), 'one\ntwo');
    eq(unitText(text, 16), null, 'a blank line: nothing');
    eq(unitText(text, 19), '- item', 'a list item, whole');
    eq(unitText(text, 30), 'milk', 'a task: its text after the box');
    eq(unitText(text, 25), 'milk', 'a click on the box\'s place too');
    eq(unitText(text, 37), '> quote');
    eq(unitText(text, 47), '```\ncode\n```', 'a code fence, whole');
    eq(unitText(text, text.length), 'last', 'the end of the note');
    eq(unitText('- [ ] ', 3), null, 'a task without text');
    eq(unitText('a\n---\nb', 0), 'a', 'a rule ends a paragraph');
});

test('edit units: never a drawn block, nor a line beside one', () => {
    const text = 'before\n| a | b |\n| --- | --- |\n| 1 | 2 |\nafter\n\nsee ![x](x.png) here\n' +
        '```mermaid\ngraph TD\nA-->B\n```\nend';
    eq(unitText(text, 2), 'before', 'stops at the table');
    eq(unitText(text, 10), null, 'the table');
    eq(unitText(text, 42), 'after');
    eq(unitText(text, 50), null, 'a line with an image');
    eq(unitText(text, 75), null, 'a diagram');
    eq(unitText(text, text.length - 1), 'end');
});

test('edit units: a click in the rendered copy maps back to the note', () => {
    const text = '😀 a\n| a | b |\n| --- | --- |\n| 1 | 2 |\nafter\nx ![i](i.png) y';
    const preview = markdownPreview(text, markdownBlocks(text));
    const at = (needle, plus = 0) => preview.text.indexOf(needle) + plus;
    eq(sourceOffset(text, preview, at('a')), text.indexOf('a'));
    eq(sourceOffset(text, preview, at('after', 2)), text.indexOf('after') + 2, 'after a block');
    eq(sourceOffset(text, preview, at('￼')), null, 'on a block');
    eq(sourceOffset(text, preview, at('x')), null, 'a line split around an image');
});

test('code at: a fence\'s code without its fence lines, an inline span\'s text', () => {
    // "say `x = 1` now\n" 0-15, "```js\n" 16-21, "a\n" 22-23, "b\n" 24-25,
    // "```\n" 26-29, "end `y`" 30-36.
    const text = 'say `x = 1` now\n```js\na\nb\n```\nend `y`';
    eq(codeAt(text, 22), 'a\nb', 'in the fence: its lines');
    eq(codeAt(text, 17), 'a\nb', 'on the opening fence, its info string left out');
    eq(codeAt(text, 27), 'a\nb', 'on the closing fence');
    eq(codeAt(text, 4), 'x = 1', 'on the opening backtick');
    eq(codeAt(text, 7), 'x = 1', 'in the span');
    eq(codeAt(text, 10), 'x = 1', 'on the closing backtick');
    eq(codeAt(text, 11), null, 'just after the span');
    eq(codeAt(text, 2), null, 'plain text');
    eq(codeAt(text, 35), 'y');
    eq(codeAt(text, text.length + 1), null, 'past the end');
    eq(codeAt('```\n```', 0), '', 'an empty fence');
    eq(codeAt('~~~\nx\n~~~', 5), 'x', 'tildes');
    eq(codeAt('```\nopen\nstill', 10), 'open\nstill', 'an unclosed fence runs to the end');
    eq(codeAt('```\n`a` b\n```', 5), '`a` b', 'no span inside a fence');
    eq(codeAt('😀 `ü`', 4), 'ü', 'UTF-16 offsets');
});

await done();
