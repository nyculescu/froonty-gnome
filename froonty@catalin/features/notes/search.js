// SPDX-License-Identifier: GPL-3.0-or-later
// Searching notes for the "All notes" window. Pure functions, unit-tested;
// no St, no GTK (GLib only, to escape Pango markup).
//
// Matching ignores case and accents ("cafe" finds "Café", "strasse" finds
// "Straße"). Words of the search text must all match (AND), each in the
// note's name, its text or one of its labels. Selected labels filter on
// top of that (labels.js matchesLabels).
//
// Accents are the combining diacritical marks (the Unicode blocks of that
// name), which Latin, Greek and Cyrillic letters carry. Other combining
// marks are letters or distinct sounds of their scripts (Devanagari vowel
// signs, Japanese voicing marks, Thai vowels) and are kept: "काता" does not
// find "कुत्ता", nor "がき" "かき".
//
// Cost: a search keeps one folded copy of each note's text (a string; the
// caller's cache), and works out excerpts and their ranges only for the
// results that are shown.

import GLib from 'gi://GLib';

import {matchesLabels} from './labels.js';

const SNIPPET_CHARS = 140;
// How much of the line to keep before the first match in a snippet.
const LEAD_CHARS = 40;
// Combining Diacritical Marks, its Extended and Supplement blocks, those
// for Symbols, and the Half Marks.
const ACCENTS = /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/gu;
const FOLDED_RUNS = /[A-Z]+|[^\0-\x7F]+/gu;

// One code point, folded: decomposed, without accents, lower case.
function foldCodePoint(ch) {
    const code = ch.charCodeAt(0);
    if (code < 0x80) // ASCII (most text): only the case changes
        return code >= 0x41 && code <= 0x5A ? String.fromCharCode(code + 0x20) : ch;
    const folded = ch.normalize('NFD').replace(ACCENTS, '').toLowerCase();
    return folded.replace(/ß/g, 'ss');
}

/**
 * Folds text for matching: the same as fold(text).folded, without the
 * maps back to the source (much less memory for a whole note).
 */
export function foldText(text) {
    // Runs at a time: upper-case ASCII, or anything outside ASCII.
    return text.replace(FOLDED_RUNS, run => {
        if (run.charCodeAt(0) < 0x80)
            return run.toLowerCase();
        let folded = '';
        for (const ch of run)
            folded += foldCodePoint(ch);
        return folded;
    });
}

/**
 * Folds text for matching, with a map back to the source. Folding works
 * code point by code point and keeps line breaks one for one.
 *
 * @returns {{folded: string, map: number[], ends: number[]}} `map[i]` is
 *   the index in `text` (UTF-16) of the code point that gave folded unit
 *   i, `ends[i]` the index just after it; `map[folded.length]` is
 *   text.length.
 */
export function fold(text) {
    let folded = '';
    const map = [];
    const ends = [];
    let index = 0;
    for (const ch of text) {
        const part = foldCodePoint(ch);
        for (let i = 0; i < part.length; i++) {
            map.push(index);
            ends.push(index + ch.length);
        }
        folded += part;
        index += ch.length;
    }
    map.push(text.length);
    return {folded, map, ends};
}

/** A range of folded units [start, end) → a range of the source text. */
export function sourceRange({map, ends}, start, end) {
    const from = map[start];
    const next = map[end];
    return [from, next > map[end - 1] ? next : ends[end - 1]];
}

/** Search words, folded; empty for an empty query. */
export function terms(query) {
    return foldText(query ?? '').split(/\s+/u).filter(Boolean);
}

// The folded text of a note. Folding a long note takes a while: a caller
// searching repeatedly can keep it (by note name) between searches. Only
// the string is kept, not fold()'s maps (two numbers per character).
function cachedFold(note, cache) {
    const cached = cache?.get(note.name);
    if (cached && cached.text === note.text)
        return cached.folded;
    const folded = foldText(note.text);
    cache?.set(note.name, {text: note.text, folded});
    return folded;
}

// All occurrences of the terms, as merged source ranges.
function rangesIn(f, words) {
    const ranges = [];
    for (const word of words) {
        for (let at = f.folded.indexOf(word); at >= 0; at = f.folded.indexOf(word, at + word.length))
            ranges.push(sourceRange(f, at, at + word.length));
    }
    return merge(ranges);
}

function merge(ranges) {
    const out = [];
    for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
        const last = out.at(-1);
        if (last && start <= last[1])
            last[1] = Math.max(last[1], end);
        else
            out.push([start, end]);
    }
    return out;
}

/**
 * Notes matching a search, best first.
 *
 * @param {{name: string, text: string, labels: string[], modified: number}[]} notes
 * @param {object} options
 * @param {string} options.query words, all of which must match
 * @param {string[]} options.labels selected labels
 * @param {'all'|'any'} options.mode how selected labels combine
 * @param {?Map} cache folded texts kept between calls (optional)
 * @returns {{note: object, nameRanges: number[][], snippet: {text: string, ranges: number[][]}}[]}
 *   Without a query, newest first. With one: name matches, then label
 *   matches, then text-only matches; newest first within each.
 *   `nameRanges` and `snippet` are worked out when first read, so a caller
 *   that shows only some results pays only for those.
 */
