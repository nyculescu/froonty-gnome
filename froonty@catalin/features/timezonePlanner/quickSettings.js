// SPDX-License-Identifier: GPL-3.0-or-later
// A GNOME Quick Settings button that opens the time zone planner in its
// menu, inside Quick Settings (planner.js).

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickSettingsItem} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {ClockService} from '../../services/clock.js';
import {
    dayOffsetAt, dayOffsetLabel, dayOffsetName, favoriteCities, formatTimeAt, plannerTimeFormat,
} from './clock.js';
import {TimezonePlanner} from './planner.js';

// More lines would stretch the other tile in its row; the menu shows all.
const BUTTON_CITIES = 2;

const PlannerButton = GObject.registerClass(
class PlannerButton extends QuickSettingsItem {
    _init(openPlanner) {
        super._init({
            style_class: 'quick-toggle button',
            accessible_name: _('Time zone planner'),
            accessible_role: Atk.Role.PUSH_BUTTON,
            can_focus: true,
            track_hover: true,
            hasMenu: true,
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
        this.connect('popup-menu', openPlanner);
    }
});

export class TimezonePlannerPart {
    constructor(settings, openSettings) {
        this._settings = settings;
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
        this._planner = new TimezonePlanner(this._button.menu, settings, openSettings,
            () => this._timeFormat());
        this._syncButton();
    }

    destroy() {
        this._planner.destroy();
        this._planner = null;
        this._settings.disconnectObject(this);
        this._clock.disconnectObject(this);
        this._clock.stop();
        this._clock = null;
        // Quick Settings keeps the menu in an overlay of its own
        // (ui/quickSettings.js, _completeAddItem): it goes too.
        this._button.menu.destroy();
        this._button.destroy();
        this._button = null;
        this._settings = null;
    }

    // The format chosen, or the island clock's (clock-format).
    _timeFormat() {
        return plannerTimeFormat(this._settings.get_string('timezone-planner-time-format'),
            this._clock.timeFormat());
    }

    _syncTimes() {
        this._syncButton();
        this._planner.updateTimes();
    }

    _syncButton() {
        const cities = favoriteCities(
            this._settings.get_strv('timezone-planner-cities'),
            this._settings.get_strv('timezone-planner-favorites')).slice(0, BUTTON_CITIES);
        const timestamp = GLib.DateTime.new_now_utc().to_unix();
        const format = this._timeFormat();
        // A raised +1 or −1 against the local date, as on the pill.
        const lines = cities.map(city => {
            const line = `${city.name} ${formatTimeAt(timestamp, city.timezone, format)}`;
            const offset = dayOffsetAt(timestamp, city.timezone);
            const badge = offset ? `<sup>${dayOffsetLabel(offset)}</sup>` : '';
            return {
                markup: `${GLib.markup_escape_text(line, -1)}${badge}`,
                spoken: offset ? `${line}, ${dayOffsetName(offset, _)}` : line,
            };
        });
        const empty = _('Choose favourites in Time zones settings');
        this._button._label.clutter_text.set_markup(lines.length
            ? lines.map(line => line.markup).join('\n') : GLib.markup_escape_text(empty, -1));
        this._button.accessible_name = _('Time zone planner: %s').format(lines.length
            ? lines.map(line => line.spoken).join('\n') : empty);
    }

    // Planning starts from the current time each time it opens.
    _open() {
        this._planner.resetToNow();
        this._button.menu.open();
    }
}
