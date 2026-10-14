// SPDX-License-Identifier: GPL-3.0-or-later
// Markdown formatting bar. Each button applies one pure edit from
// markdown.js to the editor's text and selection (formatActions.js, shared
// with the All notes window's bar).
//
// Formatting toggles show whether their formatting applies at the cursor or
// selection. The MD toggle switches between source and preview without
// editing the note. The view calls update() as the cursor moves.

import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {formatActions} from './formatActions.js';

export class FormatBar {
    /** @param {Function} onEdit called with an edit function */
    constructor(onEdit, onImage = () => {}) {
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

        const imageButton = new St.Button({
            style_class: 'froonty-icon-button froonty-format-button',
            accessible_name: _('Insert image'),
            can_focus: true,
            child: new St.Icon({icon_name: 'insert-image-symbolic'}),
        });
        imageButton.connect('clicked', onImage);
        this.actor.add_child(imageButton);

        this.markdownButton = new St.Button({
            style_class: 'froonty-icon-button froonty-format-button froonty-toggle',
            accessible_name: _('Show Markdown source'),
            can_focus: true,
            toggle_mode: true,
            child: new St.Label({text: 'MD'}),
        });
        this.actor.add_child(this.markdownButton);

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

    setMarkdownSource(source) {
        this.markdownButton.checked = source;
        const name = source ? _('Show rendered Markdown') : _('Show Markdown source');
        this.markdownButton.accessible_name = name;
        this.markdownButton.tooltip_text = name;
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
