// SPDX-License-Identifier: GPL-3.0-or-later
// Every panic button Froonty knows, in the order Settings offers them.
// Pure data, shared by the Shell side (panic/registry.js) and the settings
// window (panic/prefs.js), which cannot load each other's modules.
//
// Adding a panic button: an entry here, a factory in registry.js (for a
// working-tree feature's button: localCatalog.js and localFactories.js,
// which the public build replaces with empty ones).
// Titles (and the optional description Settings shows under a title) take
// the caller's gettext, since each side has its own.

import {LOCAL_PANIC_BUTTONS} from './localCatalog.js';

export const MAX_PANIC_BUTTONS = 5;

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
    ...LOCAL_PANIC_BUTTONS,
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

export function byId(id) {
    return PANIC_BUTTONS.find(b => b.id === id) ?? null;
}
