// SPDX-License-Identifier: GPL-3.0-or-later
// The clipboard switcher's logic (docs/features/clipboard.md, "Switcher"):
// stepping through the history, where the pop-up goes, whether the focused
// app is a terminal, and the bookkeeping behind GNOME's own Super+V
// (toggle-message-tray). Pure functions, no GI, so they load in plain gjs
// tests.

// GNOME's notification list keeps (or gets) this one while the switcher
// has Super+V.
export const TRAY_FALLBACK = '<Super>m';

/**
 * The next item: older (index + 1) or, `backward`, newer. Wraps at both
 * ends, as Alt+Tab does; the pop-up's "14 / 14" then "1 / 14" shows it.
 */
export function stepIndex(index, count, backward = false) {
    if (count <= 0)
        return 0;
    return (index + (backward ? -1 : 1) + count) % count;
}

// GTK's modifier names and their aliases, as GNOME's settings spell them.
const MODIFIER_ALIASES = {
    mod4: 'super', ctrl: 'control', primary: 'control', mod1: 'alt', meta: 'meta',
};

/**
 * One spelling per shortcut, so '<Mod4>V' and '<Super>v' compare equal:
 * modifiers lower case, aliases resolved and sorted, the key lower case.
 */
export function normalizeAccelerator(accelerator) {
    const modifiers = [];
    const key = String(accelerator).trim().replace(/<([^>]+)>/g, (_match, name) => {
        const lower = name.toLowerCase();
        modifiers.push(MODIFIER_ALIASES[lower] ?? lower);
        return '';
    }).trim().toLowerCase();
    return `${[...new Set(modifiers)].sort().map(m => `<${m}>`).join('')}${key}`;
}

