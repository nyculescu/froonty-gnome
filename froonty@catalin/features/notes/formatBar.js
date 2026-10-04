// SPDX-License-Identifier: GPL-3.0-or-later
// Markdown formatting bar. Each button applies one pure edit from
// markdown.js to the editor's text and selection (formatActions.js, shared
// with the All notes window's bar).
//
// Toggles (every button but Link) show whether their formatting applies at
// the cursor or selection: lit (checked) = on, and a click removes it;
// plain = off, and a click adds it. The view calls update() as the cursor
// moves.

import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {formatActions} from './formatActions.js';

export class FormatBar {
    /** @param {Function} onEdit called with an edit function */
    constructor(onEdit) {
        this.actor = new St.BoxLayout({style_class: 'froonty-format-bar'});
        this._toggles = [];
        for (const action of formatActions(_)) {
            const button = new St.Button({
                style_class: 'froonty-icon-button froonty-format-button',
                accessible_name: action.name,
                can_focus: true,
                child: action.icon
                    ? new St.Icon({icon_name: action.icon})
                    : new St.Label({text: action.label}),
            });
            button.connect('clicked', () => onEdit(action.edit));
            if (action.active) {
                button.add_style_class_name('froonty-toggle');
                this._toggles.push({button, active: action.active});
            }
            this.actor.add_child(button);
        }

        // A view option, not an edit: checked = long lines wrap. The view
        // binds it to the notes-wrap setting.
        this.wrapButton = new St.Button({
            style_class: 'froonty-icon-button froonty-format-button froonty-toggle',
            accessible_name: _('Wrap lines'),
            can_focus: true,
            toggle_mode: true,
            child: new St.Icon({icon_name: 'view-wrapped-symbolic'}),
        });
        this.actor.add_child(this.wrapButton);
    }

    /**
     * Lights the toggles whose formatting applies at the cursor.
     *
     * @param {{text: string, start: number, end: number}} state
     */
    update(state) {
        for (const {button, active} of this._toggles)
            button.checked = active(state);
    }
}
