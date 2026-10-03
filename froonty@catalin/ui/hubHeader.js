// SPDX-License-Identifier: GPL-3.0-or-later
// The hub's header row, right-aligned (the panic bar is centred over it in
// a layer of its own, see hub.js):
//
//   ……………………………  (Sat Oct 3 14:05•)  [feature actions]  ⚙️
//
//   (date time)  a small pill with the date in the top bar clock's format
//        (the one under the island), the time as Froonty shows it, and
//        GNOME's unread dot after the time; a press closes the island and
//        opens GNOME's own calendar and notification menu (absent when
//        this Shell has no date menu)
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
     * @param {ClockService} actions.clock the date and time on the pill
     * @param {Function} actions.openSettings
     * @param {?Function} actions.openCalendar null: no date pill
     */
    constructor(tooltip, {clock, openSettings, openCalendar}) {
        this._tooltip = tooltip;
        this._clock = clock;
        this._boxes = new Map(); // feature id → box of its actions
        this._unread = false;
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
            // The top bar clock's ticks; no timer of its own.
            this._clock.connectObject('changed', () => this._syncClock(), this);
            this._syncClock();
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

    /** Stops following the clock (the hub destroys the actors). */
    destroy() {
        this._clock.disconnectObject(this);
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

    /**
     * Shows that feature's actions, hides every other feature's.
     *
     * @param {?string} id null: none (no tab is on)
     */
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
        this._unread = unread;
        if (!this.calendarButton)
            return;
        this.unreadBadge.visible = unread;
        this._syncName();
    }

    // The pill, in the collapsed pill's style: the date as the top bar
    // clock writes it (weekday, month and day: ClockService.snapshot().date),
    // always (there is room here; "Show date when collapsed" is the
    // collapsed pill's), the time as the collapsed pill shows it (12/24-hour
    // as set in Froonty), and GNOME's unread dot after the time. A press
    // opens GNOME's own calendar and notification menu, which the island
    // covers; the island closes as it opens (Island._openCalendar).
    _buildCalendarButton() {
        const row = new St.BoxLayout({
            style_class: 'froonty-header-clock-row',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._dateLabel = new St.Label({
            style_class: 'froonty-header-clock-date',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._timeLabel = new St.Label({
            style_class: 'froonty-header-clock-time',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.unreadBadge = new St.Widget({
            style_class: 'froonty-unread-dot',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        row.add_child(this._dateLabel);
        row.add_child(this._timeLabel);
        row.add_child(this.unreadBadge);

        const button = new St.Button({
            style_class: 'froonty-header-clock',
            y_align: Clutter.ActorAlign.CENTER,
            can_focus: true,
            track_hover: true,
            child: row,
        });
        // What a press does; the pill itself shows the date and time.
        this._tooltip.attach(button, () => _('Calendar and notifications'), 'below');
        return button;
    }

    _syncClock() {
        const clock = this._clock.snapshot();
        this._dateLabel.text = clock.date;
        this._timeLabel.text = clock.time;
        this._syncName(clock);
    }

    // "Calendar and notifications, Saturday, October 3 2026, 14:05", and
    // ", unread notifications" while the dot shows.
    _syncName(clock = this._clock.snapshot()) {
        let name = [_('Calendar and notifications'), clock.weekday, clock.longDate, clock.time]
            .join(', ');
        if (this._unread)
            name = `${name}, ${_('unread notifications')}`;
        this.calendarButton.accessible_name = name;
    }
}