const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * GNOME's toggle-message-tray without the switcher's shortcuts, and with
 * Super+M (unless that is the switcher's own), so the notification list
 * keeps a shortcut and the two never share a key.
 *
 * @param {string[]} binding toggle-message-tray now
 * @param {string[]} shortcuts the switcher's shortcuts
 */
export function adjustTrayBinding(binding, shortcuts) {
    const taken = new Set(shortcuts.map(normalizeAccelerator).filter(Boolean));
    const kept = binding.filter(accelerator => !taken.has(normalizeAccelerator(accelerator)));
    const fallback = normalizeAccelerator(TRAY_FALLBACK);
    if (!taken.has(fallback) && !kept.some(accelerator => normalizeAccelerator(accelerator) === fallback))
        kept.push(TRAY_FALLBACK);
    return kept;
}

// What Froonty remembers of toggle-message-tray while the switcher is on
// (clipboard-switcher-tray-backup): the user's value before the change
// (null: GNOME's default, no value of the user's) and what Froonty wrote.
// '' while the switcher is off.

/** @returns {?{original: ?string[], written: string[]}} null when none or damaged */
export function parseTrayRecord(text) {
    if (!text)
        return null;
    try {
        const {original, written} = JSON.parse(text);
        const strings = list => Array.isArray(list) && list.every(s => typeof s === 'string');
        if ((original !== null && !strings(original)) || !strings(written))
            return null;
        return {original, written};
    } catch (e) {
        return null;
    }
}

export function formatTrayRecord(record) {
    return record ? JSON.stringify({original: record.original, written: record.written}) : '';
}

/**
 * The switcher turns on. Changed once: with a record already there (the
 * extension disabled and enabled again, as at every screen lock) nothing
 * happens.
 *
 * @param {?object} record the remembered state, or null
 * @param {object} gnome toggle-message-tray: {value, isDefault}
 * @param {string[]} shortcuts the switcher's shortcuts
 * @returns {{write: ?string[], record: ?object}} write: the new value, if any
 */
export function trayOnPlan(record, {value, isDefault}, shortcuts) {
    if (record)
        return {write: null, record};
    const written = adjustTrayBinding(value, shortcuts);
    return {
        write: sameList(written, value) ? null : written,
        record: {original: isDefault ? null : value, written},
    };
}

/**
 * The switcher's shortcut changed while it is on: Froonty's value follows
 * it, from the user's original, unless the user changed GNOME's key since
 * (then it is theirs and stays).
 *
 * @param {object} gnome {value, defaultValue}
 */
export function trayShortcutPlan(record, {value, defaultValue}, shortcuts) {
    if (!record || !sameList(value, record.written))
        return {write: null, record};
    const written = adjustTrayBinding(record.original ?? defaultValue, shortcuts);
    return {write: sameList(written, value) ? null : written, record: {...record, written}};
}

/**
 * The switcher turns off: the user's value comes back, unless they changed
 * GNOME's key since Froonty wrote it. The record goes either way.
 *
 * @returns {{action: 'none'} | {action: 'reset'} | {action: 'set', value: string[]}}
 */
export function trayOffPlan(record, {value}) {
    if (!record || !sameList(value, record.written))
        return {action: 'none'};
    return record.original === null ? {action: 'reset'} : {action: 'set', value: record.original};
}

// Terminals, which paste with Ctrl+Shift+V (Ctrl+V is a key for the
// program running in them). Matched against the focused window's app id
// (".desktop" dropped), its window classes and its Flatpak app id, ignoring
// case: whole ids, or whole names or the last part of a dotted id.
const TERMINAL_IDS = [
    'org.gnome.terminal', 'org.gnome.console', 'org.gnome.ptyxis', 'org.gnome.ptyxis.devel',
    'app.devsuite.ptyxis', 'io.elementary.terminal', 'com.system76.cosmicterm',
];
const TERMINAL_NAMES = [
    'gnome-terminal', 'gnome-terminal-server', 'kgx', 'ptyxis', 'tilix', 'konsole', 'yakuake',
    'alacritty', 'kitty', 'foot', 'footclient', 'wezterm', 'wezterm-gui', 'terminator', 'blackbox',
    'xfce4-terminal', 'mate-terminal', 'lxterminal', 'qterminal', 'deepin-terminal', 'cosmic-term',
    'guake', 'tilda', 'terminology', 'sakura', 'ghostty', 'contour', 'rio', 'warp', 'tabby',
    'xterm', 'uxterm', 'urxvt', 'rxvt', 'st', 'st-256color', 'zutty', 'cool-retro-term',
];

/**
 * Whether the focused app is a terminal: its text field says so (the
 * input method's content purpose; VTE sets it), or it is a known one.
 *
 * @param {string[]} names what the focused window says it is
 * @param {boolean} [terminalPurpose] the text field's purpose is "terminal"
 */
export function isTerminal(names, terminalPurpose = false) {
    if (terminalPurpose)
        return true;
    return names.filter(Boolean).some(name => {
        const id = String(name).toLowerCase().replace(/\.desktop$/, '');
        return TERMINAL_IDS.includes(id) || TERMINAL_NAMES.includes(id) ||
            TERMINAL_NAMES.includes(id.split('.').pop());
    });
}

/** The keys that paste: Ctrl+V, or Ctrl+Shift+V in a terminal (Clutter key names). */
export function pasteKeys(terminal) {
    return terminal ? ['Control_L', 'Shift_L', 'v'] : ['Control_L', 'v'];
}

/**
 * Where the pop-up goes, in stage pixels: its left edge under the text
 * cursor and just below it, or above it when there is no room below;
 * always inside the monitor (`margin` from its edges). With `centre`, the
 * pop-up is centred on the anchor instead (a window's middle).
 *
 * @param {{x, y, width, height}} anchor the text cursor, pointer or window centre
 * @param {{width, height}} size the pop-up's
 * @param {{x, y, width, height}} monitor the anchor's monitor
 * @returns {{x: number, y: number, below: boolean}}
 */
export function popupPlacement(anchor, size, monitor, {gap = 6, margin = 8, centre = false} = {}) {
    const clamp = (v, min, max) => Math.max(min, Math.min(v, Math.max(min, max)));
    const left = monitor.x + margin;
    const right = monitor.x + monitor.width - margin - size.width;
    const top = monitor.y + margin;
    const bottom = monitor.y + monitor.height - margin - size.height;
    if (centre) {
        return {
            x: Math.round(clamp(anchor.x + (anchor.width - size.width) / 2, left, right)),
            y: Math.round(clamp(anchor.y + (anchor.height - size.height) / 2, top, bottom)),
            below: true,
        };
    }
    const x = Math.round(clamp(anchor.x, left, right));
    const below = anchor.y + anchor.height + gap;
    if (below <= bottom)
        return {x, y: Math.round(below), below: true};
    const above = anchor.y - gap - size.height;
    if (above >= top)
        return {x, y: Math.round(above), below: false};
    return {x, y: Math.round(clamp(below, top, bottom)), below: true};
}
