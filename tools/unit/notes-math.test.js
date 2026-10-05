// SPDX-License-Identifier: GPL-3.0-or-later
// Formulas in notes (working-tree builds): which $…$ and $$…$$ are
// formulas (features/notes/render.js mathSpans), the Markdown around them
// (mathMarkdownSpans), and the shared state of their pictures
// (features/formulas/notes/images.js) against a stand-in helper.

import GLib from 'gi://GLib';

import {mathMarkdownSpans, mathSpans} from '../../froonty@catalin/features/notes/render.js';
import {done, eq, ok, test} from './test.js';
import {EXTENSION_DIR, sleep} from './writing-helpers.js';

const {FormulaImages} = await import(`file://${EXTENSION_DIR}/features/formulas/notes/images.js`);
const {MathRenderClient} = await import(`file://${EXTENSION_DIR}/features/formulas/renderer/client.js`);
const shared = await import(`file://${EXTENSION_DIR}/features/formulas/renderer/shared.js`);

// Formulas as "$tex$" / "$$tex$$" (+ " block") for readability.
const found = text => mathSpans(text).map(f =>
    `${f.display ? '$$' : '$'}${f.tex}${f.display ? '$$' : '$'}${f.block ? ' block' : ''}`);

test('inline formulas', () => {
    eq(found('Energy $E=mc^2$ here'), ['$E=mc^2$']);
    eq(found('$a$ and $b$'), ['$a$', '$b$']);
    eq(found('$x$'), ['$x$']);
    const [f] = mathSpans('ab $x^2$ cd');
    eq([f.start, f.end, f.open, f.close, f.firstLine, f.lastLine], [3, 8, 1, 1, 0, 0]);
});

test('money is not math', () => {
    eq(found('$5 and $10'), [], 'a closing $ before a digit');
    eq(found('costs $5 or $ 6'), []);
    eq(found('$20,000 and $30,000'), []);
    eq(found('$5 and $x^2$'), ['$x^2$'], 'the first $ fails, the next pair is a formula');
    eq(found('a lone $ sign'), []);
});

test('no space inside the dollars', () => {
    eq(found('$ x$'), []);
    eq(found('$x $'), []);
    eq(found('$x$5'), [], 'a digit right after the closing $');
    eq(found('$x$.'), ['$x$']);
});

test('escaped dollars', () => {
    eq(found('\\$x$'), [], '\\$ is a dollar sign');
    eq(found('\\$5 and $y$'), ['$y$']);
    eq(found('\\\\$x$'), ['$x$'], 'an escaped backslash, then a formula');
    eq(found('$a\\$b$'), ['$a\\$b$'], 'an escaped $ inside a formula');
});

test('inline formulas stay on one line', () => {
    eq(found('$a\nb$'), []);
});

test('display formulas, on their own line or inside one', () => {
    eq(found('$$\\int_0^1 x\\,dx$$'), ['$$\\int_0^1 x\\,dx$$ block']);
    eq(found('  $$ x $$  '), ['$$x$$ block'], 'spaces around: still alone on its line');
    eq(found('so $$x$$ inline'), ['$$x$$']);
    eq(found('$$ $$'), [], 'empty');
    eq(found('$$$$'), []);
    eq(found('$$x'), [], 'never closed');
});

test('display formulas over several lines', () => {
    const text = 'top\n$$\n\\frac{a}{b}\n+ c\n$$\nend';
    const [f] = mathSpans(text);
    eq(found(text), ['$$\\frac{a}{b}\n+ c$$ block']);
    eq([f.firstLine, f.lastLine, text.slice(f.start, f.end)], [1, 4, '$$\n\\frac{a}{b}\n+ c\n$$']);
    eq(found('$$\na\n\nb\n$$'), [], 'a blank line ends it');
    eq(found('$$\n\\text{$x$}\n$$'), ['$$\\text{$x$}$$ block'], 'a $ inside is part of it');
});

test('dollars in code are text', () => {
    eq(found('`$x$` and $y$'), ['$y$']);
    eq(found('```\n$x$\n$$\n```\n$z$'), ['$z$']);
    eq(found('$$\n```\n$$'), [], 'a fence ends a display formula');
});

// Spans as "style:text" for readability.
const shown = (text, active = -1) => {
    const {spans} = mathMarkdownSpans(text, active);
    return spans.map(s => `${s.style}:${text.slice(s.start, s.end)}`);
};

