// SPDX-License-Identifier: GPL-3.0-or-later
// The Weather card: per city its weather icon and temperature, its name
// with the condition, feels-like and wind, and the next days' highs and
// lows; under them the link to Open-Meteo its terms ask for. Used in the
// Widgets tab and on the desktop.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ATTRIBUTION_URL, conditionOf} from './sources.js';

const degrees = value => (Number.isFinite(value) ? `${Math.round(value)}°` : '—');

// The icon's colour, by what it shows (stylesheet.css: sun yellow, rain
// blue, …), so it reads on any wallpaper.
function tone(icon) {
    for (const [part, name] of [['clear-night', 'night'], ['few-clouds-night', 'night'], ['clear', 'sun'],
        ['few-clouds', 'sun'], ['showers', 'rain'], ['snow', 'snow'], ['storm', 'storm'], ['fog', 'fog']]) {
        if (icon.includes(part))
            return name;
    }
    return 'cloud';
}

const weatherIcon = (style, icon, align) => new St.Icon({
    style_class: `${style} ${tone(icon)}`,
    icon_name: icon,
    ...align,
});

// "Today", then the weekday's short name.
function dayName(date, index) {
    if (index === 0)
        return _('Today');
    const [y, m, d] = date.split('-').map(Number);
    return GLib.DateTime.new_utc(y, m, d, 12, 0, 0)?.format('%a') ?? date;
}

export class WeatherView {
    constructor(service) {
        this._service = service;
        this._actions = true;
        this.actor = new St.BoxLayout({style_class: 'froonty-weather', vertical: true, x_expand: true});

        const header = new St.BoxLayout({style_class: 'froonty-widgets-header', x_expand: true});
        header.add_child(new St.Label({
            style_class: 'froonty-widgets-status',
            text: _('Weather'),
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._status = new St.Label({
            style_class: 'froonty-weather-status',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._status);
        this.actor.add_child(header);

        this._list = new St.BoxLayout({style_class: 'froonty-weather-list', vertical: true, x_expand: true});
        this.actor.add_child(this._list);

        this._credit = new St.Button({
            style_class: 'froonty-weather-credit',
            label: _('Weather data by Open-Meteo.com'),
            x_align: Clutter.ActorAlign.END,
            can_focus: true,
        });
        this._credit.connect('clicked', () => Gio.AppInfo.launch_default_for_uri(
            ATTRIBUTION_URL, global.create_app_launch_context(0, -1)));
        this.actor.add_child(this._credit);

        this._changedId = this._service.connect('changed', () => this._sync());
        this._sync();
    }

    /** Whether the link opens; off, the card takes no clicks (the desktop's "scrolling only"). */
    setActions(on) {
        this._actions = on;
        this._credit.reactive = on;
        this._credit.can_focus = on;
    }

    destroy() {
        this._service.disconnect(this._changedId);
        this.actor.destroy();
    }

    _sync() {
        const {readings, stale, error, refreshing} = this._service;
        this._list.destroy_all_children();
        for (const reading of readings)
            this._list.add_child(this._makeRow(reading));
        if (!readings.length) {
            const empty = new St.Label({
                style_class: 'froonty-weather-detail',
                text: error || (refreshing ? _('Fetching the weather…')
                    : _('No cities yet. Add up to 3 in Settings → Weather.')),
            });
            empty.clutter_text.line_wrap = true;
            this._list.add_child(empty);
        }

        if (refreshing)
            this._status.text = _('Updating…');
        else if (stale)
            this._status.text = _('Not updated: %s').format(error || _('offline'));
        else if (readings.length)
            this._status.text = _('At %s').format(GLib.DateTime.new_from_unix_local(
                Math.floor(readings[0].timeMs / 1000)).format('%H:%M'));
        else
            this._status.text = '';
        this._status.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    }

    _makeRow(reading) {
        const row = new St.BoxLayout({style_class: 'froonty-weather-row', x_expand: true});
        const now = conditionOf(reading.code, reading.isDay, _);
        row.add_child(weatherIcon('froonty-weather-icon', now.icon, {y_align: Clutter.ActorAlign.CENTER}));
        row.add_child(new St.Label({
            style_class: 'froonty-weather-temp',
            text: degrees(reading.temp),
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const names = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const name = new St.Label({style_class: 'froonty-weather-name', text: reading.name});
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        names.add_child(name);
        // The condition, then feels-like and wind, each on its own line (owner's request).
        const lines = [[now.label, 'froonty-weather-condition']];
        if (Number.isFinite(reading.feels))
            lines.push([_('Feels %s').format(degrees(reading.feels)), 'froonty-weather-detail']);
        if (Number.isFinite(reading.wind))
            lines.push([_('Wind %d km/h').format(Math.round(reading.wind)), 'froonty-weather-detail']);
        for (const [text, style] of lines) {
            const line = new St.Label({style_class: style, text});
            line.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            names.add_child(line);
        }
        row.add_child(names);

        for (const [index, day] of reading.days.entries()) {
            const column = new St.BoxLayout({style_class: 'froonty-weather-day', vertical: true});
            column.add_child(new St.Label({
                style_class: 'froonty-weather-day-name',
                text: dayName(day.date, index),
                x_align: Clutter.ActorAlign.CENTER,
            }));
            column.add_child(weatherIcon('froonty-weather-day-icon', conditionOf(day.code, true, _).icon,
                {x_align: Clutter.ActorAlign.CENTER}));
            // The high warm, the low cool.
            const range = new St.BoxLayout({style_class: 'froonty-weather-range', x_align: Clutter.ActorAlign.CENTER});
            range.add_child(new St.Label({style_class: 'froonty-weather-max', text: degrees(day.max)}));
            range.add_child(new St.Label({style_class: 'froonty-weather-min', text: degrees(day.min)}));
            column.add_child(range);
            row.add_child(column);
        }
        return row;
    }
}
