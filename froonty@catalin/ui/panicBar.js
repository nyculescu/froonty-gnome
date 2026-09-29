// SPDX-License-Identifier: GPL-3.0-or-later
// The panic bar: up to five quick-action buttons at the top of the hub,
// chosen and ordered in Settings (panic-buttons). Unused slots are not shown.

import St from 'gi://St';

import {sanitize} from '../panic/catalog.js';
import {createPanicButton} from '../panic/registry.js';

const KEY = 'panic-buttons';

export class PanicBar {
    /** @param {Gio.Settings} settings */
    constructor(settings) {
        this._settings = settings;
        this._buttons = [];
        this.actor = new St.BoxLayout({style_class: 'froonty-panic-bar'});

        settings.connectObject(`changed::${KEY}`, () => this._rebuild(), this);
        this._rebuild();
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._destroyButtons();
        this.actor.destroy();
    }

    _rebuild() {
        this._destroyButtons();
        for (const id of sanitize(this._settings.get_strv(KEY))) {
            const button = createPanicButton(id);
            if (button) {
                this._buttons.push(button);
                this.actor.add_child(button.actor);
            }
        }
    }

    _destroyButtons() {
        for (const button of this._buttons)
            button.destroy();
        this._buttons = [];
    }
}