test('no Markdown inside a formula', () => {
    eq(shown('$a_1 * b_2 * c$'), []);
    eq(shown('**bold** $x**y**$'), ['hidden:**', 'bold:bold', 'hidden:**']);
    eq(shown('**around $x$**'), ['hidden:**', 'bold:around $x$', 'hidden:**']);
    eq(shown('$$\n# not a heading\n$$'), []);
});

test('the edited line shows the source, its dollars dimmed', () => {
    const text = 'a $x$\nb $$y$$\n$$\nz\n$$';
    const lines = active => mathMarkdownSpans(text, active).formulas.map(f => f.active);
    eq(lines(-1), [false, false, false], 'no focus: all drawn');
    eq(lines(0), [true, false, false]);
    eq(lines(1), [false, true, false]);
    eq(lines(3), [false, false, true], 'any line of a block');
    eq(shown(text, 0), ['marker:$', 'marker:$']);
    eq(shown(text, 4), ['marker:$$', 'marker:$$']);
});

test('offsets stay those of the note with other scripts', () => {
    const text = 'ä 😀 $α^2$ **b**';
    const {spans, formulas} = mathMarkdownSpans(text, -1);
    eq(text.slice(formulas[0].start, formulas[0].end), '$α^2$');
    eq(spans.map(s => text.slice(s.start, s.end)), ['**', 'b', '**']);
});

// ---- the pictures' state, against the stand-in helper

const FAKE = GLib.build_filenamev([
    GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), 'fakeMathHelper.js']);
const fakeClient = () => new MathRenderClient({argv: ['/usr/bin/gjs', '-m', FAKE]});

async function until(predicate, ms = 5000) {
    for (let waited = 0; waited < ms && !predicate(); waited += 20)
        // eslint-disable-next-line no-await-in-loop
        await sleep(20);
    return predicate();
}

test('pictures: pending, then ready or an error, one change call per batch', async () => {
    const client = fakeClient();
    let changes = 0;
    const images = new FormulaImages(() => changes++, {client, isFetched: async () => true, delayMs: 10});
    const x = {tex: 'x', display: false, color: '#000000', scale: 1};
    const bad = {...x, tex: 'bad'};
    eq(images.get(x), null, 'unknown before it is wanted');
    images.want([x, bad]);
    eq(images.get(x).state, 'pending');
    ok(await until(() => images.get(x).state === 'ready' && images.get(bad).state === 'error'));
    eq(images.get(bad).message, 'Missing close brace');
    ok(images.get(x).result.width >= 1);
    ok(changes >= 1 && changes <= 2, `${changes} change calls`);
    const before = changes;
    images.want([x, bad]);
    await sleep(50);
    eq(changes, before, 'nothing new: no change call, no request');
    images.destroy();
    client.destroy();
});

test('pictures: without MathJax, formulas stay plain text and no helper starts', async () => {
    const client = fakeClient();
    let changes = 0;
    const images = new FormulaImages(() => changes++, {client, isFetched: async () => false, delayMs: 10});
    const x = {tex: 'x', display: false, color: '#000000', scale: 1};
    images.want([x]);
    ok(await until(() => images.get(x).state === 'plain'));
    eq(client.starts, 0, 'no helper');
    ok(changes >= 1);
    images.destroy();
    client.destroy();
});

test('pictures: a helper that cannot start leaves the source plain', async () => {
    const client = new MathRenderClient({argv: ['/nonexistent/froonty-helper']});
    const images = new FormulaImages(() => {}, {client, isFetched: async () => true, delayMs: 10});
    const x = {tex: 'x', display: false, color: '#000000', scale: 1};
    images.want([x]);
    ok(await until(() => images.get(x).state === 'plain'));
    images.destroy();
    client.destroy();
});

test('pictures: destroy() stops what is waiting and calls nothing after', async () => {
    const client = fakeClient();
    let changes = 0;
    const images = new FormulaImages(() => changes++, {client, isFetched: async () => true, delayMs: 10});
    images.want([{tex: 'slow', display: false, color: '#000000', scale: 1}]);
    await sleep(30);
    images.destroy();
    await sleep(400);
    eq(changes, 0);
    client.destroy();
});

test('one shared renderer per process, stopped with its last user', () => {
    const a = shared.acquireRenderer();
    const b = shared.acquireRenderer();
    ok(a === b, 'the same client');
    shared.releaseRenderer();
    ok(shared.sharedRenderer() === a, 'still there for the other user');
    shared.releaseRenderer();
    eq(shared.sharedRenderer(), null);
    const c = shared.acquireRenderer();
    ok(c !== a, 'a new one after the last user left');
    shared.releaseRenderer();
});

await done();
