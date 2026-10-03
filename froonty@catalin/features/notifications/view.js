// SPDX-License-Identifier: GPL-3.0-or-later
// Notifications tab (docs/features/notifications.md): GNOME's own
// notifications, urgent ones first, then newest first.
//
//   5 notifications                       [🔕] [Clear all]
//   ┌ row (row.js) ───────────────────────────────┐ [×]
//   └─────────────────────────────────────────────┘
//   …
//
// A click on a row or one of its action buttons does what GNOME's list
// does (the island then closes, as GNOME's menu does); × or Delete
// dismisses it. "Clear all" takes two clicks: the button becomes "Keep
// them" where it was, and "Clear N?" appears beside it, so a double click
// keeps them (from the keyboard, the focus goes to "Keep them"). After a
// removal by a click, the second click of a double click, which lands on
// whatever moved into its place, does nothing. Rows are reconciled by
// identity while the tab is on screen; hidden, nothing is followed and the
// rows keep their last descriptions.

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Tooltip} from '../../core/tooltip.js';
import {NotificationRow} from './row.js';

export class NotificationsView {
    /**
     * @param {object} ctx feature context: notifications (GNOME's, or null),
     *   clock (ClockService), collapse()
     * @param {NotificationsService} service
     */
    constructor(ctx, service) {
        this._ctx = ctx;
        this._service = service;
        this._clock = ctx.clock;
        this._active = false;
        this._clockId = 0;
        /** @type {Map<object, NotificationRow>} */
        this._rows = new Map();
        /** @type {?Map<object, number>} what "Clear all" asked to clear */
        this._clearSnapshot = null;
        /** The last removal by a click: {time (µs), x, y}, or null. */
        this._lastRemoval = null;

        const gnome = ctx.notifications;
        this._format = {
            plainText: (text, useMarkup) => gnome?.plainText(text, useMarkup) ?? text ?? '',
            timeAgo: datetime => gnome?.timeAgo(datetime) ?? '',
            when: datetime => this._when(datetime),
        };
        this._rowActions = {
            activate: row => this._activate(row),
            action: (row, index) => this._activateAction(row, index),
            dismiss: row => this._dismiss(row),
        };

        // Content, plus an overlay layer (fixed positions, click-through)
        // for the hover bubble.
        this.actor = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        const content = new St.BoxLayout({
            style_class: 'froonty-notifications',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        this._tooltip = new Tooltip();
        content.add_child(this._buildHeader());

        this._notice = new St.Label({
            style_class: 'froonty-notifications-notice',
            text: _('GNOME Shell’s notifications are not available here.'),
            x_expand: true,
            visible: false,
        });
        this._notice.clutter_text.line_wrap = true;
        content.add_child(this._notice);

        this._empty = new St.BoxLayout({
            style_class: 'froonty-notifications-empty',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._empty.add_child(new St.Icon({
            icon_name: 'no-notifications-symbolic',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        this._empty.add_child(new St.Label({
            text: _('No notifications'),
            x_align: Clutter.ActorAlign.CENTER,
        }));
        this._emptyDnd = new St.Label({
            style_class: 'froonty-notifications-empty-dnd',
            text: _('Do Not Disturb is on'),
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._empty.add_child(this._emptyDnd);
        content.add_child(this._empty);

        this._list = new St.BoxLayout({
            style_class: 'froonty-notifications-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._scroll = new St.ScrollView({
            style_class: 'froonty-notifications-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            visible: false,
        });
        this._scroll.add_child(this._list);
        content.add_child(this._scroll);
        this.actor.add_child(content);

        const overlay = new St.Widget({x_expand: true, y_expand: true});
        overlay.add_child(this._tooltip.actor);
        this.actor.add_child(overlay);

        this._serviceIds = [
            this._service.connect('changed', () => this._onChanged()),
            this._service.connect('notification-changed',
                (_service, notification) => this._onNotificationChanged(notification)),
            this._service.connect('dnd-changed', () => this._syncHeader()),
        ];
        this._syncHeader();
    }

    destroy() {
        for (const id of this._serviceIds)
            this._service.disconnect(id);
        this._serviceIds = [];
        this._disconnectClock();
        this._clearSnapshot = null;
        this._rows.clear();
        this.actor.destroy();
    }

    /**
     * On screen: show GNOME's list as it is now. Hidden: stop following the
     * clock; a pending "Clear all" is dropped. The rows stay (the hub fades
     * out) and are reconciled on the next showing.
     */
    setActive(active) {
        this._active = active;
        if (active) {
            this._reconcile({refresh: true});
            this._disconnectClock();
            this._clockId = this._clock.connect('changed', () => this._refreshAges());
            this._scroll.vadjustment.value = 0;
            return;
        }
        this._disconnectClock();
        this._tooltip.hide();
        this._clearSnapshot = null;
        this._lastRemoval = null;
        this._syncHeader();
    }

    /**
     * The user pressed, typed or scrolled in the open island while this tab
     * is on screen, or opened it on purpose: what it lists has been seen,
     * GNOME's rule for its own list.
     */
    onUserInput() {
        if (this._active)
            this._service.markSeen();
    }

    _buildHeader() {
        const header = new St.BoxLayout({style_class: 'froonty-notifications-header'});
        this._status = new St.Label({
            style_class: 'froonty-notifications-status',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._status);

        this._dndButton = new St.Button({
            style_class: 'froonty-icon-button froonty-notifications-dnd',
            accessible_name: _('Do Not Disturb'),
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'notifications-disabled-symbolic'}),
        });
        this._dndButton.connect('clicked', () => {
            // It moves into the place of "Clear N?" once that is confirmed.
            if (!this._isSecondClick())
                this._service.setDoNotDisturb(!this._service.doNotDisturb);
        });
        this._tooltip.attach(this._dndButton,
            () => _('Do Not Disturb: no banners; notifications still arrive here'), 'below');
        header.add_child(this._dndButton);

        // "Clear N?": appears left of "Keep them", which takes the place of
        // "Clear all", so a double click on "Clear all" keeps them.
        this._confirmButton = new St.Button({
            style_class: 'froonty-notifications-confirm',
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._confirmButton.connect('clicked', () => this._confirmClear());
        header.add_child(this._confirmButton);

        this._clearButton = this._textButton('edit-clear-all-symbolic', _('Clear all'),
            _('Clear all notifications'));
        this._clearButton.connect('clicked', () => this._askClear());
        header.add_child(this._clearButton);

        this._keepButton = this._textButton('window-close-symbolic', _('Keep them'),
            _('Keep them: cancel clearing'));
        this._keepButton.visible = false;
        this._keepButton.connect('clicked', () => this._cancelClear());
        header.add_child(this._keepButton);
        return header;
    }

    _textButton(iconName, label, accessibleName) {
        const box = new St.BoxLayout({style_class: 'froonty-notifications-clear-content'});
        box.add_child(new St.Icon({icon_name: iconName}));
        box.add_child(new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER}));
        return new St.Button({
            style_class: 'froonty-notifications-clear',
            accessible_name: accessibleName,
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: box,
        });
    }

    // ------------------------------------------------------------ list

    _onChanged() {
        if (this._active)
            this._reconcile();
    }

    _onNotificationChanged(notification) {
        if (!this._active)
            return;
        this._rows.get(notification)?.update(this._service.describe(notification));
        // One updated while "Clear N?" waits is no longer part of it.
        if (this._clearSnapshot) {
            this._dropEmptySnapshot();
            this._syncHeader();
        }
    }

    /**
     * Makes the rows match the service's list, by identity: rows of
     * notifications that went are destroyed, new ones made, and the rest
     * moved into place. A removed row that held the key focus passes it to
     * the row now in its place, else the one before, else Do Not Disturb.
     *
     * @param {object} [options]
     * @param {boolean} [options.refresh] describe every row again (what
     *   changed while the tab was hidden was not followed)
     */
    _reconcile({refresh = false} = {}) {
        const items = this._service.items;
        const live = new Set(items);
        const focus = this.actor.get_stage()?.get_key_focus() ?? null;
        let focusIndex = -1;

        const before = this._list.get_children();
        for (const [key, row] of this._rows) {
            if (live.has(key))
                continue;
            if (focus && row.contains(focus))
                focusIndex = before.indexOf(row);
            this._rows.delete(key);
            row.destroy();
        }
        if (this._rows.size !== before.length || focusIndex >= 0)
            this._tooltip.hide();

        items.forEach((key, index) => {
            let row = this._rows.get(key);
            if (!row) {
                row = new NotificationRow(key, this._rowActions, this._format, this._tooltip);
                row.update(this._service.describe(key));
                this._rows.set(key, row);
                this._list.insert_child_at_index(row, index);
                return;
            }
            if (refresh)
                row.update(this._service.describe(key));
            if (this._list.get_child_at_index(index) !== row)
                this._list.set_child_at_index(row, index);
        });

        if (focusIndex >= 0) {
            const rows = this._list.get_children();
            const next = rows[Math.min(focusIndex, rows.length - 1)];
            if (next)
                next.focusMain();
            else
                this._dndButton.grab_key_focus();
        }

        this._dropEmptySnapshot();
        this._syncHeader();
    }

    // Nothing it would clear is listed, unchanged, any more: nothing to
    // confirm.
    _dropEmptySnapshot() {
        if (this._clearSnapshot && this._service.countClearable(this._clearSnapshot) === 0)
            this._clearSnapshot = null;
    }

    _refreshAges() {
        for (const row of this._rows.values())
            row.refreshAge();
    }

    // ------------------------------------------------------------ acts

    // As GNOME's list: activate() (it goes unless resident), then the
    // island closes as GNOME's menu does.
    _activate(row) {
        if (!this._isSecondClick() && this._service.activate(row.key))
            this._ctx.collapse?.();
    }

    _activateAction(row, index) {
        if (!this._isSecondClick() && this._service.activateAction(row.key, index))
            this._ctx.collapse?.();
    }

    // The island stays open.
    _dismiss(row) {
        if (!this._isSecondClick() && this._service.dismiss(row.key))
            this._noteRemoval();
    }

    _askClear() {
        if (!this._active || this._service.items.length === 0 || this._isSecondClick())
            return;
        const focused = this._clearButton.has_key_focus();
        // "Keep them" takes the place of "Clear all" and is at least as
        // wide, so a second click there never lands on "Clear N?".
        this._keepButton.min_width = this._clearButton.width;
        this._clearSnapshot = this._service.snapshot();
        this._syncHeader();
        // From the keyboard too, the safe choice takes the focus: a second
        // Enter or Space keeps them; confirming takes a move to "Clear N?"
        // (Shift+Tab or Left).
        if (focused)
            this._keepButton.grab_key_focus();
    }

    _confirmClear() {
        const snapshot = this._clearSnapshot;
        this._clearSnapshot = null;
        if (snapshot && this._service.clear(snapshot) > 0)
            this._noteRemoval();
        this._syncHeader();
        if (!this._clearButton.visible)
            this._dndButton.grab_key_focus();
        else
            this._clearButton.grab_key_focus();
    }

    _cancelClear() {
        this._clearSnapshot = null;
        this._syncHeader();
        this._clearButton.grab_key_focus();
    }

    // A removal by a click moves what was below (or, in the header, what
    // was beside) into the place under the pointer. GNOME's list animates
    // a removal for 100 ms; here, the place is simply not clickable for the
    // second click of a double click: the system's double-click time and
    // distance, from the click that removed it. Keys are not affected.
    _noteRemoval() {
        const event = pointerEvent();
        if (!event) {
            this._lastRemoval = null;
            return;
        }
        const [x, y] = event.get_coords();
        this._lastRemoval = {time: GLib.get_monotonic_time(), x, y};
    }

    _isSecondClick() {
        const removal = this._lastRemoval;
        const event = removal ? pointerEvent() : null;
        if (!event)
            return false;
        const settings = Clutter.Settings.get_default();
        const [x, y] = event.get_coords();
        const distance = settings.double_click_distance;
        return GLib.get_monotonic_time() - removal.time <= settings.double_click_time * 1000 &&
            Math.abs(x - removal.x) <= distance && Math.abs(y - removal.y) <= distance;
    }

    // ------------------------------------------------------------ header

    _syncHeader() {
        const service = this._service;
        const available = service.available;
        const count = this._rows.size;
        const dnd = service.doNotDisturb;

        let status = ngettext('%d notification', '%d notifications', count).format(count);
        if (dnd)
            status = _('Do Not Disturb · %s').format(status);
        this._status.text = available ? status : '';

        this._dndButton.visible = available;
        this._dndButton.checked = dnd;
        if (dnd)
            this._dndButton.add_accessible_state(Atk.StateType.CHECKED);
        else
            this._dndButton.remove_accessible_state(Atk.StateType.CHECKED);
        this._dndButton.reactive = service.canChangeDoNotDisturb;
        this._dndButton.can_focus = service.canChangeDoNotDisturb;

        const snapshot = this._clearSnapshot;
        const pending = snapshot !== null;
        const toClear = pending ? service.countClearable(snapshot) : 0;
        // A choice about to be hidden under the keyboard focus (the
        // question dropped: nothing left to clear) hands the focus back.
        const choiceFocused = !pending &&
            (this._keepButton.has_key_focus() || this._confirmButton.has_key_focus());
        this._confirmButton.visible = pending;
        this._confirmButton.label = ngettext('Clear %d?', 'Clear %d?', toClear).format(toClear);
        this._confirmButton.accessible_name =
            ngettext('Confirm: dismiss %d notification', 'Confirm: dismiss %d notifications', toClear)
                .format(toClear);
        this._keepButton.visible = pending;
        if (!pending)
            this._keepButton.min_width_set = false;
        this._clearButton.visible = available && count > 0 && !pending;
        if (choiceFocused)
            (this._clearButton.visible ? this._clearButton : this._dndButton).grab_key_focus();

        this._notice.visible = !available;
        this._empty.visible = available && count === 0;
        this._emptyDnd.visible = dnd;
        this._scroll.visible = count > 0;
    }

    // The hover bubble's time: "14:05", or "Tue 14:05" when not today.
    _when(datetime) {
        const today = GLib.DateTime.new_now_local().format('%F');
        const day = datetime.to_local().format('%F');
        return this._clock.formatTime(datetime.to_unix() * 1000, {weekday: day !== today});
    }

    _disconnectClock() {
        if (this._clockId) {
            this._clock.disconnect(this._clockId);
            this._clockId = 0;
        }
    }
}

/** The event being handled, when it is a click or a touch; else null. */
function pointerEvent() {
    const event = Clutter.get_current_event();
    switch (event?.type()) {
    case Clutter.EventType.BUTTON_PRESS:
    case Clutter.EventType.BUTTON_RELEASE:
    case Clutter.EventType.TOUCH_BEGIN:
    case Clutter.EventType.TOUCH_END:
        return event;
    default:
        return null;
    }
}
