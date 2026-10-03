// SPDX-License-Identifier: GPL-3.0-or-later
// A note's labels, from a right-click on its tab (or Menu / Shift+F10 on a
// focused tab): a GNOME popup menu under the tab (ui/contextMenu.js).
//
//   ┌ Labels · Plan ───────────────┐
//   │ [Filter or add a label…    ] │  typing filters; Enter adds or turns on
//   │ ✓ q4                         │  this note's labels first, then the rest
//   │ ✓ work                       │  (each by name); the order holds while
//   │   home                       │  the menu is open
//   │ + Add “ideas”                │  a new label, when the text is one
//   │   3 more — type to filter    │  past 12
//   └──────────────────────────────┘
//
// Each flip is written at once (service.setLabel) and the menu stays open.
// Labels never show in the tab itself.

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Labels from './labels.js';
import {compareNames} from './names.js';
import {foldText} from './search.js';

const MAX_ITEMS = 12;

export class LabelMenu {
    /**
     * @param {object} ctx feature context (ctx.contextMenu)
     * @param {NotesService} service
     */
    constructor(ctx, service) {
        this._ctx = ctx;
        this._service = service;
        this._menu = null;
        this._labelsId = 0;
        this._changedId = 0;
    }

    get isOpen() {
        return this._menu?.isOpen ?? false;
    }

    /** Opens the labels of note `name` below `anchor`. */
    open(anchor, name) {
        // At once, not animated: its handlers go with it.
        this.destroy();
        const service = this._service;
        const menu = this._ctx.contextMenu(anchor, {
            styleClass: 'froonty-label-menu',
            onClosed: () => this._onClosed(menu),
        });
        this._menu = menu;
        this._name = name;
        menu.addTitle(_('Labels · %s').format(name));
        if (service.labelsState === 'unreadable') {
            menu.addHint(_('Labels could not be read (.froonty-labels.json)'));
            menu.open();
            return;
        }

        // This note's labels, then the others; fixed while open, so items
        // do not jump as they are flipped. Labels added later go last.
        this._checked = new Set(service.labelsOf(name).map(Labels.labelKey));
        const mine = service.labelsOf(name);
        const others = service.allLabels().map(({label}) => label)
            .filter(label => !this._checked.has(Labels.labelKey(label)));
        this._order = [...mine.sort(compareNames), ...others.sort(compareNames)];

        const {entry} = menu.addEntry({
            hint: _('Filter or add a label…'),
            onChanged: () => this._fill(),
            onActivate: () => this._onEnter(),
            onDown: () => this._section.items.find(item => item.can_focus)?.grab_key_focus(),
        });
        this._entry = entry;
        this._section = menu.addSection();
        this._fill();
        this._labelsId = service.connect('labels-changed', () => this._onLabelsChanged());
        // A label that could not be written: the ticks show the file again.
        this._changedId = service.connect('changed', () => {
            if (service.error)
                this._onLabelsChanged();
        });
        menu.open();
        entry.grab_key_focus();
    }

    close() {
        this._menu?.close();
    }

    destroy() {
        this._menu?.destroy();
    }

    _onClosed(menu) {
        if (menu !== this._menu)
            return;
        if (this._labelsId) {
            this._service.disconnect(this._labelsId);
            this._service.disconnect(this._changedId);
        }
        this._labelsId = 0;
        this._menu = null;
        this._entry = null;
        this._section = null;
    }

    // The items for the entry's text: matching labels (at most 12), "Add"
    // for a label that does not exist yet, and how many more there are.
    _shown() {
        const query = foldText(this._entry.text.trim());
        return this._order.filter(label => foldText(label).includes(query));
    }

    _fill() {
        const typed = this._entry.text;
        const shown = this._shown();
        const focused = this._section.items.find(item => item.has_key_focus?.())?.label?.text;

        this._section.removeAll();
        for (const label of shown.slice(0, MAX_ITEMS)) {
            const item = this._section.addToggle(label, this._checked.has(Labels.labelKey(label)),
                on => this._set(label, on));
            if (label === focused)
                item.grab_key_focus();
        }
        const clean = Labels.cleanLabel(typed);
        if (clean && !this._order.some(l => Labels.labelKey(l) === Labels.labelKey(clean)))
            this._section.addAction(_('Add “%s”').format(clean), () => this._add(clean));
        if (shown.length > MAX_ITEMS) {
            const more = shown.length - MAX_ITEMS;
            this._section.addHint(_('%d more — type to filter').format(more));
        }
    }

    _set(label, on) {
        const key = Labels.labelKey(label);
        if (on)
            this._checked.add(key);
        else
            this._checked.delete(key);
        this._service.setLabel(this._name, label, on);
    }

    _add(label) {
        this._order.push(label);
        this._set(label, true);
        this._entry.text = ''; // refills: the new label shows, ticked
    }

    // Enter: an existing label is turned on (never off), a new one added.
    _onEnter() {
        const clean = Labels.cleanLabel(this._entry.text);
        if (!clean)
            return;
        const existing = this._order.find(l => Labels.labelKey(l) === Labels.labelKey(clean));
        if (!existing) {
            this._add(clean);
            return;
        }
        if (!this._checked.has(Labels.labelKey(existing)))
            this._set(existing, true);
        this._entry.text = '';
    }

    // Written (here or elsewhere): ticks follow the file; new labels go last.
    _onLabelsChanged() {
        if (!this._menu)
            return;
        this._checked = new Set(this._service.labelsOf(this._name).map(Labels.labelKey));
        const known = new Set(this._order.map(Labels.labelKey));
        for (const {label} of this._service.allLabels()) {
            if (!known.has(Labels.labelKey(label)))
                this._order.push(label);
        }
        const toggles = this._section.items.filter(item => item.setChecked);
        const wanted = this._shown().slice(0, MAX_ITEMS);
        if (toggles.map(item => item.label.text).join('\n') !== wanted.join('\n')) {
            this._fill();
            return;
        }
        for (const item of toggles)
            item.setChecked(this._checked.has(Labels.labelKey(item.label.text)));
    }
}
