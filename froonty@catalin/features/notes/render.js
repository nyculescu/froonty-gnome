// SPDX-License-Identifier: GPL-3.0-or-later
// Rendered Markdown for the Notes editor (docs/features/notes.md): which
// parts of the note's text to show bold, italic, as a heading, and so on,
// and which Markdown markers to hide. The note stays plain Markdown; only
// how it is drawn changes. As in Obsidian's live preview, the markers of
// the line being edited stay visible (dimmed), so they can be edited.
//
// Pure: offsets are JavaScript string indices (UTF-16 units). The island
// turns the spans into Pango attributes (byte offsets, styler.js), the All
// notes window into text tags (character offsets, allNotesStyler.js). No GI.

const HEADING = /^(#{1,6}) +/;
const QUOTE = /^> ?/;
const CHECK = /^(\s*)- \[([ xX])\] /;
const BULLET = /^(\s*)[-*+] /;
const NUMBERED = /^(\s*)\d+[.)] /;
const FENCE = /^\s*```/;

// Inline spans, in the order they claim text: code first, so markers in
// code are not formatting. Each regex captures the content as group 1.
const INLINE = [
    {re: /`([^`\n]+)`/g, style: 'code', open: 1, close: 1},
    {re: /\[([^\]\n]+)\]\(([^)\s]+)\)/g, style: 'link'},
    {re: /\*\*(?=\S)(.+?)(?<=\S)\*\*/g, style: 'bold', open: 2, close: 2},
    {re: /__(?=\S)(.+?)(?<=\S)__/g, style: 'bold', open: 2, close: 2},
    {re: /~~(?=\S)(.+?)(?<=\S)~~/g, style: 'strike', open: 2, close: 2},
    {re: /(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])/g, style: 'italic', open: 1, close: 1},
    {re: /(?<![\w_])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\w_])/g, style: 'italic', open: 1, close: 1},
];

/**
 * The styled spans of `text`.
 *
 * @param {string} text the note
 * @param {number} activeLine the line (from 0) whose markers stay visible;
 *   -1 to hide every line's markers
 * @returns {{start: number, end: number, style: string}[]} styles:
 *   'h1'…'h6', 'bold', 'italic', 'strike', 'code', 'link', 'quote',
 *   'done' (a checked item), 'fence' (inside a code block), 'marker'
 *   (shown dimmed), 'hidden' (a marker drawn invisible and zero-width)
 */
export function markdownSpans(text, activeLine = -1) {
    const spans = [];
    let offset = 0;
    let inFence = false;
    // Plain lines (no heading, quote, list item or code), for emphasis
    // that runs across a line break: {offset, line, active, claimed}.
    const lines = [];
    text.split('\n').forEach((line, index) => {
        const active = index === activeLine;
        const marker = (start, end) => {
            if (end > start)
                spans.push({start: offset + start, end: offset + end, style: active ? 'marker' : 'hidden'});
        };
        const span = (start, end, style) => {
            if (end > start)
                spans.push({start: offset + start, end: offset + end, style});
        };

        if (FENCE.test(line)) {
            // A fence line is a marker of its own; kept visible (dimmed)
            // so the block's edges stay findable.
            span(0, line.length, 'marker');
            inFence = !inFence;
        } else if (inFence) {
            span(0, line.length, 'fence');
        } else {
            const plain = lineSpans(line, {marker, span});
            if (plain)
                lines.push({index, offset, line, active, claimed: plain.claimed});
        }
        if (lines.at(-1)?.index !== index)
            lines.push(null); // a paragraph ends here
        offset += line.length + 1;
    });
    crossLineSpans(lines, spans);
    return spans;
}

// Markers a line leaves unpaired, for crossLineSpans(): the same rules as
// INLINE (no space inside the markers, single ones not inside a word).
const CROSS = [
    {marker: '**', style: 'bold'},
    {marker: '__', style: 'bold'},
    {marker: '~~', style: 'strike'},
    {marker: '*', style: 'italic', word: /[\w*]/},
    {marker: '_', style: 'italic', word: /[\w_]/},
];

/**
 * Emphasis over several lines of one paragraph, as in CommonMark: an
 * opening marker a line left unpaired closes at the first unpaired closing
 * one on a later line of the same paragraph (a blank line, a heading, a
 * list item, a quote or a code block ends the paragraph).
 */
