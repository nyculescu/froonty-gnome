// SPDX-License-Identifier: GPL-3.0-or-later
// Panic button "Block camera for apps that ask GNOME": turns GNOME's own
// Camera Access switch (Settings → Privacy & Security → Cameras) off and
// on again. Checked (red) while camera access is off; insensitive when an
// administrator has locked the switch. Event-driven: follows the switch,
// whoever turns it.
//
// Not a hardware cut-off: only apps that ask the camera portal are
// refused, and a camera already in use stays on (panic/cameraAccess.js).

import St from 'gi://St';

import {CameraAccess} from './cameraAccess.js';

const ICONS = {allowed: 'camera-web-symbolic', blocked: 'camera-disabled-symbolic'};

export class CameraBlockButton {
    /**
     * @param {string} title accessible name
     */
    constructor(title) {
        this.actor = new St.Button({
            style_class: 'froonty-icon-button froonty-panic-button',
            accessible_name: title,
            can_focus: true,
            track_hover: true,
            child: new St.Icon(),
        });
        this._access = new CameraAccess(() => this._sync());
        this.actor.connect('clicked', () => this._access.toggle());
        this._sync();
    }

    destroy() {
        this._access.destroy();
        this.actor.destroy();
    }

    _sync() {
        const blocked = this._access.blocked;
        this.actor.checked = blocked;
        this.actor.reactive = this._access.usable;
        this.actor.child.icon_name = blocked ? ICONS.blocked : ICONS.allowed;
    }
}
