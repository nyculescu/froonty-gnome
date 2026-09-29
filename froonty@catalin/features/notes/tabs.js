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
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

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
        // The view places this in an overlay layer over its content.
        this.tooltip = new St.Label({style_class: 'froonty-note-tooltip', visible: false});

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
        this.tooltip.hide();
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

    // Full name of a cut-off tab, in a small bubble under it, while hovered.
    _showFullName(tab, name) {
        const parent = this.tooltip.get_parent();
        if (!tab.hover || !parent || shortTitle(name) === name) {
            this.tooltip.hide();
            return;
        }
        this.tooltip.text = name;
        const [x, y] = tab.get_transformed_position();
        const [, height] = tab.get_transformed_size();
        const [, px, py] = parent.transform_stage_point(x, y + height);
        const [, width] = this.tooltip.get_preferred_width(-1);
        this.tooltip.set_position(
            Math.round(Math.max(0, Math.min(px, parent.width - width))), Math.round(py));
        this.tooltip.show();
    }

    _makeTab(name, selected, color) {
        const tab = new St.Button({
            style_class: 'froonty-note-tab',
            accessible_name: name,
            can_focus: true,
            track_hover: true,
            checked: selected,
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

        tab.connect('clicked', () => this._callbacks.onSelect(name));
        tab.connect('notify::hover', () => this._showFullName(tab, name));
        tab.connect('key-focus-in', () => this._scrollTo(tab));
        if (selected)
            tab.connect('notify::allocation', () => this._scrollTo(tab));

        // Middle-click closes (trashes) the note at once, like a browser tab.
        // St.Button only reacts to the primary button, so this never selects.
        tab.connect('button-release-event', (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_MIDDLE)
                return Clutter.EVENT_PROPAGATE;
            this._callbacks.onTrash(name);
            return Clutter.EVENT_STOP;
        });

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
        const entry = new St.Entry({
            style_class: 'froonty-note-tab-entry',
            text: name,
            can_focus: true,
            x_expand: true,
        });
        // set_child() only detaches the old content (dot, name, ×); destroy it
        // explicitly rather than leaving it to the garbage collector.
        const oldContent = tab.child;
        tab.set_child(entry);
        oldContent.destroy();
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
