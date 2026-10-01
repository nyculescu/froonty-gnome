// SPDX-License-Identifier: GPL-3.0-or-later
// Capsule tabs, one per note, plus "+" to add one.
//
//   [● as][● 28.09.26 16.03][● Weekly planni…]›  [+]
//
//   Each tab is as wide as its name. Names longer than MAX_TITLE_CHARS (a
//   full "dd.mm.yy hh.mm" is exactly 14) are shortened to 13 characters
//   plus "…" and shown whole in a bubble while hovered. The row scrolls (wheel or
//   touchpad; edge fade) and keeps the selected tab in view. ● is the
//   note's colour.
//
//   click          select        double-click   rename inline
//   middle-click   move the note to the Trash at once (like a browser tab)
//   × (hover)      first click arms it, second click moves the note to the
//                  Trash; leaving the tab disarms it (no timer involved)

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Tooltip} from '../../core/tooltip.js';

const MAX_TITLE_CHARS = 14;

// By characters, not pixels: labels keep a fixed natural width, so the
// scrolling row never squeezes them (Pango ellipsizing would let it).
function shortTitle(name) {
    const chars = [...name];
    return chars.length > MAX_TITLE_CHARS
        ? `${chars.slice(0, MAX_TITLE_CHARS - 1).join('')}…`
        : name;
}

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

        this.actor = new St.BoxLayout({style_class: 'froonty-note-tabs-row'});
        this.actor.add_child(this._scroll);
        // Full name of a cut-off tab while hovered. The view places the
        // tooltip actor in an overlay layer over its content.
        this._tooltip = new Tooltip();
        this.tooltip = this._tooltip.actor;

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

    /**
     * Rebuilds the tabs. Cheap: a handful of buttons.
     *
     * @param {string[]} notes in display order
     * @param {?string} selected
     * @param {Function} colorOf (name) → colour id
     */
    update(notes, selected, colorOf) {
        this._tooltip.hide();
        this._box.destroy_all_children();
        for (const name of notes)
            this._box.add_child(this._makeTab(name, name === selected, colorOf(name)));
    }

    // Keeps a tab in view. Its allocation is valid when this runs: from
    // notify::allocation (after layout) or on focus of a laid-out tab.
    _scrollTo(tab) {
        const box = tab.get_allocation_box();
        this._scroll.hadjustment.clamp_page(box.x1, box.x2);
    }

    _onScroll(event) {
        const adjustment = this._scroll.hadjustment;
        const step = adjustment.page_size / 4;
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
            // Middle-click closes (trashes) the note, like a browser tab.
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
        });
        const box = new St.BoxLayout();
        box.add_child(new St.Widget({
            style_class: `froonty-note-dot froonty-note-color-${color}`,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const label = new St.Label({
            style_class: 'froonty-note-tab-label',
            text: shortTitle(name),
            y_align: Clutter.ActorAlign.CENTER,
        });
        // St.Label ellipsizes by default, which would let the row squeeze it.
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        box.add_child(label);
        const trashButton = this._makeTrashButton(tab, name);
        box.add_child(trashButton);
        tab.set_child(box);

        tab.connect('clicked', (_tab, button) => {
            if (button === Clutter.BUTTON_MIDDLE)
                this._callbacks.onTrash(name);
            else
                this._callbacks.onSelect(name);
        });
        this._tooltip.attach(tab, () => (shortTitle(name) === name ? null : name), 'below');
        tab.connect('key-focus-in', () => this._scrollTo(tab));
        // Once, when first laid out: later allocations (hover shows the
        // close button) must not undo the user's scrolling.
        if (selected) {
            const allocationId = tab.connect('notify::allocation', () => {
                tab.disconnect(allocationId);
                this._scrollTo(tab);
            });
        }

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
        // The × can go away before the tab does (tab teardown disposes children
        // first; a rename replaces the tab's content), while the tab still
        // reports hover changes: ignore them from then on.
        let alive = true;
        button.connect('destroy', () => (alive = false));
        const disarm = () => {
            if (!alive)
                return;
            // Takes room only where it is usable: on hover and on the selected
            // tab, so other tabs stay as narrow as their names.
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
        // A fixed width (stylesheet), not x_expand: once the row overflows
        // there is no spare width to expand into, and an entry's natural
        // width is only a few pixels, so the tab shrank to a sliver.
        const entry = new St.Entry({
            style_class: 'froonty-note-tab-entry',
            text: name,
            can_focus: true,
        });
        // set_child() only detaches the old content (dot, name, ×); destroy it
        // explicitly rather than leaving it to the garbage collector.
        const oldContent = tab.child;
        tab.set_child(entry);
        oldContent.destroy();
        // The entry shows the full name; the bubble would cover it.
        this._tooltip.hide();
        // The tab changes width: keep it in view once laid out again. After
        // that layout, not during it: the row updates its scroll range only
        // after placing its tabs, so a wider tab could not be reached yet.
        let idleId = 0;
        const allocationId = tab.connect('notify::allocation', () => {
            tab.disconnect(allocationId);
            idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                idleId = 0;
                this._scrollTo(tab);
                return GLib.SOURCE_REMOVE;
            });
        });
        tab.connect('destroy', () => {
            if (idleId)
                GLib.source_remove(idleId);
        });
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
