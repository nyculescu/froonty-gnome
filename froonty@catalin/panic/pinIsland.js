// SPDX-License-Identifier: GPL-3.0-or-later
// Keeps the expanded Shell island visible while the user works elsewhere.

import St from 'gi://St';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const KEY = 'island-pinned';

export class PinIslandButton {
    constructor(title, settings) {
        this._settings = settings;
        this._title = title;
        this.actor = new St.Button({
            style_class: 'froonty-icon-button froonty-panic-button',
            accessible_name: title,
            can_focus: true,
            track_hover: true,
            child: new St.Icon({icon_name: 'view-pin-symbolic'}),
        });
        this.actor.connect('clicked', () =>
            settings.set_boolean(KEY, !settings.get_boolean(KEY)));
        settings.connectObject(`changed::${KEY}`, () => this._sync(), this.actor);
        this._sync();
    }

    destroy() {
        this._settings.disconnectObject(this.actor);
        this.actor.destroy();
    }

    _sync() {
        const pinned = this._settings.get_boolean(KEY);
        this.actor.checked = pinned;
        this.actor.accessible_name = pinned ? _('Froonty is on top') : this._title;
        this.actor.reactive = true;
    }
}
