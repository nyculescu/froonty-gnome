// SPDX-License-Identifier: GPL-3.0-or-later
// A modal Shell window to compare Vancouver with the selected favourite
// cities. The slider moves a real instant across a 24-hour planning window.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    favoriteCities, formatDateAt, formatTimeAt, sliderTimestamp, VANCOUVER_TIMEZONE,
} from './clock.js';

const row = styleClass => new St.BoxLayout({
    style_class: styleClass,
    x_expand: true,
});
const vertical = styleClass => new St.BoxLayout({
    style_class: styleClass,
    orientation: Clutter.Orientation.VERTICAL,
    x_expand: true,
});

function actionButton(label, accessibleName = label) {
    return new St.Button({
        label,
        style_class: 'button',
        can_focus: true,
        accessible_name: accessibleName,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

export const TimezonePlanner = GObject.registerClass(
class TimezonePlanner extends ModalDialog.ModalDialog {
    _init(settings, openSettings) {
        super._init({styleClass: 'froonty-timezone-dialog'});
        this._settings = settings;
        this._openSettings = openSettings;
        this._anchor = GLib.DateTime.new_now_utc().to_unix();
        this._cityTimeLabels = [];
        this._settingSlider = false;

        this.setButtons([{
            label: _('Close'),
            action: () => this.close(),
            key: Clutter.KEY_Escape,
        }]);

        const content = vertical('froonty-timezone-content');
        const title = new St.Label({
            text: _('Time zone planner'),
            style_class: 'froonty-timezone-title',
        });
        content.add_child(title);
        content.add_child(new St.Label({
            text: _('Move the slider to plan a time in Vancouver and compare the local hours.'),
            style_class: 'froonty-timezone-description',
            x_expand: true,
        }));

        const vancouver = row('froonty-timezone-city');
        vancouver.add_child(new St.Label({
            text: _('Vancouver'),
            style_class: 'froonty-timezone-name',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._vancouverDate = new St.Label({style_class: 'froonty-timezone-date'});
        this._vancouverTime = new St.Label({style_class: 'froonty-timezone-time'});
        vancouver.add_child(this._vancouverDate);
        vancouver.add_child(this._vancouverTime);
        content.add_child(vancouver);

        const sliderRange = row('froonty-timezone-range');
        sliderRange.add_child(new St.Label({text: _('-12 h')}));
        this._slider = new Slider(0.5);
        this._slider.accessible_name = _('Time in Vancouver');
        this._slider.x_expand = true;
        sliderRange.add_child(this._slider);
        sliderRange.add_child(new St.Label({text: _('+12 h')}));
        content.add_child(sliderRange);
        this._slider.connect('notify::value', () => {
            if (!this._settingSlider)
                this._updateTimes();
        });

        const controls = row('froonty-timezone-controls');
        controls.add_child(new St.Label({
            text: _('Selected Vancouver time'),
            style_class: 'froonty-timezone-hint',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const now = actionButton(_('Now'));
        now.connect('clicked', () => this._resetToNow());
        controls.add_child(now);
        content.add_child(controls);

        this._cityRows = vertical('froonty-timezone-cities');
        content.add_child(this._cityRows);

        this._message = new St.Label({
            style_class: 'froonty-timezone-message',
            x_expand: true,
            visible: false,
        });
        content.add_child(this._message);

        const settingsButton = actionButton(_('Manage cities…'));
        settingsButton.connect('clicked', () => {
            this.close();
            this._openSettings('time-zones');
        });
        content.add_child(settingsButton);
        this.contentLayout.add_child(content);

        this._settings.connectObject(
            'changed::timezone-planner-cities', () => this._syncCities(),
            'changed::timezone-planner-favorites', () => this._syncCities(), this);
        this.connect('destroy', () => this._settings.disconnectObject(this));
        this._syncCities();
        this._updateTimes();
    }

    _resetToNow() {
        this._anchor = GLib.DateTime.new_now_utc().to_unix();
        this._settingSlider = true;
        this._slider.value = 0.5;
        this._settingSlider = false;
        this._updateTimes();
    }

    _updateTimes() {
        const timestamp = sliderTimestamp(this._anchor, this._slider.value);
        this._vancouverDate.text = formatDateAt(timestamp, VANCOUVER_TIMEZONE);
        this._vancouverTime.text = formatTimeAt(timestamp, VANCOUVER_TIMEZONE);
        for (const city of this._cityTimeLabels) {
            city.date.text = formatDateAt(timestamp, city.timezone);
            city.time.text = formatTimeAt(timestamp, city.timezone);
        }
    }

    _syncCities() {
        for (const child of this._cityRows.get_children())
            child.destroy();
        this._cityTimeLabels = [];

        const cities = favoriteCities(
            this._settings.get_strv('timezone-planner-cities'),
            this._settings.get_strv('timezone-planner-favorites'));
        for (const city of cities) {
            const cityRow = row('froonty-timezone-city');
            cityRow.add_child(new St.Label({
                text: city.name,
                style_class: 'froonty-timezone-name',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            const date = new St.Label({style_class: 'froonty-timezone-date'});
            const time = new St.Label({style_class: 'froonty-timezone-time'});
            cityRow.add_child(date);
            cityRow.add_child(time);
            this._cityRows.add_child(cityRow);
            this._cityTimeLabels.push({date, time, timezone: city.timezone});
        }
        this._message.text = cities.length
            ? ''
            : _('Choose up to two favourite cities in Settings → Time zones.');
        this._message.visible = cities.length === 0;
        this._updateTimes();
    }

});
