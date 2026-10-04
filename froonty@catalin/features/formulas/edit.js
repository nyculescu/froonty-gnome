// SPDX-License-Identifier: GPL-3.0-or-later
// Editing helpers of the Formulas tab (docs/features/formulas.md §2):
// inserting a palette symbol or a template at the cursor, the copy
// formats, and the recent and favourite lists. Pure, for plain gjs tests.
//
// Positions count characters (Unicode code points), as Clutter.Text's
// cursor and selection do; a negative one means the end of the text.

/** Marks the cursor's place in a snippet (symbols.js, templates.js). */
export const SLOT = '‸';

// A selection longer than this is not saved in the recent list.
export const MAX_SAVED_LENGTH = 2000;
export const RECENT_LIMIT = 20;
export const FAVOURITES_LIMIT = 100;

const chars = text => Array.from(text);

/**
 * Inserts a snippet at the cursor, replacing the selection, if any.
 *
 * The cursor goes to the snippet's first slot (‸), or after it without
 * one. A selection goes into the first slot, and the cursor then to the
 * second (or after the snippet). A command ending in a letter (\alpha)
 * gets a space when a letter follows, so it does not run into it.
 *
 * @param {{text: string, start: number, end: number}} state the text,
 *   selection bound and cursor
 * @param {string} snippet
 * @returns {{text: string, start: number, end: number}} start = end: the
 *   new cursor
 */
export function insertSnippet({text, start, end}, snippet) {
    const all = chars(text);
    const at = p => (p < 0 || p > all.length ? all.length : p);
    const [from, to] = [Math.min(at(start), at(end)), Math.max(at(start), at(end))];
    const selected = all.slice(from, to).join('');
    const after = all.slice(to).join('');

    const parts = snippet.split(SLOT);
    let body, cursor;
    if (parts.length === 1) {
        body = snippet;
        cursor = chars(body).length;
    } else if (!selected) {
        body = parts.join('');
        cursor = chars(parts[0]).length;
    } else {
        // The selection fills the first slot; the cursor goes on.
        const head = parts[0] + selected + parts[1];
        body = head + parts.slice(2).join('');
        cursor = chars(head).length;
    }
    if (/\\[A-Za-z]+$/.test(body) && /^[A-Za-z]/.test(after)) {
        body += ' ';
        if (cursor === chars(body).length - 1)
            cursor++;
    }
    const result = all.slice(0, from).join('') + body + after;
    const position = from + cursor;
    return {text: result, start: position, end: position};
}

/** The text a copy button puts on the clipboard. */
export function copyText(tex, format) {
    const body = tex.trim();
    switch (format) {
    case 'inline':
        return `$${body}$`;
    case 'display':
        return `$$${body}$$`;
    default:
        return body;
    }
}

/**
 * The recent list with tex first; a formula already in it moves up.
 *
 * @param {string[]} list most recent first
 * @param {string} tex
 * @param {number} [limit]
 * @returns {string[]} a new list (the same one when nothing changes)
 */
export function pushRecent(list, tex, limit = RECENT_LIMIT) {
    const body = tex.trim();
    if (!body || body.length > MAX_SAVED_LENGTH || list[0] === body)
        return list;
    return [body, ...list.filter(item => item !== body)].slice(0, limit);
}

/**
 * Stars or unstars a formula.
 *
 * @param {string[]} list newest first
 * @param {string} tex
 * @param {number} [limit] a full list keeps its oldest favourites and
 *   takes no new one
 * @returns {string[]} a new list (the same one when nothing changes)
 */
export function toggleFavourite(list, tex, limit = FAVOURITES_LIMIT) {
    const body = tex.trim();
    if (!body)
        return list;
    if (list.includes(body))
        return list.filter(item => item !== body);
    if (body.length > MAX_SAVED_LENGTH || list.length >= limit)
        return list;
    return [body, ...list];
}

/** Whether tex is starred. */
export function isFavourite(list, tex) {
    return list.includes(tex.trim());
}

/**
 * A MathJax error in plain words, for the line under the preview. Most
 * of MathJax's messages already are ("Missing close brace"); the
 * renderer's own failures get a sentence.
 *
 * @param {string} kind RenderError.kind
 * @param {string} message
 * @returns {string}
 */
export function errorText(kind, message) {
    switch (kind) {
    case 'tex':
        return message.replace(/\.$/, '');
    case 'timeout':
        return 'This formula took too long to draw';
    case 'crashed':
        return 'The renderer stopped while drawing this formula';
    case 'unavailable':
        return 'The renderer is not available';
    default:
        return message;
    }
}
