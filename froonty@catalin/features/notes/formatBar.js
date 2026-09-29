// SPDX-License-Identifier: GPL-3.0-or-later
// Markdown formatting bar. Each button applies one pure edit from
// markdown.js to the editor's text and selection.

import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Md from './markdown.js';

// Adwaita has no heading or code icons; those use short text labels.
const ACTIONS = [
    {icon: 'format-text-bold-symbolic', name: () => _('Bold'), edit: s => Md.toggleWrap(s, '**')},
    {icon: 'format-text-italic-symbolic', name: () => _('Italic'), edit: s => Md.toggleWrap(s, '_')},
    {icon: 'format-text-strikethrough-symbolic', name: () => _('Strikethrough'), edit: s => Md.toggleWrap(s, '~~')},
    {label: 'H', name: () => _('Heading'), edit: s => Md.toggleLinePrefix(s, '# ')},
    {icon: 'view-list-bullet-symbolic', name: () => _('Bulleted list'), edit: s => Md.toggleLinePrefix(s, '- ')},
    {icon: 'view-list-ordered-symbolic', name: () => _('Numbered list'), edit: s => Md.toggleNumbered(s)},
    {icon: 'checkbox-checked-symbolic', name: () => _('Checklist'), edit: s => Md.toggleLinePrefix(s, '- [ ] ')},
    {label: '</>', name: () => _('Code'), edit: s => Md.toggleWrap(s, '`')},
    {icon: 'insert-link-symbolic', name: () => _('Link'), edit: s => Md.insertLink(s)},
];

export class FormatBar {
    /** @param {Function} onEdit called with an edit function */
    constructor(onEdit) {
        this.actor = new St.BoxLayout({style_class: 'froonty-format-bar'});
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
}
