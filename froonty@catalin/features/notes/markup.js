// SPDX-License-Identifier: GPL-3.0-or-later
// Pango markup for a note's Markdown text, as the island's rendered view
// draws it (renderer/preview.js) and as the desktop stickies show a note.

import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

const escapeMarkup = text => GLib.markup_escape_text(text, -1);

/** One line's inline Markdown, or its plain text when its markers cross (`**a _b** c_`), which Pango would reject. */
export function inlineMarkup(text) {
    // Code spans first, so markers in code are not formatting.
    const markup = text.split(/(`[^`\n]+`)/).map((part, i) => i % 2
        ? `<tt>${escapeMarkup(part.slice(1, -1))}</tt>` : emphasis(escapeMarkup(part))).join('');
    try {
        Pango.parse_markup(markup, -1, '');
        return markup;
    } catch {
        return escapeMarkup(text);
    }
}

function emphasis(markup) {
    return markup
        .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, '<b>$1</b>')
        .replace(/__(\S(?:.*?\S)?)__/g, '<b>$1</b>')
        .replace(/~~(\S(?:.*?\S)?)~~/g, '<s>$1</s>')
        .replace(/(?<![\w*])\*(\S(?:.*?\S)?)\*(?![\w*])/g, '<i>$1</i>')
        .replace(/(?<![\w_])_(\S(?:.*?\S)?)_(?![\w_])/g, '<i>$1</i>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<u>$1</u>');
}

/** A line outside code and tasks: a heading, a quote, a list item or plain text. */
export function lineMarkup(line) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
        const size = Math.round(Math.max(1, 1.45 - heading[1].length * 0.07) * 100);
        return `<span weight="bold" size="${size}%">${inlineMarkup(heading[2])}</span>`;
    }
    if (/^\s*>/.test(line))
        return `<span style="italic" foreground="#888">${inlineMarkup(line.replace(/^\s*>\s?/, ''))}</span>`;
    return inlineMarkup(line.replace(/^(\s*)[-*+]\s+/, '$1•  ')
        .replace(/^(\s*)(\d+[.)])\s+/, '$1$2  '));
}

/**
 * A whole note as one markup text, for the desktop stickies: code blocks in
 * monospace, tasks as ☐ and ☑ (done ones struck through), blank lines
 * between paragraphs as one gap. Pictures (tables, images, diagrams,
 * formulas) stay as their Markdown.
 */
export function noteMarkup(text) {
    const lines = [];
    let inFence = false;
    for (const line of text.split('\n')) {
        if (/^\s*```/.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) {
            lines.push(`<tt>${escapeMarkup(line)}</tt>`);
            continue;
        }
        if (!line.trim()) {
            if (lines.length && lines.at(-1) !== '')
                lines.push('');
            continue;
        }
        const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
        if (task) {
            const done = task[2] !== ' ';
            const body = inlineMarkup(task[3]);
            lines.push(`${task[1]}${done ? '☑' : '☐'}  ${done ? `<s>${body}</s>` : body}`);
            continue;
        }
        lines.push(lineMarkup(line));
    }
    while (lines.at(-1) === '')
        lines.pop();
    return lines.join('\n');
}
