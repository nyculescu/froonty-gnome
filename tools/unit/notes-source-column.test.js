// SPDX-License-Identifier: GPL-3.0-or-later
// Notes: where a click on a rendered island line falls in its Markdown
// (sourceColumn.js), for the caret of a field opened there.

import {sourceColumn as at} from '../../froonty@catalin/features/notes/sourceColumn.js';
import {done, eq, test} from './test.js';

test('source column: plain text maps one to one', () => {
    eq(at('hello world', 'hello world', 0), 0);
    eq(at('hello world', 'hello world', 5), 5);
    eq(at('hello world', 'hello world', 11), 11);
});

test('source column: line markers are stepped over', () => {
    eq(at('# Shopping list', 'Shopping list', 0), 2, 'a heading starts after "# "');
    eq(at('# Shopping list', 'Shopping list', 3), 5);
    eq(at('> quoted', 'quoted', 2), 4, 'a quote');
    eq(at('- item', '•  item', 0), 2, 'a bullet: its marker');
    eq(at('- item', '•  item', 5), 4, 'drawn "•  " is "- "');
    eq(at('12. step', '12.  step', 7), 6, 'a number');
    eq(at('    code', '    code', 6), 6, 'indented code keeps its indentation');
});

test('source column: inline markers are stepped over', () => {
    eq(at('**Bold**, _italic_', 'Bold, italic', 4), 6, 'after "Bold", before the closing "**"');
    eq(at('**Bold**, _italic_', 'Bold, italic', 7), 12, 'inside "_italic_"');
    eq(at('See [the docs](https://example.org) and `code`', 'See the docs and code', 13),
        36, 'past a link\'s URL');
    eq(at('a `b` c', 'a b c', 4), 6, 'past a code span');
});

test('source column: past the end, and code points', () => {
    eq(at('ab', 'ab', 9), 2, 'a click past the end');
    eq(at('😀 **x**', '😀 x', 2), 3, 'an emoji is one drawn character, two UTF-16 units');
});

await done();
