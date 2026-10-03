// SPDX-License-Identifier: GPL-3.0-or-later
// The Break tab's icons: four pictograms drawn for Froonty (icons/, laid out
// as an icon theme for the settings window) and GNOME's own eye icon.
// Gio only; made on use, never when the module loads.

import Gio from 'gi://Gio';

export const ICON_NAMES = {
    move: 'froonty-move-symbolic',
    stand: 'froonty-stand-symbolic',
    sit: 'froonty-sit-symbolic',
    rest: 'froonty-rest-symbolic',
};
export const EYES_ICON = 'view-reveal-symbolic';

/** One of the bundled pictograms (move, stand, sit, rest). */
export const bundledIcon = name => new Gio.FileIcon({
    file: Gio.File.new_for_uri(import.meta.url).get_parent().resolve_relative_path(
        `icons/hicolor/scalable/actions/${ICON_NAMES[name]}.svg`),
});

/** The icon of a break type, the long rest or a posture. */
export function subjectIcon(subject) {
    switch (subject) {
    case 'eyesight':
        return new Gio.ThemedIcon({name: EYES_ICON});
    case 'movement':
        return bundledIcon('move');
    case 'standing':
    case 'stand':
        return bundledIcon('stand');
    case 'sitting':
    case 'sit':
        return bundledIcon('sit');
    default:
        return bundledIcon('rest');
    }
}

/** The pill cue's icon (engine.cueModel). */
export function cueIcon(cue) {
    if (cue.kind === 'posture')
        return subjectIcon(cue.posture);
    return subjectIcon(cue.reason === 'long-rest' ? 'long-rest' : cue.type);
}
