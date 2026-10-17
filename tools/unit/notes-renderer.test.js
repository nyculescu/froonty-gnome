// SPDX-License-Identifier: GPL-3.0-or-later
// Notes' block renderer without WebKit: the offline diagram subset
// (renderer/diagram.js), tables as HTML (renderer/tableHtml.js), the
// picture cache's entries (renderer/blocks.js, with a stand-in for the
// helper) and image files (renderer/imageFile.js, image-picker.js).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {markdownBlocks} from '../../froonty@catalin/features/notes/blocks.js';
import {MarkdownBlockPictures} from '../../froonty@catalin/features/notes/renderer/blocks.js';
import {diagramSvg, limitWarnings} from '../../froonty@catalin/features/notes/renderer/diagram.js';
import {copiedFilesText, imageExtension, imageFile, imagePath, markdownImagePath, pastedImageName}
    from '../../froonty@catalin/features/notes/renderer/imageFile.js';
import {saveImageBytes} from '../../froonty@catalin/features/notes/renderer/image-picker.js';
import {tableHtml} from '../../froonty@catalin/features/notes/renderer/tableHtml.js';
import {done, eq, ok, sleep, test} from './test.js';

const throws = (fn, pattern, message) => {
    try {
        fn();
    } catch (e) {
        ok(pattern.test(e.message), `${message}: ${e.message}`);
        return;
    }
    throw new Error(`${message}: did not throw`);
};

test('diagram: a good flowchart draws every node, with no warnings', () => {
    const {svg, warnings} = diagramSvg('graph TD\nA[Start] --> B{Ok?}\nB -->|yes| C\nB --> D;\n%% comment', 380);
    eq(warnings, []);
    for (const label of ['Start', 'Ok?', 'yes', '>C<', '>D<'])
        ok(svg.includes(label), label);
});

test('diagram: what it cannot read is left out and named, the rest drawn', () => {
    const {svg, warnings} = diagramSvg([
        'flowchart LR',
        'A --> B',
        'classDef big fill:#f9f',
        'B --> C D --> E',
        'subgraph one',
        'E ---> F',
        'end',
        'A -- text --> G',
    ].join('\n'), 380);
    eq(warnings, [
        'Line 3 not drawn: classDef big fill:#f9f',
        'Line 4: arrow not drawn, "C D" not understood',
        'Line 5 not drawn: subgraph one',
        'Line 7 not drawn: end',
        'Line 8: arrow not drawn, "A -- text" not understood',
    ]);
    for (const label of ['>A<', '>B<', '>E<', '>F<', '>G<'])
        ok(svg.includes(label), label);
    ok(!svg.includes('>C D<') && !svg.includes('>end<') && !svg.includes('classDef'));
});

test('diagram: sequence and state diagrams name the lines they skip', () => {
    const sequence = diagramSvg('sequenceDiagram\nparticipant A as Alice\nA->>B: hi\nNote over A: x\nB-)A: back', 400);
    eq(sequence.warnings, ['Line 4 not drawn: Note over A: x']);
    ok(sequence.svg.includes('Alice') && sequence.svg.includes('back'));
    const state = diagramSvg('stateDiagram-v2\n[*] --> Idle\nIdle --> Busy : go\nIdle : waiting\nstate Busy {\n}', 380);
    eq(state.warnings, ['Line 4 not drawn: Idle : waiting', 'Line 5 not drawn: state Busy {', 'Line 6 not drawn: }']);
    ok(state.svg.includes('>go<'));
});

test('diagram: one that cannot be drawn at all says why', () => {
    throws(() => diagramSvg('pie title Pets\n"Dogs" : 3', 380), /^pie diagrams cannot be drawn offline/, 'type');
    throws(() => diagramSvg('  \n%% only a comment', 380), /The diagram is empty/, 'empty');
    throws(() => diagramSvg('graph TD\nA B', 380),
        /^Nothing in this diagram could be drawn \(Line 2 not drawn: A B\)$/, 'nothing readable');
    throws(() => diagramSvg('sequenceDiagram\nloop every minute', 380), /Nothing in this diagram/, 'sequence');
});

