// SPDX-License-Identifier: GPL-3.0-or-later
// Where a click on a rendered line falls in its Markdown, so a field opened
// on it (renderer/preview.js) puts the caret there. Pure: no GI.
//
//   sourceColumn(source, shown, column) → the UTF-16 offset in `source`
//       (one Markdown line) of code point `column` of `shown` (the line as
//       drawn). Line markers ("# ", "> ", "- " drawn "•  ", "1. " drawn
//       "1.  ") and inline ones ("**", "`", "](url)") are stepped over.

const SOURCE_MARKER = /^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)?/;
const SHOWN_MARKER = /^\s*(?:•\s+|\d+[.)]\s+)?/;

export function sourceColumn(source, shown, column) {
    let at = SOURCE_MARKER.exec(source)[0].length;
    const marker = [...SHOWN_MARKER.exec(shown)[0]].length;
    // Each drawn character is the next like it in the source; what lies
    // between is markup. One the source lacks (a bullet) moves nothing.
    for (const char of [...shown].slice(marker, Math.max(marker, column))) {
        const next = source.indexOf(char, at);
        if (next >= 0)
            at = next + char.length;
    }
    return at;
}
