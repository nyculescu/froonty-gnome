// SPDX-License-Identifier: GPL-3.0-or-later
// Content of the expanded island: the clock and full date in the middle and
// a settings button in the top-right corner. Later phases add rows
// (notifications, media, ...) below the clock.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

export class ExpandedView {
    /**
     * @param {object} actions
     * @param {Function} actions.openSettings called when ⚙️ is activated
     */
    constructor({openSettings}) {
        // BinLayout overlays the centered clock and the corner button.
        this.actor = new St.Widget({
            style_class: 'froonty-expanded',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });

        this._clockBox = new St.BoxLayout({
            style_class: 'froonty-expanded-clock',
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this._clockBox);

        this._weekdayLabel = this._addLabel('froonty-expanded-weekday');
        this._timeLabel = this._addLabel('froonty-expanded-time');
        this._dateLabel = this._addLabel('froonty-expanded-date');

        this.settingsButton = new St.Button({
            style_class: 'froonty-settings-button',
            accessible_name: _('Settings'),
            can_focus: true,
            track_hover: true,
            // Clutter.BinLayout honors a child's alignment only when the
            // child expands; otherwise it centers it.
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            child: new St.Icon({icon_name: 'emblem-system-symbolic'}),
        });
        this.settingsButton.connect('clicked', () => openSettings());
        this.actor.add_child(this.settingsButton);
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
        this._clockBox.add_child(label);
        return label;
    }
}