test('warnings: a few, then how many more', () => {
    const many = Array.from({length: 12}, (_, i) => `w${i}`);
    eq(limitWarnings(many), ['w0', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', '5 more problems not listed']);
    eq(limitWarnings(['a']), ['a']);
});

test('table html: cell images found, missing or not local; extra cells named', () => {
    const image = path => path === 'ok.png' ? {uri: 'file:///n/ok.png'}
        : path.startsWith('/') ? {problem: `Image ${path}: use a path relative to this note`}
            : {problem: `Image not found: ${path}`};
    const {html, warnings} = tableHtml(
        '| a | b |\n| :-: | --- |\n| ![x](ok.png) | ![gone](gone.png) |\n| ![](/abs.png) | **b** \\| c | extra |', image);
    eq(warnings, [
        'Row 2 has 3 cells, the header 2: the extra ones are not shown',
        'Image not found: gone.png',
        'Image /abs.png: use a path relative to this note',
    ]);
    ok(html.includes('<img src="file:///n/ok.png" alt="x" data-path="ok.png">'), html);
    ok(html.includes('>gone<') && html.includes('>/abs.png<'), 'alt text, else the path');
    ok(html.includes('<strong>b</strong> | c') && !html.includes('extra'), html);
    ok(html.includes('text-align:center'));
    throws(() => tableHtml('| a | b |\n| --- |', image), /separator row has 1 cells; the header has 2/, 'bad table');
});

// The helper, without WebKit: tables and diagrams through the same pure
// modules, images by name.
class FakeClient {
    constructor() {
        this.requests = [];
    }

    render(request) {
        this.requests.push(request);
        try {
            if (request.kind === 'table') {
                const {warnings} = tableHtml(request.source, path => ({problem: `Image not found: ${path}`}));
                return Promise.resolve({png: new Uint8Array(10), width: 200, height: 60, warnings});
            }
            if (request.kind === 'mermaid') {
                const {warnings} = diagramSvg(request.source, request.width);
                return Promise.resolve({png: new Uint8Array(10), width: 380, height: 300, warnings});
            }
            if (request.uri.endsWith('/big.png'))
                return Promise.resolve({png: new Uint8Array(request.size ?? 20), width: 3000, height: 1500, warnings: []});
            return Promise.reject(new Error(`Image not found: ${Gio.File.new_for_uri(request.uri).get_basename()}`));
        } catch (e) {
            return Promise.reject(e);
        }
    }

    destroy() {}
}

test('pictures: a failed block fails alone; the good ones are unaffected', async () => {
    const note = [
        '| a | b |', '| --- | --- |', '| 1 | 2 |', '',
        '```mermaid', 'pie title Pets', '```', '',
        '```mermaid', 'graph TD', 'A --> B', 'style A fill:#f00', '```', '',
        '![big](big.png)', '![lost](lost%20one.png)', '![web](https://x.org/a.png)',
    ].join('\n');
    const folder = Gio.File.new_for_path('/notes');
    let changes = 0;
    const client = new FakeClient();
    const pictures = new MarkdownBlockPictures(() => changes++, client);
    const pending = pictures.want(markdownBlocks(note), 620, folder);
    eq(pending.map(p => [p.kind, p.state]), [['table', 'pending'], ['mermaid', 'pending'], ['mermaid', 'pending'],
        ['image', 'pending'], ['image', 'pending'], ['image', 'error']]);
    eq(pending[5].error, 'Use an image file path relative to this note');
    await sleep(0);
    const entries = pictures.want(markdownBlocks(note), 620, folder);
    eq(entries.map(p => [p.kind, p.state, p.warnings, p.error]), [
        ['table', 'ready', [], null],
        ['mermaid', 'error', [], 'pie diagrams cannot be drawn offline; use flowchart, graph, stateDiagram or sequenceDiagram'],
        ['mermaid', 'ready', ['Line 3 not drawn: style A fill:#f00'], null],
        ['image', 'ready', [], null],
        ['image', 'error', [], 'Image not found: lost one.png'],
        ['image', 'error', [], 'Use an image file path relative to this note'],
    ]);
    eq(changes, 5);
    // The image keeps its pixels; it is shown within 360 × 320 by default.
    const image = entries[3];
    eq([image.pixelWidth, image.pixelHeight, image.width, image.height], [3000, 1500, 360, 180]);
    eq(pictures.want(markdownBlocks('![big](big.png)'), 200, folder).map(p => [p.state, p.width, p.height]),
        [['ready', 200, 100]], 'a narrow view, the same picture');
    eq(client.requests.filter(r => r.kind === 'image').map(r => r.uri),
        ['file:///notes/big.png', 'file:///notes/lost%20one.png'], 'the path decoded; asked once per image');
    const table = entries[0];
    eq([table.width, table.height, table.pixelWidth, table.pixelHeight], [200, 60, 200, 60]);
    pictures.destroy();
});

test('pictures: large unshown images go first; shown ones stay', async () => {
    const client = new FakeClient();
    const size = 30 * 1024 * 1024;
    const render = client.render.bind(client);
    client.render = request => render({...request, size});
    const pictures = new MarkdownBlockPictures(() => {}, client);
    const folder = Gio.File.new_for_path('/notes');
    const one = markdownBlocks('![a](big.png)');
    const two = markdownBlocks('![b](sub/big.png)');
    pictures.want(one, 600, folder);
    await sleep(0);
    pictures.want(two, 600, folder);
    await sleep(0);
    eq(pictures.want(two, 600, folder)[0].state, 'ready');
    eq(pictures.want(one, 600, folder)[0].state, 'pending', 'evicted over the byte budget, asked again');
    eq(client.requests.length, 3);
    pictures.destroy();
});

test('image files: note-relative paths, decoded; Markdown paths escaped', () => {
    eq(imagePath('a%20b.png'), 'a b.png');
    eq(imagePath('sub/c.png'), 'sub/c.png');
    eq(imagePath('100%.png'), '100%.png', 'a lone % is part of the name');
    eq([imagePath('/abs.png'), imagePath('file:///a.png'), imagePath('https://x/a.png'), imagePath('')],
        [null, null, null, null]);
    const name = 'pasted 2026-10-16 14.05 (2).png';
    eq(markdownImagePath(name), 'pasted%202026-10-16%2014.05%20%282%29.png');
    eq(imagePath(markdownImagePath(name)), name, 'round trip');
    eq(markdownBlocks(`![x](${markdownImagePath(name)})`).length, 1, 'a block blocks.js finds');
    eq(markdownImagePath('é[1].png'), 'é%5B1%5D.png');
    const folder = Gio.File.new_for_path('/notes');
    eq(imageFile({source: 'a%20b.png'}, folder).get_path(), '/notes/a b.png');
    eq(imageFile({source: '/etc/x.png'}, folder), null);
    eq(imageFile({source: 'a.png'}, null), null);
    eq(copiedFilesText('file:///notes/a%20b.png'), {
        'x-special/gnome-copied-files': 'copy\nfile:///notes/a%20b.png',
        'text/uri-list': 'file:///notes/a%20b.png\r\n',
    });
});

test('pasted images: named by date and type, numbered when taken', async () => {
    const date = new Date(2026, 9, 16, 14, 5);
    eq(pastedImageName(date, 'image/png'), 'pasted-2026-10-16-1405.png');
    eq(pastedImageName(date, 'image/JPEG', 3), 'pasted-2026-10-16-1405-3.jpg');
    eq(['image/gif', 'image/webp', 'image/bmp', 'text/plain'].map(imageExtension), ['gif', 'webp', null, null]);
    throws(() => pastedImageName(date, 'image/bmp'), /image\/bmp/, 'unsupported type');

    const folder = Gio.File.new_for_path(GLib.dir_make_tmp('froonty-paste-XXXXXX'));
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const first = await saveImageBytes(bytes, 'image/png', folder);
    const second = await saveImageBytes(new GLib.Bytes(bytes), 'image/png', folder);
    ok(/^pasted-\d{4}-\d\d-\d\d-\d{4}\.png$/.test(first), first);
    ok(second === first.replace('.png', '-2.png') ||
        /^pasted-\d{4}-\d\d-\d\d-\d{4}\.png$/.test(second), `${second} (a new minute, or numbered)`);
    eq([...folder.get_child(second).load_contents(null)[1]], [...bytes]);
    for (const name of [first, second])
        folder.get_child(name).delete(null);
    folder.delete(null);
});

await done();
