// SPDX-License-Identifier: GPL-3.0-or-later
// Rendered Markdown for the Notes editor (docs/features/notes.md): which
// parts of the note's text to show bold, italic, as a heading, and so on,
// and which Markdown markers to hide. The note stays plain Markdown; only
// how it is drawn changes. As in Obsidian's live preview, the markers of
// the line being edited stay visible (dimmed), so they can be edited.
//
// Pure: offsets are JavaScript string indices (UTF-16 units). The view
// turns the spans into Pango attributes (byte offsets). No GI.

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
            lineSpans(line, {marker, span});
        }
        offset += line.length + 1;
    });
    return spans;
}

function lineSpans(line, {marker, span}) {
    let rest = 0;
    const heading = HEADING.exec(line);
    if (heading) {
        marker(0, heading[0].length);
        span(heading[0].length, line.length, `h${heading[1].length}`);
        rest = heading[0].length;
    }
    const quote = !heading && QUOTE.exec(line);
    if (quote) {
        span(0, quote[0].length, 'marker');
        span(quote[0].length, line.length, 'quote');
        rest = quote[0].length;
    }
    const check = !heading && !quote && CHECK.exec(line);
    if (check) {
        // The box stays: it reads as a checkbox. Ticked, the item is done.
        span(check[1].length, check[0].length, 'marker');
        if (check[2] !== ' ')
            span(check[0].length, line.length, 'done');
        rest = check[0].length;
    } else if (!heading && !quote) {
        const list = BULLET.exec(line) ?? NUMBERED.exec(line);
        if (list) {
            span(list[1].length, list[0].length, 'marker');
            rest = list[0].length;
        }
    }
    inlineSpans(line, rest, {marker, span});
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
