// SPDX-License-Identifier: GPL-3.0-or-later
// Content of the collapsed pill: the time, optionally preceded by a short date.

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

export class CollapsedView {
    constructor() {
        this.actor = new St.BoxLayout({
            style_class: 'froonty-collapsed',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._dateLabel = this._addLabel('froonty-collapsed-date');
        this._timeLabel = this._addLabel('froonty-collapsed-time');
    }

    /** @param {object} clock a ClockService snapshot */
    update(clock) {
        this._timeLabel.text = clock.time;
        this._dateLabel.text = clock.shortDate;
        this._dateLabel.visible = clock.showDate;
    }

    get accessibleText() {
        return this._dateLabel.visible
            ? `${this._dateLabel.text} ${this._timeLabel.text}`
            : this._timeLabel.text;
    }

    _addLabel(styleClass) {
        const label = new St.Label({
            style_class: styleClass,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.actor.add_child(label);
        return label;
    }
}
