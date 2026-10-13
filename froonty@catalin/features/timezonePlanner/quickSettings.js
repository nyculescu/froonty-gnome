// SPDX-License-Identifier: GPL-3.0-or-later
// A GNOME Quick Settings button that opens the time zone planner.

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickSettingsItem} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {topBarWallClock} from '../../shell/dateMenu.js';
import {favoriteCities, formatTimeAt} from './clock.js';
import {TimezonePlanner} from './planner.js';

const PlannerButton = GObject.registerClass(
class PlannerButton extends QuickSettingsItem {
    _init(openPlanner) {
        super._init({
            style_class: 'quick-toggle button froonty-timezone-button',
            accessible_name: _('Time zone planner'),
            accessible_role: Atk.Role.PUSH_BUTTON,
            can_focus: true,
            track_hover: true,
        });
        const content = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        content.add_child(new St.Icon({
            icon_name: 'clock-symbolic',
            style_class: 'quick-toggle-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._label = new St.Label({
            text: '',
            style_class: 'quick-toggle-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        content.add_child(this._label);
        this.set_child(content);
        this.connect('clicked', openPlanner);
    }
});

export class TimezonePlannerPart {
    constructor(settings, openSettings) {
        this._settings = settings;
        this._openSettings = openSettings;
        this._planner = null;
        this._button = new PlannerButton(() => this._open());
        Main.panel.statusArea.quickSettings.menu.addItem(this._button);
        this._wallClock = topBarWallClock();
        this._minuteId = 0;
        this._settings.connectObject(
            'changed::timezone-planner-cities', () => this._syncButton(),
            'changed::timezone-planner-favorites', () => this._syncButton(), this);
        if (this._wallClock) {
            this._wallClock.connectObject(
                'notify::clock', () => this._syncButton(),
                'notify::timezone', () => this._syncButton(), this);
        } else {
            this._armMinute();
        }
        this._syncButton();
    }

    destroy() {
        this._planner?.close();
        this._planner = null;
        this._settings.disconnectObject(this);
        this._wallClock?.disconnectObject(this);
        this._wallClock = null;
        if (this._minuteId) {
            GLib.source_remove(this._minuteId);
            this._minuteId = 0;
        }
        this._button.destroy();
        this._button = null;
        this._settings = null;
        this._openSettings = null;
    }

    _armMinute() {
        const seconds = GLib.DateTime.new_now_utc().get_seconds();
        this._minuteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            Math.max(1, Math.ceil((60 - seconds) * 1000)), () => {
                this._minuteId = 0;
                this._syncButton();
                this._armMinute();
                return GLib.SOURCE_REMOVE;
            });
    }

    _syncButton() {
        const cities = favoriteCities(
            this._settings.get_strv('timezone-planner-cities'),
            this._settings.get_strv('timezone-planner-favorites'));
        const timestamp = GLib.DateTime.new_now_utc().to_unix();
        const text = cities.length
            ? cities.map(city => `${city.name} ${formatTimeAt(timestamp, city.timezone)}`).join('\n')
            : _('Choose favourites in Time zones settings');
        this._button._label.text = text;
        this._button.accessible_name = _('Time zone planner: %s').format(text);
    }

    _open() {
        Main.panel.statusArea.quickSettings.menu.close();
        if (this._planner) {
            this._planner.open();
            return;
        }
        this._planner = new TimezonePlanner(this._settings, this._openSettings);
        this._planner.connect('destroy', () => (this._planner = null));
        if (!this._planner.open()) {
            console.warn('Froonty: could not open the time zone planner modal');
            this._planner.destroy();
            this._planner = null;
        }
    }
}