export function searchNotes(notes, {query = '', labels = [], mode = 'all'} = {}, cache = null) {
    const words = terms(query);
    const matches = [];
    for (const note of notes) {
        if (!matchesLabels(note.labels ?? [], labels, mode))
            continue;
        if (!words.length) {
            matches.push({note, tier: 0, folded: null});
            continue;
        }
        const name = foldText(note.name);
        const noteLabels = (note.labels ?? []).map(foldText);
        const text = cachedFold(note, cache);
        let tier = 2;
        let all = true;
        for (const word of words) {
            const inName = name.includes(word);
            const inLabel = noteLabels.some(l => l.includes(word));
            if (!inName && !inLabel && !text.includes(word)) {
                all = false;
                break;
            }
            tier = Math.min(tier, inName ? 0 : inLabel ? 1 : 2);
        }
        if (all)
            matches.push({note, tier, folded: text});
    }
    matches.sort((a, b) => a.tier - b.tier || (b.note.modified ?? 0) - (a.note.modified ?? 0));
    return matches.map(({note, folded}) => result(note, words, folded));
}

function result(note, words, folded) {
    let nameRanges = null;
    let cut = null;
    return {
        note,
        get nameRanges() {
            nameRanges ??= words.length ? rangesIn(fold(note.name), words) : [];
            return nameRanges;
        },
        get snippet() {
            cut ??= snippet(note.text, words, SNIPPET_CHARS, folded);
            return cut;
        },
    };
}

// Leading Markdown of a line shown without a query: heading marks, list
// bullets and numbers, checkboxes, quotes.
const LINE_MARKERS = /^\s*(?:#{1,6}\s+|>\s*|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/u;

/**
 * A one-line excerpt of a note.
 *
 * @param {string} text the note
 * @param {string[]} words folded search words (see terms()); none for the
 *   first non-empty line
 * @param {number} maxChars about how long the excerpt may be
 * @param {?string} folded foldText(text), if already known
 * @returns {{text: string, ranges: number[][]}} ranges of matches, in the
 *   excerpt's own indices
 */
export function snippet(text, words = [], maxChars = SNIPPET_CHARS, folded = null) {
    if (words.length) {
        const all = folded ?? foldText(text);
        let first = -1;
        for (const word of words) {
            const at = all.indexOf(word);
            if (at >= 0 && (first < 0 || at < first))
                first = at;
        }
        if (first >= 0) {
            // Folding keeps line breaks one for one: the match's line is
            // found by counting them, and only that line is folded again
            // with a map back to the source.
            let line = 0;
            for (let at = all.indexOf('\n'); at >= 0 && at < first; at = all.indexOf('\n', at + 1))
                line++;
            let lineStart = 0;
            for (let i = 0; i < line; i++)
                lineStart = text.indexOf('\n', lineStart) + 1;
            const newline = text.indexOf('\n', lineStart);
            const lineEnd = newline < 0 ? text.length : newline;
            const ranges = rangesIn(fold(text.slice(lineStart, lineEnd)), words)
                .map(([s, e]) => [s + lineStart, e + lineStart]);
            const matchStart = ranges[0]?.[0] ?? lineStart;
            return excerpt(text, lineStart, lineEnd, matchStart, maxChars, ranges);
        }
    }
    // The first line with something on it, without its Markdown marker.
    const first = text.search(/\S/u);
    if (first < 0)
        return {text: '', ranges: []};
    const lineStart = text.lastIndexOf('\n', first) + 1;
    const newline = text.indexOf('\n', first);
    const lineEnd = newline < 0 ? text.length : newline;
    const marker = text.slice(lineStart, lineEnd).match(LINE_MARKERS)?.[0].length ?? 0;
    const start = lineStart + marker;
    return excerpt(text, start, lineEnd, start, maxChars, []);
}

// Cuts [lineStart, lineEnd) of text to about maxChars around `focus`, at
// word boundaries, with "…" where it was cut, and whitespace collapsed.
function excerpt(text, lineStart, lineEnd, focus, maxChars, ranges) {
    let start = lineStart;
    let end = lineEnd;
    if (end - start > maxChars) {
        start = Math.max(lineStart, Math.min(focus - LEAD_CHARS, lineEnd - maxChars));
        end = Math.min(lineEnd, start + maxChars);
        if (start > lineStart) {
            const space = text.slice(start, focus).search(/\s/u);
            if (space >= 0)
                start += space + 1;
        }
        if (end < lineEnd) {
            const before = text.slice(focus, end);
            const space = before.search(/\s\S*$/u);
            if (space > 0)
                end = focus + space;
        }
    }
    // Never cut inside a surrogate pair.
    if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]))
        start--;
    if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end]))
        end++;

    // Collapse whitespace, mapping source indices to excerpt indices.
    const prefix = start > lineStart ? '…' : '';
    let out = prefix;
    const at = new Map();
    let space = false;
    for (let i = start; i < end; i++) {
        const isSpace = /\s/u.test(text[i]);
        if (isSpace && (space || out.length === prefix.length)) {
            at.set(i, out.length);
            continue;
        }
        at.set(i, out.length);
        out += isSpace ? ' ' : text[i];
        space = isSpace;
    }
    at.set(end, out.trimEnd().length);
    out = out.trimEnd();
    if (end < lineEnd)
        out += '…';
    const mapped = ranges
        .filter(([s, e]) => s >= start && e <= end)
        .map(([s, e]) => [at.get(s), Math.min(at.get(e), out.length)])
        .filter(([s, e]) => e > s);
    return {text: out, ranges: mapped};
}

/** Pango markup: `text` escaped, `ranges` in bold. */
export function markup(text, ranges = []) {
    let out = '';
    let at = 0;
    for (const [start, end] of merge(ranges)) {
        if (start < at)
            continue;
        out += GLib.markup_escape_text(text.slice(at, start), -1);
        out += `<b>${GLib.markup_escape_text(text.slice(start, end), -1)}</b>`;
        at = end;
    }
    return out + GLib.markup_escape_text(text.slice(at), -1);
}
