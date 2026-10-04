// SPDX-License-Identifier: GPL-3.0-or-later
// Every panic button Froonty knows, in the order Settings offers them.
// Pure data, shared by the Shell side (panic/registry.js) and the settings
// window (panic/prefs.js), which cannot load each other's modules.
//
// Adding a panic button: an entry here and a factory in registry.js.
// Titles (and the optional description Settings shows under a title) take
// the caller's gettext, since each side has its own.

// local:begin local-features (working-tree only; tools/pack-public strips it)
// A working-tree feature's button: localCatalog.js and localFactories.js.
import {LOCAL_PANIC_BUTTONS} from './localCatalog.js';
// local:end local-features

export const MAX_PANIC_BUTTONS = 8;

export const PANIC_BUTTONS = [
    {
        id: 'mute-microphone',
        icon: 'microphone-sensitivity-muted-symbolic',
        title: _ => _('Mute microphone'),
    },
    {
        id: 'mute-sound',
        icon: 'audio-volume-muted-symbolic',
        title: _ => _('Mute sound'),
    },
    // local:begin local-features
    ...LOCAL_PANIC_BUTTONS,
    // local:end local-features
];

/**
 * The configured list as it should be shown: known ids only, no
 * duplicates, at most MAX_PANIC_BUTTONS, order kept.
 *
 * @param {string[]} ids from the panic-buttons setting
 */
export function sanitize(ids) {
    const known = new Set(PANIC_BUTTONS.map(b => b.id));
    return [...new Set(ids)].filter(id => known.has(id)).slice(0, MAX_PANIC_BUTTONS);
}

/**
 * The bar's two groups, on either side of the hub header's date pill:
 * the first half of MAX_PANIC_BUTTONS on its left, the rest on its right,
 * so with fewer buttons the left fills first.
 *
 * @param {Array} items buttons (or ids) in bar order
 * @returns {Array[]} [left of the date pill, right of it]
 */
export function panicGroups(items) {
    const half = MAX_PANIC_BUTTONS / 2;
    return [items.slice(0, half), items.slice(half)];
}

export function byId(id) {
    return PANIC_BUTTONS.find(b => b.id === id) ?? null;
}
