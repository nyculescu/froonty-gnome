// SPDX-License-Identifier: GPL-3.0-or-later
// Keyboard selection in a read-only St.Entry inside a scroll view (the
// Writing tab's results). Clutter.Text ignores every key while it is not
// editable, so arrows, Home/End, Page Up/Down and their Shift forms did
// nothing there, and a selection dragged past the bottom edge did not
// scroll. Positions are in characters, as Clutter.Text counts them.
//
//   Left/Right          a character (Ctrl: a word)
//   Up/Down             a line (Ctrl: to the paragraph's start or end)
//   Home/End            the line's start or end (Ctrl: the text's)
//   Page Up/Page Down   a page of the scroll view
//   Shift + any above   extends the selection
//   Ctrl+A, Ctrl+C      select all, copy the selection

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {keepCursorVisible} from '../../core/textScroll.js';

const isWord = ch => /[\p{L}\p{N}_]/u.test(ch);

/** The start of the word before `pos` (Ctrl+Left). */
export function wordStart(chars, pos) {
    let i = pos;
    while (i > 0 && !isWord(chars[i - 1]))
        i--;
    while (i > 0 && isWord(chars[i - 1]))
        i--;
    return i;
}

/** The end of the word after `pos` (Ctrl+Right). */
export function wordEnd(chars, pos) {
    let i = pos;
    while (i < chars.length && !isWord(chars[i]))
        i++;
    while (i < chars.length && isWord(chars[i]))
        i++;
    return i;
}

/** Ctrl+Up: this paragraph's start, or the one before's when already there. */
export function paragraphStart(chars, pos) {
    let i = pos;
    while (i > 0 && chars[i - 1] === '\n')
        i--;
    while (i > 0 && chars[i - 1] !== '\n')
        i--;
    return i;
}

/** Ctrl+Down: this paragraph's end, or the next one's when already there. */
export function paragraphEnd(chars, pos) {
    let i = pos;
    while (i < chars.length && chars[i] === '\n')
        i++;
    while (i < chars.length && chars[i] !== '\n')
        i++;
    return i;
}

const KEYS = {
    left: [Clutter.KEY_Left, Clutter.KEY_KP_Left],
    right: [Clutter.KEY_Right, Clutter.KEY_KP_Right],
    up: [Clutter.KEY_Up, Clutter.KEY_KP_Up],
    down: [Clutter.KEY_Down, Clutter.KEY_KP_Down],
    home: [Clutter.KEY_Home, Clutter.KEY_KP_Home],
    end: [Clutter.KEY_End, Clutter.KEY_KP_End],
    pageUp: [Clutter.KEY_Page_Up, Clutter.KEY_KP_Page_Up],
    pageDown: [Clutter.KEY_Page_Down, Clutter.KEY_KP_Page_Down],
};
const keyName = symbol => Object.keys(KEYS).find(name => KEYS[name].includes(symbol)) ?? null;

/**
 * Makes the read-only `entry` (in a box that is `scroll`'s child)
 * navigable with the keyboard, and keeps its caret in view while a
 * selection is made with the keyboard or dragged with the mouse.
 *
 * @param {St.Entry} entry its clutter_text not editable, selectable
 * @param {St.ScrollView} scroll
 */
export function makeNavigable(entry, scroll) {
    const text = entry.clutter_text;
    // The caret shows where Shift+arrows start from.
    text.cursor_visible = true;
    // The x a run of Up/Down keeps to, as in any text editor.
    let goalX = null;

    const follow = () => {
        if (text.has_key_focus())
            keepCursorVisible(entry, scroll);
    };
    // A mouse selection moves the cursor end of it: follow it while it is
    // dragged past an edge.
    text.connect('notify::cursor-position', follow);

    // The position at (x, line under y), clamped to the text.
    const at = (x, y) => text.coords_to_position(Math.max(0, x), Math.max(0, y));
    // Past the end of a wrapped line Pango answers the next line's first
    // position; End stays on this line.
    const lineEnd = (chars, pos, lineY) => {
        if (pos > 0 && pos <= chars.length) {
            const [found, , endY] = text.position_to_coords(pos);
            if (found && endY > lineY && chars[pos - 1] !== '\n')
                return pos - 1;
        }
        return pos;
    };

    text.connect('key-press-event', (actor, event) => {
        const symbol = event.get_key_symbol();
        const state = event.get_state();
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const chars = Array.from(text.text);
        const length = chars.length;
        const norm = pos => (pos < 0 || pos > length ? length : pos);
        const cursor = norm(text.cursor_position);
        const bound = norm(text.selection_bound);

        if (ctrl && [Clutter.KEY_a, Clutter.KEY_A].includes(symbol)) {
            text.cursor_position = length;
            text.selection_bound = 0;
            return Clutter.EVENT_STOP;
        }
        if (ctrl && [Clutter.KEY_c, Clutter.KEY_C, Clutter.KEY_Insert].includes(symbol)) {
            const selected = text.get_selection();
            if (selected)
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, selected);
            return Clutter.EVENT_STOP;
        }

        const name = keyName(symbol);
        if (!name)
            return Clutter.EVENT_PROPAGATE;
        const [ok, x, y, lineHeight] = text.position_to_coords(cursor);
        if (!ok)
            return Clutter.EVENT_PROPAGATE;
        const vertical = ['up', 'down', 'pageUp', 'pageDown'].includes(name) && !ctrl;
        if (!vertical || goalX === null)
            goalX = x;
        const page = Math.max(lineHeight, scroll.vadjustment.page_size - lineHeight);
        const selecting = cursor !== bound;
        let target;
        switch (name) {
        case 'left':
            if (selecting && !shift)
                target = Math.min(cursor, bound);
            else
                target = ctrl ? wordStart(chars, cursor) : cursor - 1;
            break;
        case 'right':
            if (selecting && !shift)
                target = Math.max(cursor, bound);
            else
                target = ctrl ? wordEnd(chars, cursor) : cursor + 1;
            break;
        case 'up':
            target = ctrl ? paragraphStart(chars, cursor)
                : y <= 0 ? 0 : at(goalX, y - lineHeight / 2);
            break;
        case 'down':
            target = ctrl ? paragraphEnd(chars, cursor)
                : y + lineHeight >= text.height ? length : at(goalX, y + lineHeight * 1.5);
            break;
        case 'pageUp':
            target = y - page <= 0 ? 0 : at(goalX, y - page + lineHeight / 2);
            break;
        case 'pageDown':
            target = y + page >= text.height ? length : at(goalX, y + page + lineHeight / 2);
            break;
        case 'home':
            target = ctrl ? 0 : at(0, y + lineHeight / 2);
            break;
        case 'end':
            target = ctrl ? length : lineEnd(chars, at(text.width, y + lineHeight / 2), y);
            break;
        }
        target = Math.max(0, Math.min(length, target));
        // The cursor is the end that moves (set_selection would put it
        // at the selection's start).
        text.cursor_position = target;
        text.selection_bound = shift ? bound : target;
        keepCursorVisible(entry, scroll);
        // At the very start, what sits above the text (a version's
        // label and Copy) comes into view too.
        const above = entry.get_previous_sibling();
        if (target === 0 && above?.visible)
            scroll.vadjustment.value = Math.min(scroll.vadjustment.value, above.y);
        return Clutter.EVENT_STOP;
    });
}
