// SPDX-License-Identifier: GPL-3.0-or-later
// Panic buttons of the features that are not in the public build yet
// (features/localFeatures.js). tools/pack-public replaces this file with
// an empty list. Pure data, as catalog.js.

export const LOCAL_PANIC_BUTTONS = [
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
        // Not an action: the CPU load at a glance; a click opens the Btop
        // tab. The icon is bundled (features/sysmon/icons).
        id: 'cpu-load',
        icon: 'froonty-cpu-symbolic',
        title: _ => _('CPU load'),
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
        // The Break tab's sit/stand tracker (features/break); the icon is
        // bundled there (features/break/icons).
        id: 'sit-stand',
        icon: 'froonty-stand-symbolic',
        title: _ => _('Sitting or standing'),
        description: _ => _('Switches the Break tab’s sit/stand tracker. Needs the Break tab ' +
            'with sit/stand turned on.'),
    },
];
