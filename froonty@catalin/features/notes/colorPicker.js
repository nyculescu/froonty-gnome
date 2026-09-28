// SPDX-License-Identifier: GPL-3.0-or-later
// Note colour: a round button showing the current colour, which swaps the
// formatting bar for a row of swatches (like Windows Sticky Notes' "…"
// colour strip). Picking a swatch, or the button again, swaps back.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {COLOR_IDS, DEFAULT_COLOR} from './colors.js';

const LABELS = {
    yellow: () => _('Yellow'),
    green: () => _('Green'),
    pink: () => _('Pink'),
    purple: () => _('Purple'),
    blue: () => _('Blue'),
    gray: () => _('Gray'),
    charcoal: () => _('Charcoal'),
};

export class ColorPicker {
    /**
     * @param {object} options
     * @param {Function} options.onPick (colour id)
     * @param {Function} options.onOpenChanged (open) swap bars in the view
     */
    constructor({onPick, onOpenChanged}) {
        this._onOpenChanged = onOpenChanged;
        this._color = DEFAULT_COLOR;

        this.button = new St.Button({
            style_class: 'froonty-icon-button froonty-color-button',
            accessible_name: _('Note colour'),
            can_focus: true,
            child: this._swatch(DEFAULT_COLOR),
        });
        this.button.connect('clicked', () => this.setOpen(!this.swatches.visible));

        this.swatches = new St.BoxLayout({
            style_class: 'froonty-color-swatches',
            visible: false,
        });
        for (const id of COLOR_IDS) {
            const swatch = new St.Button({
                style_class: 'froonty-icon-button froonty-color-option',
                accessible_name: LABELS[id](),
                can_focus: true,
                child: this._swatch(id),
            });
            swatch.connect('clicked', () => {
                onPick(id);
                this.setOpen(false);
            });
            this.swatches.add_child(swatch);
        }
    }

    /** Shows the current note's colour on the button and swatches. */
    setColor(color) {
        this._color = color;
        this.button.child.style_class = `froonty-color-dot froonty-note-color-${color}`;
        for (const [i, id] of COLOR_IDS.entries())
            this.swatches.get_child_at_index(i).checked = id === color;
    }

    setOpen(open) {
        if (open === this.swatches.visible)
            return;
        this.swatches.visible = open;
        this._onOpenChanged(open);
    }

    _swatch(id) {
        return new St.Widget({
            style_class: `froonty-color-dot froonty-note-color-${id}`,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }
}
