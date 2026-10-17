// SPDX-License-Identifier: GPL-3.0-or-later
// The part of a note a click in the rendered view edits in place (All
// notes, allNotesStyler.js): a paragraph (its run of plain lines), a
// heading, a list item or a quote line, a task's text (after its box, which
// stays a checkbox), or a code fence whole. Never a drawn block (a table,
// an image, a diagram) or a line beside one. Pure: no GI. Offsets are
// UTF-16 indices into the note, like blocks.js.
//
//   editUnitAt(text, offset, blocks) → {start, end} or null
//   sourceOffset(text, preview, previewOffset) → the note offset shown at
//       previewOffset of markdownPreview(text, …)'s copy; null on a block
//   codeAt(text, offset) → the code at offset, for Copy code: a fence's
//       lines without its fence lines, or an inline code span's text; null
//       elsewhere

const FENCE = /^\s*(`{3,}|~{3,})/;
const TASK = /^\s*[-*+]\s+\[[ xX]\]\s?/;
// A line that is a unit of its own: a heading, a list item, a quote, a
// rule or a setext underline.
const OWN_LINE = /^\s{0,3}(?:#{1,6}(?:\s|$)|>|[-*+]\s|\d+[.)]\s|(?:[-*_=]\s*){3,}$)/;

function lineRanges(text) {
    const lines = [];
    let start = 0;
    for (const line of text.split('\n')) {
        lines.push({start, end: start + line.length, line});
        start += line.length + 1;
    }
    return lines;
}

// The fences, as [first line, last line, closed] (an unclosed one runs to
// the end).
function fences(lines) {
    const found = [];
    for (let i = 0; i < lines.length; i++) {
        const fence = FENCE.exec(lines[i].line);
        if (!fence)
            continue;
        const close = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`);
        let end = i + 1;
        while (end < lines.length && !close.test(lines[end].line))
            end++;
        found.push([i, Math.min(end, lines.length - 1), end < lines.length]);
        i = end;
    }
    return found;
}

export function editUnitAt(text, offset, blocks = []) {
    const lines = lineRanges(text);
    const index = lines.findIndex(({start, end}) => offset >= start && offset <= end);
    if (index < 0)
        return null;
    const overlaps = (start, end) => blocks.some(block => block.start < Math.max(end, start + 1) &&
        block.end > start);
    const fenced = fences(lines);
    const inFence = i => fenced.some(([first, last]) => i >= first && i <= last);
    let unit;
    const fence = fenced.find(([first, last]) => index >= first && index <= last);
    const {line} = lines[index];
    if (fence) {
        unit = {start: lines[fence[0]].start, end: lines[fence[1]].end};
    } else if (!line.trim()) {
        return null;
    } else if (TASK.test(line)) {
        unit = {start: lines[index].start + TASK.exec(line)[0].length, end: lines[index].end};
        if (unit.start >= unit.end)
            return null;
    } else if (OWN_LINE.test(line)) {
        unit = {start: lines[index].start, end: lines[index].end};
    } else {
        // A paragraph: the plain lines around it, up to a blank or another
        // kind of line, a fence or a block.
        const plain = i => i >= 0 && i < lines.length && lines[i].line.trim() &&
            !OWN_LINE.test(lines[i].line) && !TASK.test(lines[i].line) && !inFence(i) &&
            !overlaps(lines[i].start, lines[i].end);
        let first = index, last = index;
        while (plain(first - 1))
            first--;
        while (plain(last + 1))
            last++;
        unit = {start: lines[first].start, end: lines[last].end};
    }
    return overlaps(unit.start, unit.end) ? null : unit;
}

export function sourceOffset(text, preview, previewOffset) {
    for (const {start, end} of lineRanges(text)) {
        const from = preview.mapOffset(start);
        const to = preview.mapOffset(end);
        // Only a line the copy keeps whole.
        if (from !== null && to !== null && to - from === end - start &&
            previewOffset >= from && previewOffset <= to)
            return start + previewOffset - from;
    }
    return null;
}

export function codeAt(text, offset) {
    const lines = lineRanges(text);
    const index = lines.findIndex(({start, end}) => offset >= start && offset <= end);
    if (index < 0)
        return null;
    const fence = fences(lines).find(([first, last]) => index >= first && index <= last);
    if (fence) {
        const [first, last, closed] = fence;
        const end = closed ? last - 1 : last;
        return end > first ? text.slice(lines[first + 1].start, lines[end].end) : '';
    }
    // As render.js draws them: one backtick each side, on one line.
    const {start, line} = lines[index];
    for (const span of line.matchAll(/`([^`\n]+)`/g)) {
        if (offset >= start + span.index && offset < start + span.index + span[0].length)
            return span[1];
    }
    return null;
}
