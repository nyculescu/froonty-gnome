// SPDX-License-Identifier: GPL-3.0-or-later
// Content of the collapsed pill: the time, optionally preceded by a short
// date, and the unread-notifications dot of GNOME's clock, which the pill
// covers.

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

export class CollapsedView {
    constructor() {
        this.actor = new St.BoxLayout({
            style_class: 'froonty-collapsed-row',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // GNOME's clock balances its dot with an empty pad on the other
        // side, so the time stays centered; so does the pill.
        this._unreadPad = this._addDot(this.actor);
        this._unreadPad.opacity = 0;

        const labels = new St.BoxLayout({
            style_class: 'froonty-collapsed',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(labels);
        this._dateLabel = this._addLabel(labels, 'froonty-collapsed-date');
        this._timeLabel = this._addLabel(labels, 'froonty-collapsed-time');

        this._unreadDot = this._addDot(this.actor);
    }

    /** @param {object} clock a ClockService snapshot */
    update(clock) {
        this._timeLabel.text = clock.time;
        this._dateLabel.text = clock.shortDate;
        this._dateLabel.visible = clock.showDate;
    }

    /** @param {boolean} unread whether GNOME's clock would show its dot */
    setUnread(unread) {
        this._unreadDot.visible = unread;
        this._unreadPad.visible = unread;
    }

    get accessibleText() {
        const text = this._dateLabel.visible
            ? `${this._dateLabel.text} ${this._timeLabel.text}`
            : this._timeLabel.text;
        return this._unreadDot.visible
            ? `${text}, ${_('unread notifications')}`
            : text;
    }

    _addLabel(box, styleClass) {
        const label = new St.Label({
            style_class: styleClass,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(label);
        return label;
    }

    _addDot(box) {
        const dot = new St.Widget({
            style_class: 'froonty-unread-dot',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        box.add_child(dot);
        return dot;
    }
}
