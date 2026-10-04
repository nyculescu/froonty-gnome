// SPDX-License-Identifier: GPL-3.0-or-later
// The Formulas tab's pure modules: symbol palettes and their search,
// templates, the guide, and the editing helpers (insertion at the cursor,
// copy formats, recent and starred lists).

import {test, eq, ok, done} from './test.js';
import {EXTENSION_DIR} from './writing-helpers.js';

const base = `file://${EXTENSION_DIR}/features/formulas`;
const {SECTIONS, searchSymbols} = await import(`${base}/symbols.js`);
const {TEMPLATES, templateById} = await import(`${base}/templates.js`);
const {GUIDE} = await import(`${base}/guide.js`);
const {SLOT, copyText, errorText, insertSnippet, isFavourite, pushRecent, toggleFavourite,
    RECENT_LIMIT, FAVOURITES_LIMIT} = await import(`${base}/edit.js`);

const at = (text, start, end = start) => ({text, start, end});

test('every palette has its sections, each symbol a glyph and LaTeX', () => {
    const ids = SECTIONS.map(s => s.id);
    eq(new Set(ids).size, ids.length, 'section ids are unique');
    for (const id of ['greek-lower', 'greek-upper', 'greek-variants', 'operators', 'relations',
        'arrows', 'sets-logic', 'accents', 'brackets', 'sets-fonts', 'functions', 'physics',
        'statistics', 'chemistry'])
        ok(ids.includes(id), `section ${id}`);
    for (const section of SECTIONS) {
        ok(section.title && section.symbols.length > 0, section.id);
        for (const symbol of section.symbols) {
            ok(symbol.glyph.trim(), `${section.id}: a glyph for ${symbol.insert}`);
            ok(symbol.insert.trim(), `${section.id}: LaTeX for ${symbol.glyph}`);
            ok(!/\{\}/.test(symbol.insert), `${symbol.insert}: every empty group is a slot`);
        }
    }
});

test('the palettes hold the usual symbols', () => {
    const all = SECTIONS.flatMap(s => s.symbols.map(sym => sym.insert));
    for (const insert of ['\\alpha', '\\Omega', '\\varphi', '\\sum_{‸}^{‸}', '\\oint', '\\nabla',
        '\\approx', '\\propto', '\\ll', '\\in', '\\forall', '\\neg', '\\hat{‸}', '\\vec{‸}',
        '\\mathbb{R}', '\\mathcal{‸}', '\\hbar', '\\degree', '\\AA', '\\mathrm{d}', '\\pdv{‸}{x}',
        '\\vb{‸}', '\\mathbb{E}[‸]', '\\operatorname{Var}(‸)', '\\ce{H2O}'])
        ok(all.includes(insert), insert);
});

test('a search finds a symbol by its command, a keyword or its glyph', () => {
    eq(searchSymbols('alpha')[0].insert, '\\alpha');
    eq(searchSymbols('\\alpha')[0].insert, '\\alpha', 'with the backslash');
    eq(searchSymbols('approx')[0].insert, '\\approx');
    eq(searchSymbols('approximately')[0].insert, '\\approx', 'a keyword');
    eq(searchSymbols('≈')[0].insert, '\\approx', 'the glyph');
    eq(searchSymbols('ALPHA')[0].insert, '\\alpha', 'any case');
    ok(searchSymbols('integral').some(s => s.insert === '\\oint'), 'contour integral');
    eq(searchSymbols('real')[0].insert, '\\mathbb{R}');
    eq(searchSymbols('water')[0].insert, '\\ce{H2O}');
    eq(searchSymbols('   '), []);
    eq(searchSymbols('qwertyzzz'), []);
});

test('a search ranks a command that starts with it first, and lists each symbol once', () => {
    const results = searchSymbols('le');
    eq(results[0].insert, '\\leq', 'command starting with "le" before keyword matches');
    const inserts = results.map(r => r.insert);
    eq(new Set(inserts).size, inserts.length, 'no duplicates');
    ok(results.every(r => r.section), 'each result names its section');
});

