// SPDX-License-Identifier: GPL-3.0-or-later
// Clock tab: weekday, time and full date, centered.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

export class ClockView {
    /** @param {object} ctx feature context (see docs/local/ideas.md) */
    constructor(ctx) {
        this._clock = ctx.clock;

        this.actor = new St.BoxLayout({
            style_class: 'froonty-clock',
            vertical: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._weekdayLabel = this._addLabel('froonty-clock-weekday');
        this._timeLabel = this._addLabel('froonty-clock-time');
        this._dateLabel = this._addLabel('froonty-clock-date');

        this._clock.connectObject('changed', () => this._update(), this);
        this._update();
    }

    destroy() {
        this._clock.disconnectObject(this);
        this.actor.destroy();
    }

    _update() {
        const clock = this._clock.snapshot();
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
