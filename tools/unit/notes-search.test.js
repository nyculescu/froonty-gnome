// SPDX-License-Identifier: GPL-3.0-or-later
// Notes: searching for the All notes window (pure).

import {test, eq, ok, done} from './test.js';
import * as S from '../../froonty@catalin/features/notes/search.js';

// The source text a folded range stands for.
const back = (text, f, start, end) => {
    const [s, e] = S.sourceRange(f, start, end);
    return text.slice(s, e);
};

test('fold: lower case, no accents, and a map back to the source', () => {
    const text = 'Café Ünïcode';
    const f = S.fold(text);
    eq(f.folded, 'cafe unicode');
    eq(f.map.length, f.folded.length + 1);
    eq(back(text, f, 0, 4), 'Café');
    eq(back(text, f, 5, 12), 'Ünïcode');
});

test('fold: combining marks, ß, İ and emoji keep their offsets', () => {
    const decomposed = 'été'; // "été" with combining accents
    let f = S.fold(decomposed);
    eq(f.folded, 'ete');
    eq(back(decomposed, f, 0, 1), 'é', 'the mark goes with its letter');

    const street = 'Straße 5';
    f = S.fold(street);
    eq(f.folded, 'strasse 5');
    eq(back(street, f, 0, 7), 'Straße');
    eq(back(street, f, 4, 5), 'ß', 'half of "ss" is still the ß');

    const city = 'İstanbul';
    f = S.fold(city);
    eq(f.folded, 'istanbul');
    eq(back(city, f, 0, 3), 'İst');

    const emoji = 'a😀b🎉c';
    f = S.fold(emoji);
    eq(f.folded, emoji);
    const at = f.folded.indexOf('b');
    eq(back(emoji, f, at, at + 1), 'b');
    eq(back(emoji, f, 1, 3), '😀');
});

test('fold: only accents go; marks that are letters or sounds of other scripts stay', () => {
    eq(S.foldText('Καφές'), 'καφες', 'Greek accent');
    eq(S.foldText('Việt Nam'), 'viet nam', 'Vietnamese tone and vowel marks');
    eq(S.foldText('Ёжик'), 'ежик', 'Cyrillic diaeresis');
    ok(S.foldText('काता') !== S.foldText('कुत्ता'), 'Devanagari vowel signs are kept');
    eq(S.foldText('काता'), 'काता'.normalize('NFD'));
    ok(S.foldText('がき') !== S.foldText('かき'), 'Japanese voicing marks are kept');
    const hindi = [{name: 'Dog', text: 'कुत्ता', labels: [], modified: 0}];
    eq(S.searchNotes(hindi, {query: 'काता'}).length, 0);
    eq(S.searchNotes(hindi, {query: 'कुत्ता'}).length, 1);
    const japanese = [{name: 'Oyster', text: 'かき', labels: [], modified: 0}];
    eq(S.searchNotes(japanese, {query: 'がき'}).length, 0);
    eq(S.searchNotes(japanese, {query: 'かき'}).length, 1);
});

test('foldText is fold().folded, without the maps', () => {
    for (const text of ['', 'plain ascii, UPPER and lower', 'Café Ünïcode Straße İstanbul',
        'été ẞ 😀 कुत्ता がき\nsecond LINE\r\nthird', 'MIXED ÀÉÎ abc DEF'])
        eq(S.foldText(text), S.fold(text).folded, JSON.stringify(text));
});

const notes = [
    {name: 'Groceries', text: 'milk\nbread', labels: ['home'], modified: 300},
    {name: 'Plan', text: '# Q4 plan\nShip the café menu by Friday', labels: ['work', 'q4'], modified: 200},
    {name: 'Ideas', text: 'Plan a party\nmore', labels: [], modified: 400},
    {name: 'Old', text: 'work from home', labels: ['archive'], modified: 100},
];
const names = results => results.map(r => r.note.name);

test('search: every word must match, in name, text or labels', () => {
    eq(names(S.searchNotes(notes, {query: 'cafe friday'})), ['Plan']);
    eq(names(S.searchNotes(notes, {query: 'cafe groceries'})), []);
    eq(names(S.searchNotes(notes, {query: 'q4 ship'})), ['Plan'], 'label + text');
    eq(names(S.searchNotes(notes, {query: '  '})).length, 4, 'blank query: all');
});

