// SPDX-License-Identifier: GPL-3.0-or-later
// Registers the island with the Shell: as chrome (above windows, hidden
// over fullscreen windows) and as a Ctrl+Alt+Tab group, like the top bar.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

/**
 * @param {St.Widget} strip full-width, click-through container
 * @param {St.Widget} pill the only part that takes input
 * @param {Function} expand called when chosen in Ctrl+Alt+Tab
 */
export function addIslandChrome(strip, pill, expand) {
    Main.layoutManager.addChrome(strip, {
        affectsInputRegion: false,
        trackFullscreen: true,
    });
    Main.layoutManager.trackChrome(pill, {affectsInputRegion: true});

    Main.ctrlAltTabManager.addGroup(pill, _('Froonty'), 'x-office-calendar-symbolic', {
        focusCallback: expand,
    });
}

/**
 * Undoes the Ctrl+Alt+Tab group. The chrome entries go away by themselves
 * when the actors are destroyed (LayoutManager listens for 'destroy').
 *
 * @param {St.Widget} pill
 */
export function removeIslandChrome(pill) {
    Main.ctrlAltTabManager.removeGroup(pill);
}
