// SPDX-License-Identifier: GPL-3.0-or-later
// Every panic button Froonty knows, in the order Settings offers them.
// Pure data, shared by the Shell side (panic/registry.js) and the settings
// window (panic/prefs.js), which cannot load each other's modules.
//
// Adding a panic button: an entry here, a factory in registry.js.
// Titles (and the optional description Settings shows under a title) take
// the caller's gettext, since each side has its own.

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
    {
        // Not an action: Claude's session usage at a glance; a click opens
        // the Claude tab. The icon is bundled (features/claude/icons).
        id: 'claude-session',
        icon: 'froonty-claude-symbolic',
        title: _ => _('Claude session usage'),
    },
    // The camera button is switched off for now; its code stays in
    // panic/camera.js and panic/cameraAccess.js. Uncomment to offer it again
    // (docs/features/panic-buttons.md §4).
    // {
    //     // GNOME's Camera Access switch; only the camera portal enforces it,
    //     // so the title and description say whom it stops
    //     // (panic/cameraAccess.js).
    //     id: 'block-camera',
    //     icon: 'camera-disabled-symbolic',
    //     title: _ => _('Block camera for apps that ask GNOME'),
    //     description: _ => _('Turns off Camera Access, as Settings → Privacy & Security → ' +
    //         'Cameras does. Apps that ask GNOME for the camera (mostly Flatpak apps) are ' +
    //         'refused. Apps that open the camera directly, as apps that are not sandboxed ' +
    //         'can, are not blocked, and a camera already in use stays on.'),
    // },
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
