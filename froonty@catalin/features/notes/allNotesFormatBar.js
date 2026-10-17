// SPDX-License-Identifier: GPL-3.0-or-later
// The All notes window's formatting bar (settings window; GTK 4 +
// libadwaita, so nothing from the Shell side): the island's buttons, in its
// order (formatActions.js), then Insert image, MD and Wrap lines.
//
//   [B][I][S][H][•][1.][☑][</>][🔗][🖼][MD][↩]
//
// Formatting toggles show whether their formatting applies at the cursor or
// selection. MD switches between source and preview without editing the
// note. The pane calls update() as the cursor moves and after each edit. The
// buttons never take focus on a click, so the editor keeps its selection.
// Tooltips name the buttons' shortcuts (the pane has the keys).

import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {formatActions, markdownTooltip} from './formatActions.js';

function button(Type, {icon, label, name, tooltip = name}) {
    const widget = new Type({
        css_classes: ['flat', 'froonty-format-button'],
        tooltip_text: tooltip,
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
    constructor(onEdit, onImage = () => {}) {
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

        const image = button(Gtk.Button, {icon: 'insert-image-symbolic', name: _('Insert image')});
        image.connect('clicked', onImage);
        this._edits.push(image);
        this.widget.append(image);

        this.markdownButton = button(Gtk.ToggleButton, {
            label: 'MD',
            name: _('Show Markdown source'),
            tooltip: markdownTooltip(_, false),
        });
        this.widget.append(this.markdownButton);

        // A view option, not an edit: active = long lines wrap. The pane
        // binds it to the notes-wrap setting.
        this.wrapButton = button(Gtk.ToggleButton, {
            icon: 'view-wrapped-symbolic',
            name: _('Wrap lines'),
        });
        this.widget.append(this.wrapButton);
        this.markdownButton.connect('notify::active', () => this.setMarkdownSource(
            this.markdownButton.active));
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

    /** Whether the buttons that edit can (not MD or Wrap, view options). */
    setEditable(editable) {
        for (const widget of this._edits)
            widget.sensitive = editable;
    }

    setMarkdownSource(source) {
        this.markdownButton.active = source;
        const name = source ? _('Show rendered Markdown') : _('Show Markdown source');
        this.markdownButton.tooltip_text = markdownTooltip(_, source);
        this.markdownButton.update_property([Gtk.AccessibleProperty.LABEL], [name]);
    }
}
