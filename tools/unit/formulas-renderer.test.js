// SPDX-License-Identifier: GPL-3.0-or-later
// The real math renderer: MathJax in plain gjs (features/formulas/
// renderer/mathjax.js), and the helper process's protocol through the
// client (helper.js, client.js). Skipped, saying so, while MathJax is not
// fetched (`make mathjax`).

import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

import {test, eq, ok, done} from './test.js';
import {EXTENSION_DIR} from './writing-helpers.js';

const base = `file://${EXTENSION_DIR}/features/formulas`;
const {isMathJaxFetched, MathRenderClient} = await import(`${base}/renderer/client.js`);

if (!await isMathJaxFetched()) {
    print('SKIP formulas-renderer: MathJax is not fetched; run `make mathjax` to test the renderer');
    imports.system.exit(0);
}

const {geometry, MathRenderer} = await import(`${base}/renderer/mathjax.js`);
const {SECTIONS} = await import(`${base}/symbols.js`);
const {TEMPLATES} = await import(`${base}/templates.js`);
const {GUIDE} = await import(`${base}/guide.js`);
const {SLOT} = await import(`${base}/edit.js`);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

function pixbuf(bytes) {
    const loader = new GdkPixbuf.PixbufLoader();
    loader.write_bytes(bytes);
    loader.close();
    return loader.get_pixbuf();
}

async function failure(promise) {
    try {
        await promise;
    } catch (e) {
        return e;
    }
    throw new Error('expected a failure');
}

const renderer = await MathRenderer.load();

test('geometry: the viewBox drawn at 1em = 16 px, padded, whole pixels', () => {
    // 1em wide, from 0.75em above the baseline to 0.25em below.
    const g = geometry([0, -750, 1000, 1000], 16);
    eq([g.width, g.height], [Math.ceil(16 * 1.16), Math.ceil(16 * 1.16)]);
    ok(Math.abs(g.baseline - (0.08 + 0.75) * 16) < 1e-9, `baseline ${g.baseline}`);
    eq(g.viewBox[2] / g.width, 1000 / 16, 'the padded viewBox keeps the scale');
});

test('MathJax renders a PNG with its size and baseline', async () => {
    const result = await renderer.render({tex: 'x^2 + y^2 = z^2', color: '#ff0000', scale: 2});
    eq([...result.png.slice(0, 4)], PNG_SIGNATURE);
    const image = pixbuf(new GLib.Bytes(result.png));
    eq([image.get_width(), image.get_height()], [result.width, result.height]);
    ok(result.baseline > 0 && result.baseline < result.height, `baseline ${result.baseline}`);
    const display = await renderer.render({tex: '\\sum_{i=1}^n i', display: true});
    const inline = await renderer.render({tex: '\\sum_{i=1}^n i', display: false});
    ok(display.height > inline.height, 'display style is taller (bounds above and below)');
});

test('an inline formula is one picture, all of it (no inline line breaks)', async () => {
    const whole = await renderer.render({tex: 'E=mc^2'});
    const first = await renderer.render({tex: 'E'});
    const display = await renderer.render({tex: 'E=mc^2', display: true});
    ok(whole.width > 3 * first.width, `${whole.width} px wide, E alone ${first.width}`);
    ok(Math.abs(whole.width - display.width) <= 2, `inline ${whole.width}, display ${display.width}`);
});

test('a formula MathJax refuses gives its own message', async () => {
    eq((await failure(renderer.render({tex: '\\frac{1}{'}))).message, 'Missing close brace');
    eq((await failure(renderer.render({tex: '\\nosuchcommand'}))).message,
        'Undefined control sequence \\nosuchcommand');
    ok((await failure(renderer.render({tex: 'x', color: 'red; x'}))).message.startsWith('Not a colour'));
    ok(await failure(renderer.render({tex: '   '})));
});

test('\\ce draws its arrows from the mhchem font extension', async () => {
    const svg = await renderer.svg('\\ce{A -> B}');
    // The extension's glyphs carry its cache id, MHC; without it the
    // arrow is an empty box.
    ok(svg.includes('MHC'), 'an mhchem glyph is in the picture');
});

test('characters the font loads on first use (double-struck) render', async () => {
    const svg = await renderer.svg('\\mathbb{R} \\mathbb{C} \\mathfrak{g} \\mathscr{L}');
    ok(svg.includes('<path'), 'drawn');
});

test('every palette symbol, template and guide example renders', async () => {
    const failures = [];
    const all = [
        ...SECTIONS.flatMap(s => s.symbols.map(sym => sym.insert)),
        ...TEMPLATES.map(t => t.insert),
        ...GUIDE.map(g => g.example),
    ];
    for (const snippet of all) {
        // Slots get a letter, as if filled in.
        const tex = snippet.replaceAll(SLOT, 'x');
        try {
            // eslint-disable-next-line no-await-in-loop
            await renderer.render({tex, display: true});
        } catch (e) {
            failures.push(`${tex}: ${e.message}`);
        }
    }
    eq(failures, [], `${all.length} snippets`);
});

test('the helper answers over its pipe, through the client', async () => {
    const client = new MathRenderClient();
    const result = await client.render({tex: '\\alpha', color: '#ffffff', scale: 1});
    eq([...result.png.toArray().slice(0, 4)], PNG_SIGNATURE);
    ok(result.width > 0 && result.height > 0);
    const e = await failure(client.render({tex: '\\frac{'}));
    eq([e.kind, e.message], ['tex', 'Missing close brace']);
    eq(client.starts, 1);
    ok(client.running);
    client.destroy();
    eq(client.running, false);
});

test('the helper says when MathJax is missing', async () => {
    const client = new MathRenderClient({env: {FROONTY_MATHJAX_DIR: '/nonexistent'}});
    const e = await failure(client.render({tex: 'x'}));
    eq(e.kind, 'unavailable');
    client.destroy();
});

test('rendering is fast once loaded', async () => {
    const start = GLib.get_monotonic_time();
    for (let i = 0; i < 20; i++)
        // eslint-disable-next-line no-await-in-loop
        await renderer.render({tex: `\\frac{${i}}{x_${i}} + \\sqrt{${i}}`});
    const ms = (GLib.get_monotonic_time() - start) / 1000 / 20;
    // Generous: the machine may be busy.
    ok(ms < 200, `${ms.toFixed(1)} ms a formula`);
});

await done();
