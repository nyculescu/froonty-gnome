// SPDX-License-Identifier: GPL-3.0-or-later
// Notes: Pango markup of a note's Markdown, as the island's rendered view
// and the desktop stickies show it (features/notes/markup.js).

import {done, eq, test} from './test.js';
import {inlineMarkup, lineMarkup, noteMarkup} from '../../froonty@catalin/features/notes/markup.js';

test('inline: bold, italic, strike, links, code; markers in code stay; crossed markers stay plain', () => {
    eq(inlineMarkup('**a** *b* ~~c~~ [d](https://x) `**e**`'),
        '<b>a</b> <i>b</i> <s>c</s> <u>d</u> <tt>**e**</tt>');
    eq(inlineMarkup('**a _b** c_ & <x>'), '**a _b** c_ &amp; &lt;x&gt;');
});

test('lines: headings sized by level, quotes, bullets and numbers', () => {
    eq(lineMarkup('# Big'), '<span weight="bold" size="138%">Big</span>');
    eq(lineMarkup('> said'), '<span style="italic" foreground="#888">said</span>');
    eq(lineMarkup('  - item'), '  •  item');
    eq(lineMarkup('2) two'), '2)  two');
});

test('a whole note: code blocks, tasks, one gap per run of blank lines, none at the ends', () => {
    eq(noteMarkup('\n# Plan\n\n\n- [ ] buy *milk*\n- [x] eggs\n```\nx < 1\n```\n\n'), [
        '<span weight="bold" size="138%">Plan</span>',
        '',
        '☐  buy <i>milk</i>',
        '☑  <s>eggs</s>',
        '<tt>x &lt; 1</tt>',
    ].join('\n'));
});

await done();
