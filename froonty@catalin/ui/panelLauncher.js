// SPDX-License-Identifier: GPL-3.0-or-later
// A small top bar icon shown only while the island is not, so Froonty stays
// reachable: it starts Froonty when it waits after login ("Start at login"
// off), and otherwise opens Froonty's settings ("Show island" off).

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const ROLE = 'froonty-launcher';

export class PanelLauncher {
    /**
     * @param {string} title accessible name, says what a click does
     * @param {Function} onActivate
     */
    constructor(title, onActivate) {
        // No menu: a plain button in the top bar's right box.
        this._button = new PanelMenu.Button(0.5, title, true);
        // Puzzle piece: the usual symbol for an extension (user request).
        this._button.add_child(new St.Icon({
            icon_name: 'application-x-addon-symbolic',
            style_class: 'system-status-icon',
        }));
        this._button.connect('button-release-event', () => {
            onActivate();
            return Clutter.EVENT_STOP;
        });
        this._button.connect('key-press-event', (_actor, event) => {
            const key = event.get_key_symbol();
            if (key !== Clutter.KEY_Return && key !== Clutter.KEY_space)
                return Clutter.EVENT_PROPAGATE;
            onActivate();
            return Clutter.EVENT_STOP;
        });
        Main.panel.addToStatusArea(ROLE, this._button, 0, 'right');
    }

    destroy() {
        // The panel drops its statusArea entry on the button's 'destroy'.
        this._button.destroy();
        this._button = null;
    }
}
