// SPDX-License-Identifier: GPL-3.0-or-later
// Markdown formatting edits for the formatting bar. Pure functions on
// {text, start, end}; they return the new text and the new selection.
//
// Positions count characters (Unicode code points), like Clutter.Text,
// not JavaScript UTF-16 units, so emoji do not shift the selection.

/** Wrap the selection in `marker` ("**", "_", "`", "~~"), or unwrap it. */
export function toggleWrap(state, marker) {
    const {chars, start, end} = normalize(state);
    const m = [...marker];
    const inner = chars.slice(start, end);

    // "**word**" selected: unwrap inside the selection.
    if (inner.length >= 2 * m.length && startsWith(inner, m, 0) &&
        startsWith(inner, m, inner.length - m.length)) {
        const text = [...chars.slice(0, start), ...inner.slice(m.length, -m.length),
            ...chars.slice(end)];
        return result(text, start, end - 2 * m.length);
    }

    // "word" selected inside "**word**": unwrap around the selection.
    if (start >= m.length && startsWith(chars, m, start - m.length) &&
        startsWith(chars, m, end)) {
        const text = [...chars.slice(0, start - m.length), ...inner,
            ...chars.slice(end + m.length)];
        return result(text, start - m.length, end - m.length);
    }

    const text = [...chars.slice(0, start), ...m, ...inner, ...m, ...chars.slice(end)];
    return result(text, start + m.length, end + m.length);
}

/**
 * Toggle a prefix ("# ", "- ", "- [ ] ", "> ") on every line the selection
 * touches: removed if all of them have it, added otherwise.
 */
export function toggleLinePrefix(state, prefix) {
    return editLines(state, lines => {
        const all = lines.every(l => l.startsWith(prefix));
        return lines.map(l => all ? l.slice(prefix.length) : `${prefix}${l}`);
    });
}

/** Toggle "1. ", "2. ", … on every line the selection touches. */
export function toggleNumbered(state) {
    const numbered = /^\d+\. /;
    return editLines(state, lines => {
        const all = lines.every(l => numbered.test(l));
        return lines.map((l, i) => all ? l.replace(numbered, '') : `${i + 1}. ${l}`);
    });
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
    const {chars, start, end} = normalize(state);
    // (lastIndexOf with a negative index would count from the end.)
    const lineStart = start > 0 ? chars.lastIndexOf('\n', start - 1) + 1 : 0;
    // A selection ending at the very start of a line does not include it.
    const lastChar = end > start && chars[end - 1] === '\n' ? end - 1 : end;
    let lineEnd = chars.indexOf('\n', lastChar);
    if (lineEnd === -1)
        lineEnd = chars.length;

    const lines = chars.slice(lineStart, lineEnd).join('').split('\n');
    const edited = [...edit(lines).join('\n')];
    const text = [...chars.slice(0, lineStart), ...edited, ...chars.slice(lineEnd)];
    return result(text, lineStart, lineStart + edited.length);
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
