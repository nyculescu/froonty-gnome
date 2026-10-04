// SPDX-License-Identifier: GPL-3.0-or-later
// The panic bar: up to eight quick-action buttons in the hub's header row,
// chosen and ordered in Settings (panic-buttons). Unused slots are not shown.
// Two groups, on either side of the date pill (hubHeader.js places them):
// the first four on its left, the next four on its right, so with fewer
// the left fills first (panicGroups, panic/catalog.js). Each button's name
// shows on hover.

import St from 'gi://St';

import {panicGroups, sanitize} from '../panic/catalog.js';
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
        // Hidden while empty: no spacing for nothing.
        this.groups = [0, 1].map(() => new St.BoxLayout({
            style_class: 'froonty-panic-bar',
            visible: false,
        }));

        settings.connectObject(`changed::${KEY}`, () => this._rebuild(), this);
        this._rebuild();
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._destroyButtons();
        for (const group of this.groups)
            group.destroy();
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
        this._buttons = sanitize(this._settings.get_strv(KEY))
            .map(id => createPanicButton(id, this._actions)).filter(Boolean);
        panicGroups(this._buttons).forEach((buttons, i) => {
            for (const button of buttons) {
                this.groups[i].add_child(button.actor);
                this._tooltip.attach(button.actor, () => button.actor.accessible_name, 'below');
                button.setActive?.(this._shown);
            }
            this.groups[i].visible = buttons.length > 0;
        });
    }

    _destroyButtons() {
        for (const button of this._buttons)
            button.destroy();
        this._buttons = [];
    }
}
