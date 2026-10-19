// SPDX-License-Identifier: GPL-3.0-or-later
// Every panic button Froonty knows, in the order Settings offers them.
// Pure data, shared by the Shell side (panic/registry.js) and the settings
// window (panic/prefs.js), which cannot load each other's modules.
//
// Adding a panic button: an entry here and a factory in registry.js.
// Titles (and the optional description Settings shows under a title) take
// the caller's gettext, since each side has its own.

export const MAX_PANIC_BUTTONS = 8;

export const PANIC_BUTTONS = [
    {
        id: 'pin-island',
        icon: 'view-pin-symbolic',
        title: _ => _('Keep Froonty on top'),
        description: _ => _('Keeps the island above other windows until you unpin it.'),
    },
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
    {
        // Not an action: Claude's session usage at a glance; a click opens
        // the Claude tab. The icon is bundled (features/claude/icons).
        id: 'claude-session',
        icon: 'froonty-claude-symbolic',
        title: _ => _('Claude session usage'),
    },
    {
        // Not an action: CPU, GPU or RAM load at a glance; a click opens
        // the Btop tab. Its source and icon are chosen in Settings → Btop.
        // The id stays 'cpu-load' so saved bars keep it.
        id: 'cpu-load',
        icon: 'froonty-cpu-symbolic',
        title: _ => _('System resource load'),
    },
    {
        // A CPU or GPU temperature at a glance; its source is selected in
        // Settings → Btop. The icon is bundled with the Btop icons.
        id: 'temperature',
        icon: 'froonty-thermometer-symbolic',
        title: _ => _('Temperature'),
    },
    {
        // Every MPRIS player that plays; a second click resumes the ones it
        // paused (panic/pauseMedia.js, docs/features/media.md).
        id: 'pause-media',
        icon: 'media-playback-pause-symbolic',
        title: _ => _('Pause all media'),
        description: _ => _('Pauses every player that is playing. Click again to resume the ones it paused.'),
    },
    {
        // The cooling pad off and locked there (llano.py lock); a second
        // click unlocks it (panic/fanLock.js, docs/features/fan.md). The
        // icon is bundled (features/fan/icons).
        id: 'fan-lock',
        icon: 'froonty-fan-symbolic',
        title: _ => _('Fan lock'),
        description: _ => _('Turns the cooling pad off and keeps every program that drives it ' +
            'through llano.py from starting it. Click again to unlock it, back to its speed. ' +
            'The pad’s roller still works.'),
    },
    {
        // The Break tab's sit/stand tracker (features/break); the icon is
        // bundled there (features/break/icons).
        id: 'sit-stand',
        icon: 'froonty-stand-symbolic',
        title: _ => _('Sitting or standing'),
        description: _ => _('Switches the Break tab’s sit/stand tracker. Needs the Break tab ' +
            'with sit/stand turned on.'),
    },
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
 * half on each side, and the right one more when the count is odd
 * (1 → 0 + 1, 3 → 1 + 2, 5 → 2 + 3, 7 → 3 + 4).
 *
 * @param {Array} items buttons (or ids) in bar order
 * @returns {Array[]} [left of the date pill, right of it]
 */
export function panicGroups(items) {
    const left = Math.floor(items.length / 2);
    return [items.slice(0, left), items.slice(left)];
}

export function byId(id) {
    return PANIC_BUTTONS.find(b => b.id === id) ?? null;
}
