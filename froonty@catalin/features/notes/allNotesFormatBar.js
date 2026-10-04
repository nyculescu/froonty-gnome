// SPDX-License-Identifier: GPL-3.0-or-later
// The All notes window's formatting bar (settings window; GTK 4 +
// libadwaita, so nothing from the Shell side): the island's buttons, in its
// order (formatActions.js), then Wrap lines.
//
//   [B][I][S][H][•][1.][☑][</>][🔗][↩]
//
// Toggles (every button but Link) show whether their formatting applies at
// the cursor or selection: lit in accent (active) = on, and a click removes
// it; plain = off, and a click adds it. The pane calls update() as the
// cursor moves, and again after each edit. The buttons never take the
// focus on a click, so the editor keeps its selection.

import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {formatActions} from './formatActions.js';

function button(Type, {icon, label, name}) {
    const widget = new Type({
        css_classes: ['flat', 'froonty-format-button'],
        tooltip_text: name,
        focus_on_click: false,
    });
    if (icon) {
        widget.icon_name = icon;
    } else {
        widget.label = label;
        widget.add_css_class('froonty-format-text');
    }
    widget.update_property([Gtk.AccessibleProperty.LABEL], [name]);
    return widget;
}

export class FormatBar {
    /** @param {Function} onEdit called with an edit function */
    constructor(onEdit) {
        this.widget = new Gtk.Box({css_classes: ['froonty-format-bar'], spacing: 2});
        this._toggles = [];
        this._edits = [];
        for (const action of formatActions(_)) {
            const widget = button(action.active ? Gtk.ToggleButton : Gtk.Button, action);
            // A toggle has flipped itself by now; update() sets it right.
            widget.connect('clicked', () => onEdit(action.edit));
            if (action.active)
                this._toggles.push({button: widget, active: action.active});
            this._edits.push(widget);
            this.widget.append(widget);
        }

        // A view option, not an edit: active = long lines wrap. The pane
        // binds it to the notes-wrap setting.
        this.wrapButton = button(Gtk.ToggleButton, {
            icon: 'view-wrapped-symbolic',
            name: _('Wrap lines'),
        });
        this.widget.append(this.wrapButton);
    }

    /**
     * Lights the toggles whose formatting applies at the cursor.
     *
     * @param {{text: string, start: number, end: number}} state
     */
    update(state) {
        for (const {button: widget, active} of this._toggles)
            widget.active = active(state);
    }

    /** Whether the formatting buttons can edit (not Wrap, a view option). */
    setEditable(editable) {
        for (const widget of this._edits)
            widget.sensitive = editable;
    }
}
