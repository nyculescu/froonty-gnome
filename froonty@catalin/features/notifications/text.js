// SPDX-License-Identifier: GPL-3.0-or-later
// Notifications tab: the hover bubble's text. Pure functions, no GI, so
// they load in plain gjs tests.

/** The bubble's lines are at most this wide, in characters. */
export const BUBBLE_WIDTH = 60;
/** At most this much of a body is shown in the bubble. */
export const BUBBLE_BODY = 600;

/**
 * `text` (one paragraph) in lines of at most `width` characters, broken at
 * spaces; a word longer than a line is cut.
 *
 * @param {string} text
 * @param {number} width
 * @returns {string[]}
 */
export function wrapLines(text, width) {
    const lines = [];
    let line = '';
    for (let word of text.split(/\s+/).filter(Boolean)) {
        while (word.length > width) {
            if (line) {
                lines.push(line);
                line = '';
            }
            lines.push(word.slice(0, width));
            word = word.slice(width);
        }
        if (!word)
            continue;
        if (!line)
            line = word;
        else if (line.length + 1 + word.length <= width)
            line = `${line} ${word}`;
        else {
            lines.push(line);
            line = word;
        }
    }
    if (line)
        lines.push(line);
    return lines;
}

/** `text` cut to at most `max` characters, ending with "…" when cut. */
export function cut(text, max) {
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * The hover bubble: a heading (app and time), the title, then the body,
 * each wrapped; the body cut at BUBBLE_BODY characters.
 *
 * @param {{heading: string, title: string, body: string}} parts plain text
 * @returns {string}
 */
export function bubbleText({heading, title, body}) {
    return [
        ...wrapLines(heading, BUBBLE_WIDTH),
        ...wrapLines(title, BUBBLE_WIDTH),
        ...wrapLines(cut(body, BUBBLE_BODY), BUBBLE_WIDTH),
    ].join('\n');
}
