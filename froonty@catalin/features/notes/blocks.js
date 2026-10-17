// SPDX-License-Identifier: GPL-3.0-or-later
// Markdown blocks which need a picture rather than text attributes. Offsets
// are UTF-16 indices, like markdownSpans() and Clutter.Text.

const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})\s*([^\s]*)\s*$/;
const IMAGE = /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const CODE = /`[^`\n]+`/g;

/** Finds tables, local Markdown images and Mermaid fenced blocks. */
export function markdownBlocks(text) {
    const lines = text.split('\n');
    const starts = [];
    let offset = 0;
    for (const line of lines) {
        starts.push(offset);
        offset += line.length + 1;
    }
    const blocks = [];
    const fenced = new Set();
    for (let i = 0; i < lines.length; i++) {
        const fence = FENCE.exec(lines[i]);
        if (!fence)
            continue;
        let end = i + 1;
        while (end < lines.length && !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[end]))
            end++;
        for (let n = i; n <= Math.min(end, lines.length - 1); n++)
            fenced.add(n);
        const body = end < lines.length ? lines.slice(i + 1, end).join('\n') : '';
        const diagram = /^(?:flowchart|graph|stateDiagram(?:-v2)?|sequenceDiagram)\b/i.test(body.trim());
        if ((fence[2].toLowerCase() === 'mermaid' || (!fence[2] && diagram)) && end < lines.length) {
            const close = lines[end];
            blocks.push({kind: 'mermaid', start: starts[i], end: starts[end] + close.length,
                source: body});
        }
        i = Math.min(end, lines.length - 1);
    }

    for (let i = 0; i + 1 < lines.length; i++) {
        if (fenced.has(i) || fenced.has(i + 1) || !lines[i].includes('|') || !TABLE_RULE.test(lines[i + 1]))
            continue;
        let end = i + 2;
        while (end < lines.length && !fenced.has(end) && lines[end].includes('|') && lines[end].trim())
            end++;
        blocks.push({kind: 'table', start: starts[i], end: starts[end - 1] + lines[end - 1].length,
            source: lines.slice(i, end).join('\n')});
        i = end - 1;
    }

    IMAGE.lastIndex = 0;
    for (let match; (match = IMAGE.exec(text)); ) {
        const lineStart = text.lastIndexOf('\n', match.index - 1) + 1;
        const lineEnd = text.indexOf('\n', match.index);
        const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
        const at = match.index - lineStart;
        const lineNumber = text.slice(0, match.index).split('\n').length - 1;
        // Not in code (a fence or a `span`), a quote or a table.
        if (fenced.has(lineNumber) || line.slice(0, at).trimStart().startsWith('>')
            || [...line.matchAll(CODE)].some(code => at > code.index && at < code.index + code[0].length)
            || blocks.some(block => block.kind === 'table' && match.index >= block.start && match.index < block.end))
            continue;
        blocks.push({kind: 'image', start: match.index, end: match.index + match[0].length,
            source: match[2], alt: match[1]});
    }
    return blocks.sort((a, b) => a.start - b.start);
}

/**
 * A one-line display copy of a note. Rendered blocks replace their source
 * with one object marker, so the renderer can lay them out as real blocks
 * without retaining the source code's extra lines. The note itself is never
 * changed. `mapOffset()` maps preserved UTF-16 source offsets into the copy.
 */
export function markdownPreview(text, blocks) {
    const parts = [];
    const preserved = [];
    const renderedBlocks = [];
    let sourceAt = 0;
    let outputLength = 0;
    for (const block of blocks) {
        if (block.start < sourceAt)
            continue;
        const before = text.slice(sourceAt, block.start);
        preserved.push({start: sourceAt, end: block.start, output: outputLength});
        parts.push(before);
        outputLength += before.length;

        const lineStart = text.lastIndexOf('\n', block.start - 1) + 1;
        const lineEndAt = text.indexOf('\n', block.end);
        const lineEnd = lineEndAt < 0 ? text.length : lineEndAt;
        const inlineImage = block.kind === 'image' &&
            (text.slice(lineStart, block.start).trim() || text.slice(block.end, lineEnd).trim());
        if (inlineImage && outputLength > 0 && text[block.start - 1] !== '\n') {
            parts.push('\n');
            outputLength++;
        }
        const previewStart = outputLength;
        parts.push('\uFFFC');
        outputLength++;
        if (inlineImage) {
            parts.push('\n');
            outputLength++;
        }
        renderedBlocks.push({...block, previewStart});
        sourceAt = block.end;
    }
    preserved.push({start: sourceAt, end: text.length, output: outputLength});
    parts.push(text.slice(sourceAt));
    const previewText = parts.join('');
    return {
        text: previewText,
        blocks: renderedBlocks,
        mapOffset(offset) {
            // A source offset immediately after a rendered block belongs to
            // the following preserved segment, whose output position is after
            // the placeholder. Treating both segment ends as inclusive maps
            // tasks and selections onto the block itself.
            const segment = preserved.find(({start, end}) => offset >= start &&
                (offset < end || (offset === text.length && end === text.length)));
            return segment ? segment.output + offset - segment.start : null;
        },
    };
}