function crossLineSpans(lines, spans) {
    const paragraphs = [];
    let current = [];
    for (const line of [...lines, null]) {
        if (line) {
            current.push(line);
        } else {
            if (current.length > 1)
                paragraphs.push(current);
            current = [];
        }
    }
    for (const paragraph of paragraphs) {
        for (const {marker, style, word} of CROSS) {
            const n = marker.length;
            const free = []; // {line, at, opens, closes}
            for (const line of paragraph) {
                for (let at = line.line.indexOf(marker); at >= 0; at = line.line.indexOf(marker, at + n)) {
                    if (line.claimed.slice(at, at + n).some(Boolean))
                        continue;
                    // A longer run ("***", "____") is not this marker.
                    if (line.line[at - 1] === marker[0] || line.line[at + n] === marker[0])
                        continue;
                    const before = line.line[at - 1] ?? ' ';
                    const after = line.line[at + n] ?? ' ';
                    const opens = /\S/.test(after) && !(word && word.test(before));
                    const closes = /\S/.test(before) && !(word && word.test(after));
                    free.push({line, at, opens, closes});
                }
            }
            for (let i = 0; i < free.length; i++) {
                const open = free[i];
                if (!open.opens || open.used)
                    continue;
                const close = free.slice(i + 1).find(c => !c.used && c.closes && c.line !== open.line);
                if (!close)
                    continue;
                open.used = close.used = true;
                const mark = (line, at) => spans.push({
                    start: line.offset + at, end: line.offset + at + n, style: line.active ? 'marker' : 'hidden',
                });
                mark(open.line, open.at);
                mark(close.line, close.at);
                spans.push({start: open.line.offset + open.at + n, end: close.line.offset + close.at, style});
                for (const c of [open, close])
                    c.line.claimed.fill(true, c.at, c.at + n);
            }
        }
    }
}

// Returns {claimed} (inlineSpans') for a plain line, else null.
function lineSpans(line, {marker, span}) {
    let rest = 0;
    let plain = line.trim() !== '';
    const heading = HEADING.exec(line);
    if (heading) {
        marker(0, heading[0].length);
        span(heading[0].length, line.length, `h${heading[1].length}`);
        rest = heading[0].length;
        plain = false;
    }
    const quote = !heading && QUOTE.exec(line);
    if (quote) {
        span(0, quote[0].length, 'marker');
        span(quote[0].length, line.length, 'quote');
        rest = quote[0].length;
        plain = false;
    }
    const check = !heading && !quote && CHECK.exec(line);
    if (check) {
        // The box stays: it reads as a checkbox. Ticked, the item is done.
        span(check[1].length, check[0].length, 'marker');
        if (check[2] !== ' ')
            span(check[0].length, line.length, 'done');
        rest = check[0].length;
        plain = false;
    } else if (!heading && !quote) {
        const list = BULLET.exec(line) ?? NUMBERED.exec(line);
        if (list) {
            span(list[1].length, list[0].length, 'marker');
            rest = list[0].length;
            plain = false;
        }
    }
    const claimed = inlineSpans(line, rest, {marker, span});
    return plain ? {claimed} : null;
}

function inlineSpans(line, from, {marker, span}) {
    // Characters already claimed (code, link URLs, markers).
    const claimed = new Array(line.length).fill(false);
    const free = (start, end) => {
        for (let i = start; i < end; i++) {
            if (claimed[i])
                return false;
        }
        return true;
    };
    const claim = (start, end) => claimed.fill(true, start, end);

    for (const {re, style, open, close} of INLINE) {
        re.lastIndex = from;
        for (let m = re.exec(line); m; m = re.exec(line)) {
            const start = m.index;
            const end = start + m[0].length;
            if (style === 'link') {
                // [label](url): the label underlined, the rest a marker.
                const labelEnd = start + 1 + m[1].length;
                if (!free(start, end))
                    continue;
                marker(start, start + 1);
                span(start + 1, labelEnd, 'link');
                marker(labelEnd, end);
                claim(start, start + 1);
                claim(labelEnd, end);
                continue;
            }
            // Markers must be free; the content may hold other spans.
            if (!free(start, start + open) || !free(end - close, end))
                continue;
            marker(start, start + open);
            span(start + open, end - close, style);
            marker(end - close, end);
            if (style === 'code') {
                claim(start, end);
            } else {
                claim(start, start + open);
                claim(end - close, end);
            }
        }
    }
    return claimed;
}

/** The line (from 0) holding character position `position` (code points). */
export function lineAt(text, position) {
    let line = 0;
    let index = 0;
    for (const char of text) {
        if (index++ >= position)
            break;
        if (char === '\n')
            line++;
    }
    return line;
}

/**
 * UTF-8 byte offsets for every UTF-16 index of `text` (one more than its
 * length), for Pango attributes.
 */
export function byteOffsets(text) {
    const offsets = new Array(text.length + 1);
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
        offsets[i] = bytes;
        const code = text.charCodeAt(i);
        if (code < 0x80)
            bytes += 1;
        else if (code < 0x800)
            bytes += 2;
        else if (code >= 0xd800 && code < 0xdc00)
            bytes += 4; // a surrogate pair: 4 bytes for both halves
        else if (code >= 0xdc00 && code < 0xe000)
            bytes += 0;
        else
            bytes += 3;
    }
    offsets[text.length] = bytes;
    return offsets;
}

/**
 * Character offsets (code points, what GtkTextIter counts) of UTF-16
 * indices of `text`, as a Map from each index.
 */
export function charOffsets(text, indices) {
    const wanted = [...new Set(indices)].sort((a, b) => a - b);
    const offsets = new Map();
    let chars = 0;
    let at = 0;
    for (const index of wanted) {
        for (; at < index; at++) {
            const code = text.charCodeAt(at);
            // A low surrogate continues the character before it.
            if (code < 0xDC00 || code > 0xDFFF)
                chars++;
        }
        offsets.set(index, chars);
    }
    return offsets;
}
