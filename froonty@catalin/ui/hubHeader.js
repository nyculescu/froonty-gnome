// SPDX-License-Identifier: GPL-3.0-or-later
// The hub's header row, right-aligned (the panic bar is centred over it in
// a layer of its own, see hub.js):
//
//   ……………………………………  📅  [feature actions]  ⚙️
//
//   📅   GNOME's own calendar and notification menu, with GNOME's unread
//        dot (absent when this Shell has no date menu)
//   feature actions  buttons a feature's view provides (`headerActions`),
//        shown only while its tab is the active one; e.g. Notes' "All notes"
//   ⚙️   Froonty's settings window
//
// The view owns its action buttons and destroys them; the header only
// places them, gives them the icon-button tooltip, and shows the active
// feature's.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

export class HubHeader {
    /**
     * @param {Tooltip} tooltip the hub's tooltip (its overlay layer)
     * @param {object} actions
     * @param {Function} actions.openSettings
     * @param {?Function} actions.openCalendar null: no 📅
     */
    constructor(tooltip, {openSettings, openCalendar}) {
        this._tooltip = tooltip;
        this._boxes = new Map(); // feature id → box of its actions
        this.calendarButton = null;
        this.unreadBadge = null;

        this.actor = new St.BoxLayout({style_class: 'froonty-hub-header'});
        this.actor.add_child(new St.Widget({x_expand: true}));
        this.end = new St.BoxLayout({style_class: 'froonty-hub-header-end'});
        this.actor.add_child(this.end);

        if (openCalendar) {
            this.calendarButton = this._buildCalendarButton();
            this.calendarButton.connect('clicked', () => openCalendar());
            this.end.add_child(this.calendarButton);
        }

        // Hidden while it holds nothing to show: no double spacing.
        this._slot = new St.BoxLayout({
            style_class: 'froonty-hub-feature-actions',
            visible: false,
        });
        this.end.add_child(this._slot);

        this.settingsButton = new St.Button({
            style_class: 'froonty-icon-button',
            accessible_name: _('Settings'),
            can_focus: true,
            track_hover: true,
            child: new St.Icon({icon_name: 'emblem-system-symbolic'}),
        });
        this.settingsButton.connect('clicked', () => openSettings());
        this.end.add_child(this.settingsButton);
    }

    /**
     * Places a feature's action buttons (hidden until showActions(id)).
     *
     * @param {string} id feature id
     * @param {St.Widget[]} widgets owned by the feature's view; each needs
     *   track_hover and an accessible_name (its tooltip)
     */
    addActions(id, widgets) {
        if (!widgets.length || this._boxes.has(id))
            return;
        const box = new St.BoxLayout({
            style_class: 'froonty-hub-feature-actions',
            visible: false,
        });
        for (const widget of widgets) {
            widget.add_style_class_name('froonty-feature-action');
            this._tooltip.attach(widget, () => widget.accessible_name, 'below');
            box.add_child(widget);
        }
        this._slot.add_child(box);
        this._boxes.set(id, box);
    }

    /** Shows that feature's actions, hides every other feature's. */
    showActions(id) {
        for (const [key, box] of this._boxes)
            box.visible = key === id;
        this._slot.visible = this._boxes.has(id);
    }

    /** The feature is gone (its view destroyed its buttons already). */
    removeActions(id) {
        const box = this._boxes.get(id);
        if (!box)
            return;
        this._boxes.delete(id);
        if (box.visible)
            this._slot.visible = false;
        box.destroy();
    }

    /** @param {boolean} unread whether GNOME's clock would show its dot */
    setUnread(unread) {
        if (this.unreadBadge)
            this.unreadBadge.visible = unread;
    }

    // 📅 opens GNOME's own calendar and notification menu, which the island
    // covers. While GNOME's clock would show its unread-notifications dot,
    // the button carries the same dot.
    _buildCalendarButton() {
        this.unreadBadge = new St.Widget({
            style_class: 'froonty-unread-dot',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_expand: true,
            visible: false,
        });
        const icon = new St.Widget({layout_manager: new Clutter.BinLayout()});
        icon.add_child(new St.Icon({icon_name: 'x-office-calendar-symbolic'}));
        icon.add_child(this.unreadBadge);

        const button = new St.Button({
            style_class: 'froonty-icon-button',
            accessible_name: _('Calendar and notifications'),
            can_focus: true,
            track_hover: true,
            child: icon,
        });
        this._tooltip.attach(button, () => button.accessible_name, 'below');
        return button;
    }
}
