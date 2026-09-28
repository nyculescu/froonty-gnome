// SPDX-License-Identifier: GPL-3.0-or-later
// Content of the expanded island. Phase 1 shows the clock and full date;
// later phases add rows (notifications, media, ...) below it.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

export class ExpandedView {
    constructor() {
        this.actor = new St.BoxLayout({
            style_class: 'froonty-expanded',
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._weekdayLabel = this._addLabel('froonty-expanded-weekday');
        this._timeLabel = this._addLabel('froonty-expanded-time');
        this._dateLabel = this._addLabel('froonty-expanded-date');
    }

    /** @param {object} clock a ClockService snapshot */
    update(clock) {
        this._weekdayLabel.text = clock.weekday;
        this._timeLabel.text = clock.time;
        this._dateLabel.text = clock.longDate;
    }

    _addLabel(styleClass) {
        const label = new St.Label({
            style_class: styleClass,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(label);
        return label;
    }
}
