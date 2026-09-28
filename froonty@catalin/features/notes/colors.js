// SPDX-License-Identifier: GPL-3.0-or-later
// Note colours, in the spirit of Windows Sticky Notes (the values are our
// own pastel approximations, not Microsoft's). Ids only: the colour values
// live in stylesheet.css as .froonty-note-color-<id>, labels in the view.

export const COLOR_IDS = ['yellow', 'green', 'pink', 'purple', 'blue', 'gray', 'charcoal'];

export const DEFAULT_COLOR = 'yellow';

export function isColor(id) {
    return COLOR_IDS.includes(id);
}
