// SPDX-License-Identifier: GPL-3.0-or-later
// Markdown formatting bar. Each button applies one pure edit from
// markdown.js to the editor's text and selection (formatActions.js, shared
// with the All notes window's bar).
//
// Formatting toggles show whether their formatting applies at the cursor or
// selection. Insert image runs the view's image chooser. The MD toggle
// switches between source and preview without editing the note. The view
// calls update() as the cursor moves, and setEditable() for the mode.
// Hovered, a button names itself and its shortcut (the view has the keys).

import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {formatActions, markdownTooltip} from './formatActions.js';

export class FormatBar {
    /**
     * @param {Function} onEdit called with an edit function
     * @param {Function} onImage called by Insert image
     * @param {Tooltip} tooltip shows the buttons' tooltips
     */
    constructor(onEdit, onImage, tooltip) {
        this.actor = new St.BoxLayout({style_class: 'froonty-format-bar'});
        this._toggles = [];
        this._edits = [];
        this._editable = true;
        for (const action of formatActions(_)) {
            const button = new St.Button({
                style_class: 'froonty-icon-button froonty-format-button',
                accessible_name: action.name,
                can_focus: true,
                track_hover: true,
                child: action.icon
                    ? new St.Icon({icon_name: action.icon})
                    : new St.Label({text: action.label}),
            });
            tooltip.attach(button, () => action.tooltip);
            button.connect('clicked', () => onEdit(action.edit));
            this._edits.push(button);
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
            track_hover: true,
            child: new St.Icon({icon_name: 'insert-image-symbolic'}),
        });
        tooltip.attach(imageButton, () => imageButton.accessible_name);
        imageButton.connect('clicked', onImage);
        this._edits.push(imageButton);
        this.actor.add_child(imageButton);

        this.markdownButton = new St.Button({
            style_class: 'froonty-icon-button froonty-format-button froonty-toggle',
            accessible_name: _('Show Markdown source'),
            can_focus: true,
            track_hover: true,
            toggle_mode: true,
            child: new St.Label({text: 'MD'}),
        });
        this._markdownTooltip = markdownTooltip(_, false);
        tooltip.attach(this.markdownButton, () => this._markdownTooltip);
        this.actor.add_child(this.markdownButton);

        // A view option, not an edit: checked = long lines wrap. The view
        // binds it to the notes-wrap setting.
        this.wrapButton = new St.Button({
            style_class: 'froonty-icon-button froonty-format-button froonty-toggle',
            accessible_name: _('Wrap lines'),
            can_focus: true,
            track_hover: true,
            toggle_mode: true,
            child: new St.Icon({icon_name: 'view-wrapped-symbolic'}),
        });
        tooltip.attach(this.wrapButton, () => this.wrapButton.accessible_name);
        this.actor.add_child(this.wrapButton);
    }

    setMarkdownSource(source) {
        this.markdownButton.accessible_name = source
            ? _('Show rendered Markdown') : _('Show Markdown source');
        this._markdownTooltip = markdownTooltip(_, source);
    }

    /** Whether the edit buttons work (MD and Wrap are view options). */
    setEditable(editable) {
        this._editable = editable;
        for (const button of this._edits) {
            button.reactive = editable;
            button.can_focus = editable;
        }
    }

    /**
     * Lights the toggles whose formatting applies at the cursor; none
     * while the buttons cannot edit.
     *
     * @param {{text: string, start: number, end: number}} state
     */
    update(state) {
        for (const {button, active} of this._toggles)
            button.checked = this._editable && active(state);
    }
}
