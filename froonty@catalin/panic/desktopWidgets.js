// SPDX-License-Identifier: GPL-3.0-or-later
// The desktop widgets in three states, a click going to the next (owner's
// request 2026-11-23): shown with scrolling and clicks (Markets' rows and
// Horizon's headlines open their pages), shown with scrolling only, then
// hidden. The same settings as Settings → Widgets → On the desktop:
// widgets-desktop-enabled and widgets-desktop-actions
// (features/widgets/desktopLayer.js). Checked while hidden.

import St from 'gi://St';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const ENABLED = 'widgets-desktop-enabled';
const ACTIONS = 'widgets-desktop-actions';

const ICONS = {
    active: 'user-desktop-symbolic',
    scroll: 'view-reveal-symbolic',
    hidden: 'view-conceal-symbolic',
};

/** The state the settings make: 'active', 'scroll' or 'hidden'. */
export function desktopWidgetsState(enabled, actions) {
    if (!enabled)
        return 'hidden';
    return actions ? 'active' : 'scroll';
}

export class DesktopWidgetsButton {
    constructor(title, settings) {
        this._settings = settings;
        this.actor = new St.Button({
            style_class: 'froonty-icon-button froonty-panic-button',
            accessible_name: title,
            can_focus: true,
            track_hover: true,
            child: new St.Icon({icon_name: ICONS.active}),
        });
        this.actor.connect('clicked', () => this._next());
        settings.connectObject(
            `changed::${ENABLED}`, () => this._sync(),
            `changed::${ACTIONS}`, () => this._sync(),
            this.actor);
        this._sync();
    }

    destroy() {
        this._settings.disconnectObject(this.actor);
        this.actor.destroy();
    }

    _state() {
        return desktopWidgetsState(this._settings.get_boolean(ENABLED), this._settings.get_boolean(ACTIONS));
    }

    // Shown with clicks → scrolling only → hidden → shown with clicks.
    _next() {
        switch (this._state()) {
        case 'active':
            this._settings.set_boolean(ACTIONS, false);
            break;
        case 'scroll':
            this._settings.set_boolean(ENABLED, false);
            break;
        default:
            // Clicks first: they come back as they were left.
            this._settings.set_boolean(ACTIONS, true);
            this._settings.set_boolean(ENABLED, true);
        }
    }

    _sync() {
        const state = this._state();
        this.actor.child.icon_name = ICONS[state];
        this.actor.checked = state === 'hidden';
        this.actor.accessible_name = {
            active: _('Desktop widgets: scrolling and clicks. Click for scrolling only'),
            scroll: _('Desktop widgets: scrolling only. Click to hide them'),
            hidden: _('Desktop widgets hidden. Click to show them'),
        }[state];
    }
}
