// SPDX-License-Identifier: GPL-3.0-or-later
// Capsule tabs, one per note, plus "+" to add one.
//
//   [● tab][● tab][● tab][● tab][● tab]›  [+]
//
//   At most VISIBLE_TABS fit; every tab is exactly that fraction of the row
//   wide and the row scrolls (wheel/touchpad; thin overlay scrollbar). The
//   selected tab is always scrolled into view. ● is the note's colour.
//
//   click       select          double-click   rename inline
//   × (hover)   first click arms it, second click moves the note to the
//               Trash; leaving the tab disarms it (no timer involved)

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const VISIBLE_TABS = 5;

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
        this._layoutLaterId = 0;
        this._slot = 0;
        this._spacing = 0;

        this._box = new St.BoxLayout({style_class: 'froonty-note-tabs'});
        this._scroll = new St.ScrollView({
            // Scrollable without a bar; "hfade" (GNOME's edge fade) shows that
            // there is more to either side.
            style_class: 'froonty-note-tabs-scroll hfade',
            hscrollbar_policy: St.PolicyType.EXTERNAL,
            vscrollbar_policy: St.PolicyType.NEVER,
            x_expand: true,
            child: this._box,
        });
        // A vertical wheel does not move a horizontal strip by itself.
        this._scroll.connect('scroll-event', (_actor, event) => this._onScroll(event));
        this._scroll.connect('notify::width', () => this._queueLayout());
        this._scroll.hadjustment.connect('changed', () => this._scrollToSelected());

        this.actor = new St.BoxLayout({style_class: 'froonty-note-tabs-row'});
        this.actor.add_child(this._scroll);

        // Outside the scrolling row: reachable however many notes there are.
        this.addButton = new St.Button({
            style_class: 'froonty-icon-button',
            accessible_name: _('New note'),
            can_focus: true,
            child: new St.Icon({icon_name: 'list-add-symbolic'}),
        });
        this.addButton.connect('clicked', () => this._callbacks.onCreate());
        this.actor.add_child(this.addButton);
    }

    destroy() {
        this._cancelLayout();
    }

    /**
     * Rebuilds the tabs. Cheap: a handful of buttons.
     *
     * @param {string[]} notes in display order
     * @param {?string} selected
     * @param {Function} colorOf (name) → colour id
     */
    update(notes, selected, colorOf) {
        this._box.destroy_all_children();
        for (const name of notes)
            this._box.add_child(this._makeTab(name, name === selected, colorOf(name)));
        this._queueLayout();
    }

    // Sizes the tabs from the row width and scrolls to the selected one.
    // Runs after layout, never in the middle of an allocation.
    _queueLayout() {
        if (this._layoutLaterId)
            return;
        const laters = global.compositor.get_laters();
        this._layoutLaterId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._layoutLaterId = 0;
            this._layoutTabs();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelLayout() {
        if (this._layoutLaterId) {
            global.compositor.get_laters().remove(this._layoutLaterId);
            this._layoutLaterId = 0;
        }
    }

    /** Re-sizes the tabs, e.g. when the Notes tab is shown again. */
    relayout() {
        this._queueLayout();
    }

    _layoutTabs() {
        // Theme nodes (for the spacing) only exist while on stage.
        if (!this._box.mapped)
            return;
        const tabs = this._box.get_children();
        const spacing = this._box.get_theme_node().get_length('spacing');
        // The allocated width: `width` would return the preferred width (all
        // tabs at natural size) while a relayout is pending. A later change of
        // the allocation re-queues this through notify::width.
        const rowWidth = this._scroll.get_allocation_box().get_width();
        const slot = Math.floor((rowWidth - spacing * (VISIBLE_TABS - 1)) / VISIBLE_TABS);
        if (slot <= 0)
            return;

        for (const tab of tabs)
            tab.width = slot;

        this._slot = slot;
        this._spacing = spacing;
        this._scrollToSelected();
    }

    // By index, not by allocation: freshly rebuilt tabs are not laid out
    // yet. Runs after sizing and whenever the scroll range changes (which
    // only happens after layout, and never on user scrolling).
    _scrollToSelected() {
        const tabs = this._box.get_children();
        const index = tabs.findIndex(t => t.checked);
        if (index < 0 || !this._slot)
            return;
        const x = (this._slot + this._spacing) * index;
        this._scroll.hadjustment.clamp_page(x, x + this._slot);
    }

    _onScroll(event) {
        const adjustment = this._scroll.hadjustment;
        const step = adjustment.page_size / VISIBLE_TABS;
        let delta = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            delta = -step;
            break;
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.RIGHT:
            delta = step;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [dx, dy] = event.get_scroll_delta();
            delta = (dx + dy) * step;
            break;
        }
        }
        adjustment.value += delta;
        return Clutter.EVENT_STOP;
    }

    _makeTab(name, selected, color) {
        const tab = new St.Button({
            style_class: 'froonty-note-tab',
            accessible_name: name,
            can_focus: true,
            track_hover: true,
            checked: selected,
        });
        const box = new St.BoxLayout({x_expand: true});
        box.add_child(new St.Widget({
            style_class: `froonty-note-dot froonty-note-color-${color}`,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const label = new St.Label({
            text: name,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(label);
        const trashButton = this._makeTrashButton(tab, name);
        box.add_child(trashButton);
        tab.set_child(box);

        tab.connect('clicked', () => this._callbacks.onSelect(name));
        tab.connect('key-focus-in', () => this._queueLayout());
        // Clutter 14 events carry no click count; compare press times
        // against the system double-click time instead.
        let lastPress = 0;
        tab.connect('button-press-event', (_actor, event) => {
            // Presses on × are not rename clicks: × is clicked twice on purpose.
            if (trashButton.contains(global.stage.get_event_actor(event)))
                return Clutter.EVENT_PROPAGATE;
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
            // Takes room only where it is usable: on hover and on the selected
            // tab, so unselected tabs keep the whole width for the name.
            button.visible = tab.hover || tab.checked;
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
        tab.connect('notify::hover', () => disarm());
        button.visible = tab.checked;
        return button;
    }

    _startRename(tab, name) {
        const entry = new St.Entry({
            style_class: 'froonty-note-tab-entry',
            text: name,
            can_focus: true,
            x_expand: true,
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
