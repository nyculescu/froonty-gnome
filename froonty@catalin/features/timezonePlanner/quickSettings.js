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

import {ClockService} from '../../services/clock.js';
import {favoriteCities, formatTimeAt, plannerTimeFormat} from './clock.js';
import {TimezonePlanner} from './planner.js';

const PlannerButton = GObject.registerClass(
class PlannerButton extends QuickSettingsItem {
    _init(openPlanner) {
        super._init({
            style_class: 'quick-toggle button',
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
        // Before GNOME's Background Apps item, which it keeps last, as its
        // addExternalIndicator does (private: panel.js _backgroundApps).
        const quickSettings = Main.panel.statusArea.quickSettings;
        quickSettings.menu.insertItemBefore(this._button,
            quickSettings._backgroundApps?.quickSettingsItems?.at(-1) ?? null);
        this._settings.connectObject(
            'changed::timezone-planner-cities', () => this._syncButton(),
            'changed::timezone-planner-favorites', () => this._syncButton(),
            'changed::timezone-planner-time-format', () => this._syncTimes(), this);
        // Its own: the extension's clock exists only while the island does.
        // It also says when the clock format changes.
        this._clock = new ClockService(settings);
        this._clock.connectObject('changed', () => this._syncTimes(), this);
        this._clock.start();
        this._syncButton();
    }

    destroy() {
        this._planner?.close();
        this._planner = null;
        this._settings.disconnectObject(this);
        this._clock.disconnectObject(this);
        this._clock.stop();
        this._clock = null;
        this._button.destroy();
        this._button = null;
        this._settings = null;
        this._openSettings = null;
    }

    // The format chosen, or the island clock's (clock-format).
    _timeFormat() {
        return plannerTimeFormat(this._settings.get_string('timezone-planner-time-format'),
            this._clock.timeFormat());
    }

    _syncTimes() {
        this._syncButton();
        this._planner?.updateTimes();
    }

    _syncButton() {
        const cities = favoriteCities(
            this._settings.get_strv('timezone-planner-cities'),
            this._settings.get_strv('timezone-planner-favorites'));
        const timestamp = GLib.DateTime.new_now_utc().to_unix();
        const format = this._timeFormat();
        const text = cities.length
            ? cities.map(city =>
                `${city.name} ${formatTimeAt(timestamp, city.timezone, format)}`).join('\n')
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
        this._planner = new TimezonePlanner(this._settings, this._openSettings,
            () => this._timeFormat());
        this._planner.connect('destroy', () => (this._planner = null));
        if (!this._planner.open()) {
            console.warn('Froonty: could not open the time zone planner modal');
            this._planner.destroy();
            this._planner = null;
        }
    }
}
