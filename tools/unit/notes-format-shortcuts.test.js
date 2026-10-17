// SPDX-License-Identifier: GPL-3.0-or-later
// Notes: the formatting shortcuts (formatActions.js formatShortcut), shared
// by the island and the All notes window: Ctrl plus a key, with or without
// Shift, and a shifted digit known by its key whatever symbol it types.

import {formatActions, formatEdit, formatShortcut, markdownTooltip} from
    '../../froonty@catalin/features/notes/formatActions.js';
import {done, eq, ok, test} from './test.js';

// X11 modifier bits and keysyms, as Clutter and GDK give them.
const SHIFT = 1;
const LOCK = 2;
const CTRL = 4;
const ALT = 8;
const NUM_LOCK = 16;
const SUPER = 1 << 26;
const key = ch => ch.charCodeAt(0);
// Keycodes on the digit row (XKB, from evdev): 7, 8, 9; and the B key.
const KEY_7 = 16;
const KEY_8 = 17;
const KEY_9 = 18;
const KEY_B = 56;

test('format shortcuts: Ctrl plus a letter, with or without Shift', () => {
    eq(formatShortcut(key('b'), KEY_B, CTRL), 'bold');
    eq(formatShortcut(key('i'), 31, CTRL), 'italic');
    eq(formatShortcut(key('X'), 53, CTRL | SHIFT), 'strikethrough', 'Shift gives the capital');
    eq(formatShortcut(key('H'), 43, CTRL | SHIFT), 'heading');
    eq(formatShortcut(key('e'), 26, CTRL), 'code');
    eq(formatShortcut(key('k'), 45, CTRL), 'link');
    eq(formatShortcut(key('M'), 58, CTRL | SHIFT), 'markdown');
    eq(formatShortcut(key('B'), KEY_B, CTRL | LOCK), 'bold', 'Caps Lock: a capital, still Ctrl+B');
    eq(formatShortcut(key('b'), KEY_B, CTRL | NUM_LOCK), 'bold', 'Num Lock does not count');
});

test('format shortcuts: Shift and the other modifiers must match', () => {
    eq(formatShortcut(key('b'), KEY_B, 0), null, 'no Ctrl');
    eq(formatShortcut(key('B'), KEY_B, CTRL | SHIFT), null, 'Ctrl+Shift+B is not Bold');
    eq(formatShortcut(key('x'), 53, CTRL), null, 'Ctrl+X stays Cut');
    eq(formatShortcut(key('m'), 58, CTRL), null, 'Ctrl+M is not MD');
    eq(formatShortcut(key('b'), KEY_B, CTRL | ALT), null, 'Ctrl+Alt+B');
    eq(formatShortcut(key('b'), KEY_B, CTRL | SUPER), null, 'Super+Ctrl+B');
    for (const letter of 'acvyz')
        eq(formatShortcut(key(letter), 0, CTRL), null, `Ctrl+${letter.toUpperCase()} is left alone`);
    eq(formatShortcut(key('Z'), 0, CTRL | SHIFT), null, 'Ctrl+Shift+Z (redo)');
});

test('format shortcuts: Ctrl+Shift+8, 7, 9 by their keys, whatever the layout types', () => {
    // US: Shift+8 types *, Shift+7 &, Shift+9 (.
    eq(formatShortcut(key('*'), KEY_8, CTRL | SHIFT), 'bullets');
    eq(formatShortcut(key('&'), KEY_7, CTRL | SHIFT), 'numbered');
    eq(formatShortcut(key('('), KEY_9, CTRL | SHIFT), 'checklist');
    // German: Shift+8 types (, Shift+9 ), Shift+7 /.
    eq(formatShortcut(key('('), KEY_8, CTRL | SHIFT), 'bullets', '"(" on the 8 key is not Checklist');
    eq(formatShortcut(key(')'), KEY_9, CTRL | SHIFT), 'checklist');
    eq(formatShortcut(key('/'), KEY_7, CTRL | SHIFT), 'numbered');
    // French: Shift on the digit row types the digit.
    eq(formatShortcut(key('8'), KEY_8, CTRL | SHIFT), 'bullets');
    eq(formatShortcut(key('8'), 0, CTRL | SHIFT), 'bullets', 'the digit keyval, from any key');
    eq(formatShortcut(key('*'), 63, CTRL | SHIFT), null, 'keypad * is no digit');
    eq(formatShortcut(key('8'), KEY_8, CTRL), null, 'without Shift');
});

test('format shortcuts: every bar action has one, named in its tooltip', () => {
    const actions = formatActions(s => s);
    eq(actions.map(a => a.id), ['bold', 'italic', 'strikethrough', 'heading', 'bullets', 'numbered',
        'checklist', 'code', 'link']);
    eq(actions.map(a => a.tooltip), ['Bold (Ctrl+B)', 'Italic (Ctrl+I)', 'Strikethrough (Ctrl+Shift+X)',
        'Heading (Ctrl+Shift+H)', 'Bulleted list (Ctrl+Shift+8)', 'Numbered list (Ctrl+Shift+7)',
        'Checklist (Ctrl+Shift+9)', 'Code (Ctrl+E)', 'Link (Ctrl+K)']);
    ok(actions.every(a => a.tooltip.startsWith(`${a.name} (`)));
    eq(markdownTooltip(s => s, false), 'Show Markdown source (Ctrl+Shift+M)');
    eq(markdownTooltip(s => s, true), 'Show rendered Markdown (Ctrl+Shift+M)');
});

test('format shortcuts: a shortcut applies its button\'s edit', () => {
    const actions = formatActions(s => s);
    const state = {text: 'say hi now', start: 4, end: 6};
    for (const action of actions)
        eq(formatEdit(action.id)(state), action.edit(state), action.id);
    eq(formatEdit('bold')(state), {text: 'say **hi** now', start: 6, end: 8});
    eq(formatEdit('bold')({text: 'say **hi** now', start: 6, end: 8}), state, 'again: off');
    eq(formatEdit('bullets')(state).text, '- say hi now');
    eq(formatEdit('link')(state), {text: 'say [hi](https://) now', start: 9, end: 17});
});

await done();