test('templates each have a first slot, and a unique id', () => {
    const ids = TEMPLATES.map(t => t.id);
    eq(new Set(ids).size, ids.length);
    for (const id of ['fraction', 'root', 'sum', 'integral', 'limit', 'derivative', 'matrix',
        'cases', 'aligned'])
        ok(templateById(id), id);
    for (const template of TEMPLATES) {
        ok(template.insert.includes(SLOT), `${template.id} has a slot`);
        ok(template.label && template.glyph, template.id);
    }
    eq(templateById('nothing'), null);
});

test('the guide has topics with an example each', () => {
    ok(GUIDE.length >= 8);
    for (const topic of GUIDE)
        ok(topic.title && topic.text && topic.example, topic.title);
});

test('a symbol goes in at the cursor, replacing a selection', () => {
    eq(insertSnippet(at('a + b', 1), '\\cdot'), at('a\\cdot + b', 6));
    eq(insertSnippet(at('a + b', 2, 3), '\\pm'), at('a \\pm b', 5));
    eq(insertSnippet(at('', 0), '\\alpha'), at('\\alpha', 6));
    eq(insertSnippet(at('x', -1), '^2'), at('x^2', 3), 'negative: the end');
    // The selection bound may be after the cursor.
    eq(insertSnippet(at('abc', 3, 1), 'X'), at('aX', 2));
});

test('a command gets a space before a letter, so it does not run into it', () => {
    eq(insertSnippet(at('x', 0), '\\alpha'), at('\\alpha x', 7));
    eq(insertSnippet(at('1', 0), '\\alpha'), at('\\alpha1', 6), 'not before a digit');
    eq(insertSnippet(at('x', 0), '\\hat{‸}'), at('\\hat{}x', 5), 'not after a brace');
});

test('a snippet\'s slot takes the cursor, or the selection', () => {
    eq(insertSnippet(at('', 0), '\\frac{‸}{‸}'), at('\\frac{}{}', 6));
    eq(insertSnippet(at('a+b', 0, 3), '\\frac{‸}{‸}'), at('\\frac{a+b}{}', 11),
        'the selection fills the first slot; the cursor goes to the second');
    eq(insertSnippet(at('x', 0, 1), '\\sqrt{‸}'), at('\\sqrt{x}', 8), 'one slot: after it');
    eq(insertSnippet(at('v', 0, 1), '\\vec{‸}'), at('\\vec{v}', 7));
});

test('positions count characters, not UTF-16 units', () => {
    eq(insertSnippet(at('𝔼x', 1), '\\,'), at('𝔼\\,x', 3));
});

test('copy formats', () => {
    eq(copyText(' x^2 ', 'inline'), '$x^2$');
    eq(copyText('x^2', 'display'), '$$x^2$$');
    eq(copyText(' x^2\n', 'raw'), 'x^2');
});

test('recent formulas: newest first, no repeats, capped', () => {
    let list = [];
    list = pushRecent(list, 'a');
    list = pushRecent(list, 'b');
    list = pushRecent(list, 'a');
    eq(list, ['a', 'b']);
    const same = pushRecent(list, 'a');
    ok(same === list, 'unchanged: the same list');
    eq(pushRecent(list, '   '), list, 'blank is not kept');
    for (let i = 0; i < 30; i++)
        list = pushRecent(list, `f${i}`);
    eq(list.length, RECENT_LIMIT);
    eq(list[0], 'f29');
    eq(pushRecent([], 'x'.repeat(5000)), [], 'too long to keep');
});

test('starred formulas toggle, and a full list takes no more', () => {
    let list = toggleFavourite([], 'E=mc^2');
    eq(list, ['E=mc^2']);
    ok(isFavourite(list, ' E=mc^2 '));
    list = toggleFavourite(list, 'E=mc^2');
    eq(list, []);
    const full = Array.from({length: FAVOURITES_LIMIT}, (_, i) => `f${i}`);
    ok(toggleFavourite(full, 'new') === full);
    eq(toggleFavourite(full, 'f3').length, FAVOURITES_LIMIT - 1, 'unstarring still works');
});

test('errors in plain words', () => {
    eq(errorText('tex', 'Missing close brace'), 'Missing close brace');
    eq(errorText('tex', 'Undefined control sequence \\foo.'), 'Undefined control sequence \\foo');
    eq(errorText('timeout', 'x'), 'This formula took too long to draw');
    eq(errorText('crashed', 'x'), 'The renderer stopped while drawing this formula');
});

await done();
