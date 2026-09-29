// SPDX-License-Identifier: GPL-3.0-or-later
// A small top bar icon shown only while the island is hidden ("Show island"
// off), so Froonty stays reachable: clicking it opens Froonty's settings.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const ROLE = 'froonty-launcher';

export class PanelLauncher {
    /** @param {Function} onActivate */
    constructor(onActivate) {
        // No menu: a plain button in the top bar's right box.
        this._button = new PanelMenu.Button(0.5, _('Froonty settings'), true);
        this._button.add_child(new St.Icon({
            icon_name: 'preferences-system-time-symbolic',
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
