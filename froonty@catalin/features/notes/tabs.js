// SPDX-License-Identifier: GPL-3.0-or-later
// Capsule tabs, one per note, plus "+" to add one.
//
//   click       select          double-click   rename inline
//   × (hover)   first click arms it, second click moves the note to the
//               Trash; leaving the tab disarms it (no timer involved)

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

export class NoteTabs {
    /**
     * @param {object} callbacks
     * @param {Function} callbacks.onSelect (name)
     * @param {Function} callbacks.onCreate ()
     * @param {Function} callbacks.onRename (newName) renames the selected note
     * @param {Function} callbacks.onTrash (name)
     */
    constructor(callbacks) {
        this._callbacks = callbacks;

        // [scrolling tabs……] [+]: "+" stays reachable however many notes.
        this._box = new St.BoxLayout({style_class: 'froonty-note-tabs'});
        const scroll = new St.ScrollView({
            style_class: 'froonty-note-tabs-scroll',
            hscrollbar_policy: St.PolicyType.EXTERNAL,
            vscrollbar_policy: St.PolicyType.NEVER,
            x_expand: true,
            child: this._box,
        });
        this.actor = new St.BoxLayout({style_class: 'froonty-note-tabs-row'});
        this.actor.add_child(scroll);

        this.addButton = new St.Button({
            style_class: 'froonty-icon-button',
            accessible_name: _('New note'),
            can_focus: true,
            child: new St.Icon({icon_name: 'list-add-symbolic'}),
        });
        this.addButton.connect('clicked', () => this._callbacks.onCreate());
        this.actor.add_child(this.addButton);
    }

    /** Rebuilds the tabs. Cheap: a handful of buttons. */
    update(notes, selected) {
        this._box.destroy_all_children();
        for (const name of notes)
            this._box.add_child(this._makeTab(name, name === selected));
    }

    _makeTab(name, selected) {
        const tab = new St.Button({
            style_class: 'froonty-note-tab',
            accessible_name: name,
            can_focus: true,
            track_hover: true,
            checked: selected,
        });
        const box = new St.BoxLayout();
        const label = new St.Label({text: name, y_align: Clutter.ActorAlign.CENTER});
        box.add_child(label);
        box.add_child(this._makeTrashButton(tab, name));
        tab.set_child(box);

        tab.connect('clicked', () => this._callbacks.onSelect(name));
        // Clutter 14 events carry no click count; compare press times
        // against the system double-click time instead.
        let lastPress = 0;
        tab.connect('button-press-event', (_actor, event) => {
            const time = event.get_time();
            const doubleClick = time - lastPress <= Clutter.Settings.get_default().double_click_time;
            lastPress = time;
            if (selected && doubleClick) {
                this._startRename(tab, name);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        return tab;
    }

    _makeTrashButton(tab, name) {
        const button = new St.Button({
            style_class: 'froonty-note-tab-close',
            accessible_name: _('Move to Trash'),
            can_focus: true,
            child: new St.Icon({icon_name: 'window-close-symbolic'}),
        });
        // Shown on hover or on the selected tab (see stylesheet).
        // 'destroy' comes before children are disposed; hover may still
        // change while the tab is torn down, so ignore it from then on.
        let alive = true;
        tab.connect('destroy', () => (alive = false));
        const disarm = () => {
            if (!alive)
                return;
            button.remove_style_class_name('froonty-armed');
            button.child.icon_name = 'window-close-symbolic';
            button.accessible_name = _('Move to Trash');
        };
        button.connect('clicked', () => {
            if (button.has_style_class_name('froonty-armed')) {
                this._callbacks.onTrash(name);
                return;
            }
            button.add_style_class_name('froonty-armed');
            button.child.icon_name = 'user-trash-symbolic';
            button.accessible_name = _('Click again to move to Trash');
        });
        tab.connect('notify::hover', () => {
            if (!tab.hover)
                disarm();
        });
        return button;
    }

    _startRename(tab, name) {
        const entry = new St.Entry({
            style_class: 'froonty-note-tab-entry',
            text: name,
            can_focus: true,
        });
        tab.set_child(entry);
        entry.grab_key_focus();
        entry.clutter_text.set_selection(0, -1);

        let done = false;
        const commit = () => {
            if (done)
                return;
            done = true;
            // The service validates; update() then rebuilds the tabs either
            // way, restoring the old name if the new one was refused.
            this._callbacks.onRename(entry.text);
        };
        entry.clutter_text.connect('activate', commit);
        entry.clutter_text.connect('key-focus-out', commit);
    }
}
