// SPDX-License-Identifier: GPL-3.0-or-later
// The panic bar: up to five quick-action buttons at the top of the hub,
// chosen and ordered in Settings (panic-buttons). Unused slots are not shown.
// Centered in the island by the hub; each button's name shows on hover.

import St from 'gi://St';

import {sanitize} from '../panic/catalog.js';
import {createPanicButton} from '../panic/registry.js';

const KEY = 'panic-buttons';

export class PanicBar {
    /**
     * @param {Gio.Settings} settings
     * @param {Tooltip} tooltip shows each button's name on hover
     * @param {object} actions passed to each button (panic/registry.js)
     */
    constructor(settings, tooltip, actions) {
        this._settings = settings;
        this._tooltip = tooltip;
        this._actions = actions;
        this._buttons = [];
        this._shown = false;
        this.actor = new St.BoxLayout({style_class: 'froonty-panic-bar'});

        settings.connectObject(`changed::${KEY}`, () => this._rebuild(), this);
        this._rebuild();
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._destroyButtons();
        this.actor.destroy();
    }

    /** Tells the buttons whether the hub is on screen. */
    setShown(shown) {
        this._shown = shown;
        for (const button of this._buttons)
            button.setActive?.(shown);
    }

    _rebuild() {
        this._tooltip.hide();
        this._destroyButtons();
        for (const id of sanitize(this._settings.get_strv(KEY))) {
            const button = createPanicButton(id, this._actions);
            if (button) {
                this._buttons.push(button);
                this.actor.add_child(button.actor);
                this._tooltip.attach(button.actor, () => button.actor.accessible_name, 'below');
                button.setActive?.(this._shown);
            }
        }
    }

    _destroyButtons() {
        for (const button of this._buttons)
            button.destroy();
        this._buttons = [];
    }
}
