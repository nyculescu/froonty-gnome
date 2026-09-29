// SPDX-License-Identifier: GPL-3.0-or-later
// Markdown formatting bar. Each button applies one pure edit from
// markdown.js to the editor's text and selection.
//
// Toggles (every button but Link) show whether their formatting applies at
// the cursor or selection: lit (checked) = on, and a click removes it;
// plain = off, and a click adds it. The view calls update() as the cursor
// moves.

import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Md from './markdown.js';

const wrap = marker => ({
    edit: s => Md.toggleWrap(s, marker),
    active: s => Md.isWrapped(s, marker),
});
const prefix = text => ({
    edit: s => Md.toggleLinePrefix(s, text),
    active: s => Md.hasLinePrefix(s, text),
});

// Adwaita has no heading or code icons; those use short text labels.
const ACTIONS = [
    {icon: 'format-text-bold-symbolic', name: () => _('Bold'), ...wrap('**')},
    {icon: 'format-text-italic-symbolic', name: () => _('Italic'), ...wrap('_')},
    {icon: 'format-text-strikethrough-symbolic', name: () => _('Strikethrough'), ...wrap('~~')},
    {label: 'H', name: () => _('Heading'), ...prefix('# ')},
    {icon: 'view-list-bullet-symbolic', name: () => _('Bulleted list'), ...prefix('- ')},
    {
        icon: 'view-list-ordered-symbolic',
        name: () => _('Numbered list'),
        edit: s => Md.toggleNumbered(s),
        active: s => Md.isNumbered(s),
    },
    {icon: 'checkbox-checked-symbolic', name: () => _('Checklist'), ...prefix('- [ ] ')},
    {label: '</>', name: () => _('Code'), ...wrap('`')},
    // An action, not a toggle: it always inserts a new link.
    {icon: 'insert-link-symbolic', name: () => _('Link'), edit: s => Md.insertLink(s)},
];

export class FormatBar {
    /** @param {Function} onEdit called with an edit function */
    constructor(onEdit) {
        this.actor = new St.BoxLayout({style_class: 'froonty-format-bar'});
        this._toggles = [];
        for (const action of ACTIONS) {
            const button = new St.Button({
                style_class: 'froonty-icon-button froonty-format-button',
                accessible_name: action.name(),
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