test('search: name matches, then labels, then text; newest first within', () => {
    eq(names(S.searchNotes(notes, {query: 'plan'})), ['Plan', 'Ideas']);
    eq(names(S.searchNotes(notes, {query: 'home'})), ['Groceries', 'Old'], 'label before text');
    eq(names(S.searchNotes(notes, {query: 'work'})), ['Plan', 'Old']);
    eq(names(S.searchNotes(notes, {})), ['Ideas', 'Groceries', 'Plan', 'Old'], 'no query: newest first');
});

test('search: label filters combine with the text', () => {
    eq(names(S.searchNotes(notes, {labels: ['work']})), ['Plan']);
    eq(names(S.searchNotes(notes, {labels: ['work', 'home'], mode: 'all'})), []);
    eq(names(S.searchNotes(notes, {labels: ['work', 'home'], mode: 'any'})), ['Groceries', 'Plan']);
    eq(names(S.searchNotes(notes, {query: 'milk', labels: ['WORK', 'Home'], mode: 'any'})), ['Groceries']);
});

test('search: name ranges point at the original name', () => {
    const [r] = S.searchNotes([{name: 'Über Plan', text: '', labels: [], modified: 0}], {query: 'uber'});
    eq(r.nameRanges, [[0, 4]]);
});

test('snippet: the line of the first match, cut at words, ranges mapped back', () => {
    const line = `${'lorem ipsum '.repeat(10)}the Café   opens at nine ${'dolor sit '.repeat(15)}`;
    const text = `title\n${line}\nlast`;
    const s = S.snippet(text, S.terms('cafe'));
    ok(s.text.startsWith('…') && s.text.endsWith('…'), s.text);
    ok(s.text.length <= 142, `${s.text.length} characters`);
    ok(!s.text.includes('  '), 'whitespace collapsed');
    eq(s.ranges.length, 1);
    const [start, end] = s.ranges[0];
    eq(s.text.slice(start, end), 'Café');
    ok(/^… \S/.test(s.text) === false && /^…\S/.test(s.text), 'cut at a word boundary');
});

test('snippet: short lines whole; several matches; no query takes the first line', () => {
    const s = S.snippet('one\n  Two  two TWO\nthree', S.terms('two'));
    eq(s.text, 'Two two TWO');
    eq(s.ranges, [[0, 3], [4, 7], [8, 11]]);
    eq(S.snippet('\n\n# Heading\nbody').text, 'Heading');
    eq(S.snippet('- [ ] milk\n- bread').text, 'milk');
    eq(S.snippet('1. first').text, 'first');
    eq(S.snippet('   ').text, '');
    eq(S.snippet('plain text', S.terms('absent')).text, 'plain text', 'no match: first line');
});

test('search: keeps only folded strings between searches; excerpts when read', () => {
    const cache = new Map();
    const long = {name: 'Long', text: `Straße\nÜber alles\n${'x '.repeat(5000)}\nfind the CAFÉ here`, labels: [], modified: 0};
    const [r] = S.searchNotes([long], {query: 'cafe'}, cache);
    const kept = cache.get('Long');
    eq(Object.keys(kept).sort(), ['folded', 'text']);
    eq(typeof kept.folded, 'string');
    eq(r.snippet.text, 'find the CAFÉ here', 'the right line, after lines that fold to other lengths');
    eq(r.snippet.ranges, [[9, 13]]);
    eq(r.snippet.text.slice(9, 13), 'CAFÉ');
    eq(r.nameRanges, []);
    const [again] = S.searchNotes([long], {query: 'here'}, cache);
    eq(cache.get('Long'), kept, 'the same text is not folded again');
    eq(again.snippet.text, 'find the CAFÉ here');
});

test('markup escapes <&> and bolds the ranges', () => {
    eq(S.markup('a <b> & c', [[2, 5]]), 'a <b>&lt;b&gt;</b> &amp; c');
    eq(S.markup('x<y', []), 'x&lt;y');
    eq(S.markup('abcd', [[2, 4], [0, 1], [1, 2]]), '<b>ab</b><b>cd</b>'.replace('</b><b>', ''));
});

await done();
