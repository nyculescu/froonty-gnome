// SPDX-License-Identifier: GPL-3.0-or-later
// A rendered table edited in place in All notes (allNotesStyler.js, "Edit
// table"): a grid of cells, the header row in bold, with a button to remove
// each column (above it) and each row (after it), and under the grid Add
// row, Add column, Cancel and Done. The cells hold their Markdown; the
// pipes are written by table.js (serializeTable) on Done.
//
//   [−]   [−]
//   [a  ] [b  ]
//   [1  ] [2  ]  [−]
//   [Add row] [Add column]      [Cancel] [Done]
//
// Escape cancels, as Cancel does.

import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {addColumn, addRow, removeColumn, removeRow, setCell} from './table.js';

const iconButton = (icon, name, onClick) => {
    const button = new Gtk.Button({icon_name: icon, tooltip_text: name,
        css_classes: ['flat', 'circular'], halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER});
    button.update_property([Gtk.AccessibleProperty.LABEL], [name]);
    button.connect('clicked', onClick);
    return button;
};

export class TableEditor {
    /**
     * @param {object} model parseTable()'s; `model` is the edited one
     * @param {number} width the editor's width
     * @param {Function} onDone () Done
     * @param {Function} onCancel () Cancel or Escape
     */
    constructor(model, width, onDone, onCancel) {
        this.model = model;
        this._grid = new Gtk.Grid({column_spacing: 4, row_spacing: 4});
        this._bold = new Pango.AttrList();
        this._bold.insert(Pango.attr_weight_new(Pango.Weight.BOLD));

        const buttons = new Gtk.Box({spacing: 6});
        const add = (label, edit) => {
            const button = new Gtk.Button({label});
            button.connect('clicked', () => this._edit(edit(this.model)));
            buttons.append(button);
        };
        add(_('Add row'), addRow);
        add(_('Add column'), addColumn);
        const cancel = new Gtk.Button({label: _('Cancel'), hexpand: true, halign: Gtk.Align.END});
        cancel.connect('clicked', () => onCancel());
        const done = new Gtk.Button({label: _('Done'), css_classes: ['suggested-action']});
        done.connect('clicked', () => onDone());
        buttons.append(cancel);
        buttons.append(done);

        this.widget = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: 6,
            css_classes: ['card'], width_request: width,
            margin_top: 4, margin_bottom: 4,
        });
        const inner = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6,
            margin_start: 8, margin_end: 8, margin_top: 8, margin_bottom: 8});
        inner.append(new Gtk.ScrolledWindow({
            child: this._grid,
            vscrollbar_policy: Gtk.PolicyType.NEVER,
            propagate_natural_height: true,
        }));
        inner.append(buttons);
        this.widget.append(inner);

        const keys = new Gtk.EventControllerKey();
        keys.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        keys.connect('key-pressed', (_controller, keyval) => {
            if (keyval !== Gdk.KEY_Escape)
                return false;
            onCancel();
            return true;
        });
        this.widget.add_controller(keys);
        this._fill();
    }

    /** Gives the key focus to the first cell. */
    focus() {
        this._first?.grab_focus();
    }

    _edit(model) {
        this.model = model;
        this._fill();
    }

    // The cells and their buttons, for the model.
    _fill() {
        for (let child; (child = this._grid.get_first_child());)
            this._grid.remove(child);
        const {header, rows} = this.model;
        header.forEach((_title, column) => {
            const remove = iconButton('list-remove-symbolic', _('Remove column'),
                () => this._edit(removeColumn(this.model, column)));
            remove.sensitive = header.length > 1;
            this._grid.attach(remove, column, 0, 1, 1);
        });
        this._first = null;
        [header, ...rows].forEach((cells, i) => {
            const row = i - 1; // -1: the header
            header.forEach((_title, column) => {
                const entry = new Gtk.Entry({text: cells[column] ?? '', width_chars: 8, hexpand: true});
                if (row < 0)
                    entry.attributes = this._bold;
                entry.connect('changed', () => {
                    this.model = setCell(this.model, row, column, entry.text);
                });
                this._first ??= entry;
                this._grid.attach(entry, column, i + 1, 1, 1);
            });
            if (row >= 0) {
                this._grid.attach(iconButton('list-remove-symbolic', _('Remove row'),
                    () => this._edit(removeRow(this.model, row))), header.length, i + 1, 1, 1);
            }
        });
    }
}
