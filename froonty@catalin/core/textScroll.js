// SPDX-License-Identifier: GPL-3.0-or-later
// Keeping the caret of a multi-line St.Entry in view. St.ScrollView does
// not follow a child's cursor, so editors that sit in one (an St.Entry
// inside a vertical St.BoxLayout, the scroll view's child) call this on
// the text's 'cursor-changed' (emitted at the next relayout, when the
// caret's place is known). Used by the Notes editor and, in working-tree
// builds, by others.

import St from 'gi://St';

/**
 * Scrolls `scroll` so that the caret of `entry` is inside its page, a gap
 * away from the top and bottom edges (the entry's bottom padding, so the
 * last line can always scroll that far up), and horizontally when lines
 * do not wrap.
 *
 * @param {St.Entry} entry inside a box that is `scroll`'s child
 * @param {St.ScrollView} scroll
 */
export function keepCursorVisible(entry, scroll) {
    const text = entry.clutter_text;
    let [ok, x, y, lineHeight] = text.position_to_coords(text.cursor_position);
    if (!ok)
        return;
    // Those coordinates are relative to the text, which sits inside the
    // entry's padding; the adjustments scroll the box holding the entry.
    // Ignoring the offset left the last line under the bottom edge.
    x += entry.x + text.x;
    y += entry.y + text.y;

    // Horizontally too, when lines do not wrap (a small margin keeps the
    // caret off the very edge).
    const h = scroll.hadjustment;
    const margin = lineHeight;
    if (x < h.value)
        h.value = Math.max(0, x - margin);
    else if (x + margin > h.value + h.page_size)
        h.value = x + margin - h.page_size;

    // Vertically, keep the cursor line a gap away from the rounded top and
    // bottom edges.
    const gap = entry.peek_theme_node()?.get_padding(St.Side.BOTTOM) ?? 0;
    const v = scroll.vadjustment;
    if (y - gap < v.value)
        v.value = Math.max(0, y - gap);
    else if (y + lineHeight + gap > v.value + v.page_size)
        v.value = y + lineHeight + gap - v.page_size;
}
