// SPDX-License-Identifier: GPL-3.0-or-later
// Markdown formatting edits for the formatting bar. Pure functions on
// {text, start, end}; they return the new text and the new selection.
//
// Positions count characters (Unicode code points), like Clutter.Text,
// not JavaScript UTF-16 units, so emoji do not shift the selection.

/**
 * Wrap the selection in `marker` ("**", "_", "`", "~~"), or unwrap it when
 * isWrapped() says it is wrapped.
 */
export function toggleWrap(state, marker) {
    const {chars, start, end} = normalize(state);
    const m = [...marker];
    const wrap = findWrap(chars, start, end, m);
    if (wrap) {
        const {open, close} = wrap;
        const text = [...chars.slice(0, open), ...chars.slice(open + m.length, close),
            ...chars.slice(close + m.length)];
        // A position moves left by the marker characters removed before it.
        const removedBefore = (p, at) => Math.min(Math.max(p - at, 0), m.length);
        const moved = p => p - removedBefore(p, open) - removedBefore(p, close);
        return result(text, moved(start), moved(end));
    }

    const inner = chars.slice(start, end);
    const text = [...chars.slice(0, start), ...m, ...inner, ...m, ...chars.slice(end)];
    return result(text, start + m.length, end + m.length);
}

/**
 * Whether the selection is formatted with `marker`, so that toggleWrap()
 * removes it: the selection starts and ends with the markers ("**hi**"
 * selected), or a pair of markers on its line encloses it ("hi" selected,
 * or the bare cursor anywhere inside "**hi**").
 */
export function isWrapped(state, marker) {
    const {chars, start, end} = normalize(state);
    return findWrap(chars, start, end, [...marker]) !== null;
}

/**
 * Toggle a prefix ("# ", "- ", "- [ ] ", "> ") on every line the selection
 * touches: removed if all of them have it (hasLinePrefix), added otherwise.
 */
export function toggleLinePrefix(state, prefix) {
    return editLines(state, lines => {
        const all = lines.every(l => l.startsWith(prefix));
        return lines.map(l => all ? l.slice(prefix.length) : `${prefix}${l}`);
    });
}

/** Whether every line the selection touches starts with `prefix`. */
export function hasLinePrefix(state, prefix) {
    return selectedLines(state).lines.every(l => l.startsWith(prefix));
}

const NUMBERED = /^\d+\. /;

/** Toggle "1. ", "2. ", … on every line the selection touches. */
export function toggleNumbered(state) {
    return editLines(state, lines => {
        const all = lines.every(l => NUMBERED.test(l));
        return lines.map((l, i) => all ? l.replace(NUMBERED, '') : `${i + 1}. ${l}`);
    });
}

/** Whether every line the selection touches is numbered ("1. "). */
export function isNumbered(state) {
    return selectedLines(state).lines.every(l => NUMBERED.test(l));
}

/** Insert "[label](https://)" around the selection and select the URL. */
export function insertLink(state) {
    const {chars, start, end} = normalize(state);
    const label = start === end ? [...'link'] : chars.slice(start, end);
    const url = [...'https://'];
    const before = [...chars.slice(0, start), '[', ...label, ...']('];
    const text = [...before, ...url, ')', ...chars.slice(end)];
    return result(text, before.length, before.length + url.length);
}

// Applies `edit` to the full lines covered by the selection and selects
// the edited block.
function editLines(state, edit) {
    const {chars, lineStart, lineEnd, lines} = selectedLines(state);
    const edited = [...edit(lines).join('\n')];
    const text = [...chars.slice(0, lineStart), ...edited, ...chars.slice(lineEnd)];
    return result(text, lineStart, lineStart + edited.length);
}

// The full lines covered by the selection.
function selectedLines(state) {
    const {chars, start, end} = normalize(state);
    // A selection ending at the very start of a line does not include it.
    const lastChar = end > start && chars[end - 1] === '\n' ? end - 1 : end;
    const lineStart = lineBounds(chars, start)[0];
    const lineEnd = lineBounds(chars, lastChar)[1];
    const lines = chars.slice(lineStart, lineEnd).join('').split('\n');
    return {chars, lineStart, lineEnd, lines};
}

// [start, end) of the line holding position `at`, without its newline.
function lineBounds(chars, at) {
    // (lastIndexOf with a negative index would count from the end.)
    const start = at > 0 ? chars.lastIndexOf('\n', at - 1) + 1 : 0;
    const end = chars.indexOf('\n', at);
    return [start, end === -1 ? chars.length : end];
}

// The marker pair toggleWrap() removes, as the positions of the opening and
// closing marker, or null. Markers pair up left to right within a line, so
// the "**" between "**a** and **b**" does not count as enclosing.
function findWrap(chars, start, end, m) {
    const n = m.length;
    if (end - start >= 2 * n && startsWith(chars, m, start) && startsWith(chars, m, end - n))
        return {open: start, close: end - n};

    const [lineStart, lineEnd] = lineBounds(chars, start);
    if (end > lineEnd)
        return null;
    let open = null;
    for (let i = lineStart; i + n <= lineEnd;) {
        if (!startsWith(chars, m, i)) {
            i++;
            continue;
        }
        if (open === null) {
            open = i;
        } else {
            if (open + n <= start && end <= i)
                return {open, close: i};
            open = null;
        }
        i += n;
    }
    return null;
}

function normalize({text, start, end}) {
    const chars = [...text];
    const clamp = n => Math.max(0, Math.min(chars.length, n));
    const [a, b] = [clamp(start), clamp(end)];
    return {chars, start: Math.min(a, b), end: Math.max(a, b)};
}

function startsWith(chars, marker, at) {
    return marker.every((c, i) => chars[at + i] === c);
}

function result(chars, start, end) {
    return {text: chars.join(''), start, end};
}
