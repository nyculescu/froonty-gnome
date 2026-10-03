// SPDX-License-Identifier: GPL-3.0-or-later
// The Notes tab's button in the hub header, between the date pill and ⚙️,
// shown only while the Notes tab is active (view.headerActions,
// ui/hubHeader.js): "All notes" opens the settings window on its All notes
// page, to search every note and filter them by label.
//
// It is tinted with a faint wash of the selected note's colour, which sets
// it apart from the global date pill and ⚙️ and ties it to the note
// (stylesheet.css, .froonty-notes-action-<colour>).

import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {COLOR_IDS, DEFAULT_COLOR, isColor} from './colors.js';

const tintClass = id => `froonty-notes-action-${id}`;

export class AllNotesButton {
    /** @param {Function} onClick */
    constructor(onClick) {
        this.actor = new St.Button({
            style_class: 'froonty-icon-button froonty-notes-action',
            accessible_name: _('All notes'),
            can_focus: true,
            track_hover: true,
            child: new St.Icon({icon_name: 'edit-find-symbolic'}),
        });
        this.actor.connect('clicked', () => onClick());
        this.setColor(DEFAULT_COLOR);
    }

    /** Tints the button with a note colour (yellow for an unknown id). */
    setColor(id) {
        const color = isColor(id) ? id : DEFAULT_COLOR;
        for (const other of COLOR_IDS) {
            if (other !== color)
                this.actor.remove_style_class_name(tintClass(other));
        }
        this.actor.add_style_class_name(tintClass(color));
    }

    destroy() {
        this.actor.destroy();
    }
}
