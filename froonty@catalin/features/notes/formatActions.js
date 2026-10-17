// SPDX-License-Identifier: GPL-3.0-or-later
// The formatting bar's buttons, in order: shared by the island's bar
// (formatBar.js, St) and the All notes window's (allNotesFormatBar.js,
// GTK), and their keyboard shortcuts, shared by both editors. Pure: each
// process passes its own gettext.
//
// Each action applies one pure edit from markdown.js to {text, start, end}.
// Toggles (every action but Link) also say whether their formatting applies
// at the cursor or selection (`active`).

import * as Md from './markdown.js';

const wrap = marker => ({
    edit: s => Md.toggleWrap(s, marker),
    active: s => Md.isWrapped(s, marker),
});
const prefix = text => ({
    edit: s => Md.toggleLinePrefix(s, text),
    active: s => Md.hasLinePrefix(s, text),
});

// The edits by action id, for the buttons and the shortcuts alike.
const EDITS = {
    bold: wrap('**'),
    italic: wrap('_'),
    strikethrough: wrap('~~'),
    heading: prefix('# '),
    bullets: prefix('- '),
    numbered: {edit: s => Md.toggleNumbered(s), active: s => Md.isNumbered(s)},
    checklist: prefix('- [ ] '),
    code: wrap('`'),
    // An action, not a toggle: it always inserts a new link.
    link: {edit: s => Md.insertLink(s)},
};

/**
 * @param {Function} _ the process's gettext
 * @returns {{id: string, icon?: string, label?: string, name: string,
 *   tooltip: string, edit: Function, active?: Function}[]}
 */
export function formatActions(_) {
    // Adwaita has no heading or code icons; those use short text labels.
    // The tooltip names the shortcut (SHORTCUTS below).
    return [
        {id: 'bold', icon: 'format-text-bold-symbolic', name: _('Bold'), tooltip: _('Bold (Ctrl+B)')},
        {id: 'italic', icon: 'format-text-italic-symbolic', name: _('Italic'), tooltip: _('Italic (Ctrl+I)')},
        {
            id: 'strikethrough',
            icon: 'format-text-strikethrough-symbolic',
            name: _('Strikethrough'),
            tooltip: _('Strikethrough (Ctrl+Shift+X)'),
        },
        {id: 'heading', label: 'H', name: _('Heading'), tooltip: _('Heading (Ctrl+Shift+H)')},
        {
            id: 'bullets',
            icon: 'view-list-bullet-symbolic',
            name: _('Bulleted list'),
            tooltip: _('Bulleted list (Ctrl+Shift+8)'),
        },
        {
            id: 'numbered',
            icon: 'view-list-ordered-symbolic',
            name: _('Numbered list'),
            tooltip: _('Numbered list (Ctrl+Shift+7)'),
        },
        {
            id: 'checklist',
            icon: 'checkbox-checked-symbolic',
            name: _('Checklist'),
            tooltip: _('Checklist (Ctrl+Shift+9)'),
        },
        {id: 'code', label: '</>', name: _('Code'), tooltip: _('Code (Ctrl+E)')},
        {id: 'link', icon: 'insert-link-symbolic', name: _('Link'), tooltip: _('Link (Ctrl+K)')},
    ].map(action => ({...action, ...EDITS[action.id]}));
}

/** The MD button's tooltip: what it switches to, and its shortcut. */
export function markdownTooltip(_, source) {
    return source ? _('Show rendered Markdown (Ctrl+Shift+M)') : _('Show Markdown source (Ctrl+Shift+M)');
}

/** The edit of action `id` (formatActions()), for its shortcut. */
export function formatEdit(id) {
    return EDITS[id].edit;
}

// Ctrl plus a key, with or without Shift; 'markdown' is the MD button.
const SHORTCUTS = [
    ['bold', 'b', false], ['italic', 'i', false], ['strikethrough', 'x', true],
    ['heading', 'h', true], ['bullets', '8', true], ['numbered', '7', true],
    ['checklist', '9', true], ['code', 'e', false], ['link', 'k', false],
    ['markdown', 'm', true],
];

// Modifier bits, the same in Clutter and GDK (X11's): Shift, Control, and
// the others a shortcut must not hold (Alt, Mod4, AltGr, Super, Hyper,
// Meta). Caps Lock and Num Lock do not count.
const SHIFT = 1 << 0;
const CONTROL = 1 << 2;
const OTHERS = 1 << 3 | 1 << 6 | 1 << 7 | 1 << 26 | 1 << 27 | 1 << 28;

// Keyvals of letters and digits are their ASCII codes, in Clutter and GDK.
// A digit is also known by its key on the digit row (XKB keycodes 10 for
// 1 up to 18 for 9, from evdev): Shift turns the keyval into the layout's
// symbol there (* on US, ( on German keyboards), which differs by layout
// and can be another digit's symbol (Shift+8 is "(" in German, Shift+9 on
// US), so a shifted digit is never matched by its symbol.
const DIGIT_ROW = 9;

function matches(key, keyval, keycode) {
    if (/\d/.test(key))
        return keyval === key.charCodeAt(0) || keycode === DIGIT_ROW + Number(key);
    return keyval === key.charCodeAt(0) || keyval === key.toUpperCase().charCodeAt(0);
}

/**
 * The shortcut a key press is, as an action id of formatActions() or
 * 'markdown' (the MD button); null for any other key.
 *
 * @param {number} keyval Clutter or GDK keyval
 * @param {number} keycode its hardware keycode
 * @param {number} state its modifier state
 * @returns {?string}
 */
export function formatShortcut(keyval, keycode, state) {
    if (!(state & CONTROL) || state & OTHERS)
        return null;
    const shift = (state & SHIFT) !== 0;
    const found = SHORTCUTS.find(([, key, withShift]) => withShift === shift &&
        matches(key, keyval, keycode));
    return found?.[0] ?? null;
}
