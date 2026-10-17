// SPDX-License-Identifier: GPL-3.0-or-later
// Notes' rendered blocks: which Markdown is drawn as a picture (blocks.js),
// the display copy that holds one placeholder per block, and the block
// sizes kept beside the notes (renderSizes.js), in a temporary folder.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {markdownBlocks, markdownPreview} from '../../froonty@catalin/features/notes/blocks.js';
import {fitRenderSize, keyedMarkdownBlocks, moveRenderSizes, RenderSizes, resizeWithAspect}
    from '../../froonty@catalin/features/notes/renderSizes.js';
import {done, eq, ok, test} from './test.js';

const OBJECT = '￼';

test('blocks: tables, local images and Mermaid; not in code or quotes', () => {
    const text = 'intro\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n![cat](cat.png)\n' +
        '```mermaid\ngraph TD\nA-->B\n```\n`![no](x.png)`\n> ![quoted](q.png)';
    eq(markdownBlocks(text).map(b => [b.kind, b.start, b.end, b.source]), [
        ['table', 6, 39, '| a | b |\n| --- | --- |\n| 1 | 2 |'],
        ['image', 41, 56, 'cat.png'],
        ['mermaid', 57, 86, 'graph TD\nA-->B'],
    ]);
    eq(markdownBlocks('![cat](cat.png)')[0].alt, 'cat');
    eq(markdownBlocks('```\nflowchart LR\nA-->B\n```').map(b => b.kind), ['mermaid'], 'a diagram without a language');
    eq(markdownBlocks('```mermaid\ngraph TD\n![x](x.png)'), [], 'an unclosed fence: nothing, its image either');
    eq(markdownBlocks('a | b\nno rule'), []);
});

test('preview: one placeholder per block, offsets mapped around it', () => {
    const text = 'a\n![x](x.png)\nb';
    const preview = markdownPreview(text, markdownBlocks(text));
    eq(preview.text, `a\n${OBJECT}\nb`);
    eq(preview.blocks.map(b => [b.kind, b.previewStart]), [['image', 2]]);
    eq([preview.mapOffset(0), preview.mapOffset(14), preview.mapOffset(5)], [0, 4, null],
        'inside the block: no place in the copy');
    // An image within a line gets a line of its own.
    const inline = 'see ![x](x.png) now';
    eq(markdownPreview(inline, markdownBlocks(inline)).text, `see \n${OBJECT}\n now`);
    eq(markdownPreview('plain', []).text, 'plain');
});

test('sizes: keys by kind, source and occurrence', () => {
    const keys = keyedMarkdownBlocks(markdownBlocks('![x](x.png) ![x](x.png) ![y](x.png)'))
        .map(b => b.itemKey);
    // The alt text is not part of it: three times the same image.
    eq(keys, [0, 1, 2].map(n => JSON.stringify([JSON.stringify(['image', 'x.png']), n])));
});

test('sizes: a drag keeps the aspect, within 1600 px; a saved size fits its block', () => {
    eq(resizeWithAspect({width: 200, height: 100}, 20, 10), {width: 220, height: 110});
    eq(resizeWithAspect({width: 1000, height: 1000}, 2000, 2000), {width: 1600, height: 1600});
    eq(fitRenderSize({width: 300, height: 300}, {width: 200, height: 100}), {width: 300, height: 150});
    eq(fitRenderSize(null, {width: 200, height: 100}), null);
});

const readSizes = folder => JSON.parse(new TextDecoder().decode(
    folder.get_child('.froonty-render-sizes.json').load_contents(null)[1])).notes;

test('sizes: saved per note, moved on a rename, dropped for a new note of the name', async () => {
    const folder = Gio.File.new_for_path(GLib.dir_make_tmp('froonty-sizes-XXXXXX'));
    const sizes = new RenderSizes(() => {});
    sizes.select(folder, 'A');
    sizes.set('k', {width: 200.4, height: 100});
    eq(sizes.get('k'), {width: 200, height: 100});
    // Writes run one after the other: the move comes after the save.
    await moveRenderSizes(folder, 'Nothing', 'Other');
    eq(readSizes(folder), {A: {k: {width: 200, height: 100}}});
    await moveRenderSizes(folder, 'A', 'B');
    eq(readSizes(folder), {B: {k: {width: 200, height: 100}}});

    let loads = 0;
    const other = new RenderSizes(() => loads++);
    other.select(folder, 'B');
    for (let i = 0; i < 100 && loads === 0; i++)
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => resolve()));
    eq(loads, 1, 'B loaded');
    eq(other.get('k'), {width: 200, height: 100});

    await moveRenderSizes(folder, 'Gone', 'B');
    eq(readSizes(folder), {}, 'a new note B starts without the old sizes');
    ok(sizes.get('nothing') === null);
});

await done();
