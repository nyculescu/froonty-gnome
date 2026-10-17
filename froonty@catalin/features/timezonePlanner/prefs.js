// SPDX-License-Identifier: GPL-3.0-or-later
// Manage saved cities, the two Quick Settings favourites and the time format.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {choiceRow} from '../../prefs/rows.js';
import {
    decodeCity, encodeCity, isTimezoneIdentifier, MAX_FAVORITES, TIME_FORMATS,
} from './clock.js';

const CITIES_KEY = 'timezone-planner-cities';
const FAVORITES_KEY = 'timezone-planner-favorites';

function addCity(settings, name, timezone, showMessage) {
    name = name.trim();
    timezone = timezone.trim();
    if (!name || !timezone) {
        showMessage(_('Enter a city name and an IANA timezone ID.'));
        return;
    }
    if (name.includes('|')) {
        showMessage(_('A city name cannot contain “|”.'));
        return;
    }
    if (!isTimezoneIdentifier(timezone)) {
        showMessage(_('Use a valid IANA timezone ID, such as Europe/Dublin.'));
        return;
    }
    const cities = settings.get_strv(CITIES_KEY);
    if (cities.some(record => decodeCity(record)?.timezone === timezone)) {
        showMessage(_('That timezone is already in your city list.'));
        return;
    }
    if (!settings.set_strv(CITIES_KEY, [...cities, encodeCity(name, timezone)])) {
        showMessage(_('The city could not be saved.'));
        return;
    }
    showMessage('');
}

export function timezonesPage(settings) {
    const page = new Adw.PreferencesPage({
        name: 'time-zones',
        title: _('Time zones'),
        icon_name: 'clock-symbolic',
    });
    const cityGroup = new Adw.PreferencesGroup({
        title: _('Cities'),
        description: _('Add as many cities as you need. Mark at most two as favourites; those local times appear on the Quick Settings button.'),
    });
    const nameEntry = new Gtk.Entry({
        placeholder_text: _('City name'),
        hexpand: true,
        width_chars: 16,
    });
    const timezoneEntry = new Gtk.Entry({
        placeholder_text: _('IANA timezone ID, e.g. Europe/Dublin'),
        hexpand: true,
        width_chars: 24,
    });
    const addButton = new Gtk.Button({
        label: _('Add city'),
        valign: Gtk.Align.CENTER,
    });
    const addRow = new Adw.ActionRow({
        title: _('Add a city'),
        subtitle: _('Use the timezone database name, not a UTC offset.'),
    });
    const entries = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        valign: Gtk.Align.CENTER,
    });
    entries.append(nameEntry);
    entries.append(timezoneEntry);
    entries.append(addButton);
    addRow.add_suffix(entries);
    cityGroup.add(addRow);

    const messageRow = new Adw.ActionRow({visible: false});
    cityGroup.add(messageRow);

    const list = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 0,
    });
    cityGroup.add(list);
    page.add(cityGroup);

    const showMessage = text => {
        messageRow.title = text;
        messageRow.visible = Boolean(text);
    };
    const syncCities = () => {
        for (let child = list.get_first_child(); child;) {
            const next = child.get_next_sibling();
            list.remove(child);
            child = next;
        }
        const cities = settings.get_strv(CITIES_KEY).map(decodeCity).filter(Boolean);
        const favorites = settings.get_strv(FAVORITES_KEY);
        for (const city of cities) {
            const cityRow = new Adw.ActionRow({
                title: city.name,
                subtitle: city.timezone,
                use_markup: false,
            });
            const favorite = new Gtk.CheckButton({
                label: _('Favourite'),
                valign: Gtk.Align.CENTER,
                active: favorites.includes(city.timezone),
                tooltip_text: _('Show this city on the Quick Settings button'),
            });
            cityRow._timezonePlannerFavorite = favorite;
            let syncing = false;
            favorite.connect('notify::active', () => {
                if (syncing)
                    return;
                const next = settings.get_strv(FAVORITES_KEY);
                const selected = favorite.active;
                if (selected && !next.includes(city.timezone)) {
                    if (next.length >= MAX_FAVORITES) {
                        syncing = true;
                        favorite.active = false;
                        syncing = false;
                        showMessage(_('Choose no more than two favourite cities.'));
                        return;
                    }
                    next.push(city.timezone);
                } else if (!selected) {
                    const index = next.indexOf(city.timezone);
                    if (index >= 0)
                        next.splice(index, 1);
                }
                if (!settings.set_strv(FAVORITES_KEY, next)) {
                    syncing = true;
                    favorite.active = !selected;
                    syncing = false;
                    showMessage(_('The favourite could not be saved.'));
                } else {
                    showMessage('');
                }
            });
            const remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: _('Remove %s').format(city.name),
                valign: Gtk.Align.CENTER,
            });
            cityRow._timezonePlannerRemove = remove;
            remove.connect('clicked', () => {
                const selected = settings.get_strv(FAVORITES_KEY)
                    .filter(timezone => timezone !== city.timezone);
                if (!settings.set_strv(FAVORITES_KEY, selected)) {
                    showMessage(_('The city could not be removed from favourites.'));
                    return;
                }
                const remaining = settings.get_strv(CITIES_KEY)
                    .filter(record => decodeCity(record)?.timezone !== city.timezone);
                if (!settings.set_strv(CITIES_KEY, remaining))
                    showMessage(_('The city could not be removed.'));
            });
            cityRow.add_suffix(favorite);
            cityRow.add_suffix(remove);
            list.append(cityRow);
        }
    };

    const submit = () => {
        addCity(settings, nameEntry.text, timezoneEntry.text, showMessage);
        if (!messageRow.visible) {
            nameEntry.text = '';
            timezoneEntry.text = '';
        }
    };
    addButton.connect('clicked', submit);
    nameEntry.connect('activate', submit);
    timezoneEntry.connect('activate', submit);
    settings.connect(`changed::${CITIES_KEY}`, syncCities);
    settings.connect(`changed::${FAVORITES_KEY}`, syncCities);
    syncCities();

    const timesGroup = new Adw.PreferencesGroup({title: _('Times')});
    const formatRow = choiceRow(settings, 'timezone-planner-time-format', _('Time format'),
        TIME_FORMATS, [_('Same as the clock'), _('24-hour'), _('12-hour')]);
    formatRow.subtitle = _('In the planner and on the Quick Settings button');
    timesGroup.add(formatRow);
    page.add(timesGroup);
    return page;
}
