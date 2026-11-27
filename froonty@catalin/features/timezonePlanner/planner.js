// SPDX-License-Identifier: GPL-3.0-or-later
// The planner in its Quick Settings button's menu, which opens inside
// Quick Settings as Software brightness's does: Vancouver and the
// favourite cities. The slider moves a real instant across a 24-hour
// planning window.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    dayOffsetAt, dayOffsetLabel, favoriteCities, formatDateAt, formatTimeAt, sliderTimestamp,
    VANCOUVER_TIMEZONE,
} from './clock.js';

// A row that is not an action: what is in it takes the pointer itself.
const row = () => new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});

const label = (text, styleClass = null, xExpand = false) => new St.Label({
    text,
    style_class: styleClass,
    x_expand: xExpand,
    y_align: Clutter.ActorAlign.CENTER,
});

// The dates, times and +1 or −1 keep a fixed width, so they line up across
// rows; Vancouver's row has the room for the +1 too.
function cityRow(name) {
    const item = row();
    item.add_child(label(name, 'froonty-timezone-name', true));
    const date = label('', 'froonty-timezone-date');
    const time = label('', 'froonty-timezone-time');
    const badge = new St.Label({style_class: 'froonty-timezone-badge', y_align: Clutter.ActorAlign.START});
    item.add_child(date);
    item.add_child(time);
    item.add_child(badge);
    return {item, date, time, badge};
}

function wrapped(text, styleClass) {
    const item = row();
    const line = label(text, styleClass, true);
    line.clutter_text.set({line_wrap: true, ellipsize: Pango.EllipsizeMode.NONE});
    item.add_child(line);
    return {item, line};
}

export class TimezonePlanner {
    // menu: the button's menu. timeFormat() gives the strftime format to
    // write times in.
    constructor(menu, settings, openSettings, timeFormat) {
        this._settings = settings;
        this._timeFormat = timeFormat;
        this._anchor = GLib.DateTime.new_now_utc().to_unix();
        this._cityTimeLabels = [];
        this._settingSlider = false;

        menu.setHeader('clock-symbolic', _('Time zone planner'));
        menu.addMenuItem(wrapped(
            _('Move the slider to plan a time in Vancouver and compare the local hours.'),
            'froonty-timezone-description').item);

        const vancouver = cityRow(_('Vancouver'));
        this._vancouverDate = vancouver.date;
        this._vancouverTime = vancouver.time;
        menu.addMenuItem(vancouver.item);

        const range = row();
        range.add_child(label(_('-12 h')));
        this._slider = new Slider(0.5);
        this._slider.accessible_name = _('Time in Vancouver');
        this._slider.x_expand = true;
        range.add_child(this._slider);
        range.add_child(label(_('+12 h')));
        menu.addMenuItem(range);
        this._slider.connect('notify::value', () => {
            if (!this._settingSlider)
                this.updateTimes();
        });

        const controls = row();
        controls.add_child(label(_('Selected Vancouver time'), 'froonty-timezone-hint', true));
        const now = new St.Button({
            label: _('Now'),
            style_class: 'button',
            can_focus: true,
            accessible_name: _('Now'),
            y_align: Clutter.ActorAlign.CENTER,
        });
        now.connect('clicked', () => this.resetToNow());
        controls.add_child(now);
        menu.addMenuItem(controls);

        this._cities = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._cities);

        const message = wrapped(_('Choose up to five favourite cities in Settings → Time zones.'),
            'froonty-timezone-message');
        this._message = message.item;
        menu.addMenuItem(this._message);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction(_('Manage cities…'), () => {
            Main.panel.closeQuickSettings();
            openSettings('time-zones');
        });

        this._settings.connectObject(
            'changed::timezone-planner-cities', () => this._syncCities(),
            'changed::timezone-planner-favorites', () => this._syncCities(), this);
        this._syncCities();
    }

    // The menu goes with its button.
    destroy() {
        this._settings.disconnectObject(this);
        this._settings = null;
    }

    resetToNow() {
        this._anchor = GLib.DateTime.new_now_utc().to_unix();
        this._settingSlider = true;
        this._slider.value = 0.5;
        this._settingSlider = false;
        this.updateTimes();
    }

    // Also when the time format changes.
    updateTimes() {
        const timestamp = sliderTimestamp(this._anchor, this._slider.value);
        const format = this._timeFormat();
        this._vancouverDate.text = formatDateAt(timestamp, VANCOUVER_TIMEZONE);
        this._vancouverTime.text = formatTimeAt(timestamp, VANCOUVER_TIMEZONE, format);
        // +1 or −1 against the Vancouver date on the slider.
        const vancouver = GLib.TimeZone.new_identifier(VANCOUVER_TIMEZONE);
        for (const city of this._cityTimeLabels) {
            city.date.text = formatDateAt(timestamp, city.timezone);
            city.time.text = formatTimeAt(timestamp, city.timezone, format);
            city.badge.text = dayOffsetLabel(dayOffsetAt(timestamp, city.timezone, vancouver));
        }
    }

    _syncCities() {
        this._cities.removeAll();
        this._cityTimeLabels = [];
        const cities = favoriteCities(
            this._settings.get_strv('timezone-planner-cities'),
            this._settings.get_strv('timezone-planner-favorites'));
        for (const city of cities) {
            const {item, date, time, badge} = cityRow(city.name);
            this._cities.addMenuItem(item);
            this._cityTimeLabels.push({date, time, badge, timezone: city.timezone});
        }
        this._message.visible = cities.length === 0;
        this.updateTimes();
    }
}
