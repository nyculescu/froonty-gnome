// SPDX-License-Identifier: GPL-3.0-or-later
// Settings → Weather: the feature's switch and up to 3 favourite cities,
// found with Open-Meteo's city search. Where the card shows is under
// Widgets (widgets/prefs.js, desktopPrefs.js).

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Soup from 'gi://Soup?version=3.0';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {switchRow} from '../../prefs/rows.js';
import {MAX_CITIES, parseSearch, searchUrl} from './sources.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const KEY = 'weather-cities';

const saved = settings => settings.get_value(KEY).deepUnpack();
const store = (settings, cities) => settings.set_value(KEY, new GLib.Variant('a(sdd)', cities));

export function weatherPage(settings) {
    const page = new Adw.PreferencesPage({
        name: 'weather',
        title: _('Weather'),
        icon_name: 'weather-few-clouds-symbolic',
    });
    const group = new Adw.PreferencesGroup({
        title: _('Weather'),
        description: _('Current conditions and the next days for up to 3 cities, from Open-Meteo, ' +
            'every 15 minutes while the card shows. Free for non-commercial use, without a key; ' +
            'the card links to Open-Meteo, as its terms ask.'),
    });
    group.add(switchRow(settings, 'weather-enabled', _('Weather'),
        _('Off, the card shows nowhere and nothing is fetched')));
    page.add(group);
    page.add(citiesGroup(settings));
    page.add(searchGroup(settings));
    return page;
}

function citiesGroup(settings) {
    const group = new Adw.PreferencesGroup({title: _('Cities')});
    let rows = [];
    const sync = () => {
        for (const row of rows)
            group.remove(row);
        const cities = saved(settings);
        rows = cities.map(([name, lat, lon], index) => {
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(name, -1),
                subtitle: `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
            });
            const remove = new Gtk.Button({label: _('Remove'), valign: Gtk.Align.CENTER, css_classes: ['flat']});
            remove.connect('clicked', () => store(settings, saved(settings).filter((_c, i) => i !== index)));
            row.add_suffix(remove);
            return row;
        });
        if (!rows.length)
            rows = [new Adw.ActionRow({title: _('None yet: find one below')})];
        for (const row of rows)
            group.add(row);
    };
    settings.connect(`changed::${KEY}`, sync);
    sync();
    return group;
}

function searchGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('Add a city'),
        description: _('Type a city or a neighbourhood and press Enter.'),
    });
    const entry = new Adw.EntryRow({title: _('City'), show_apply_button: true});
    group.add(entry);
    let results = [];
    const clear = () => {
        for (const row of results)
            group.remove(row);
        results = [];
    };
    const show = rows => {
        clear();
        results = rows;
        for (const row of rows)
            group.add(row);
    };
    const search = async () => {
        const text = entry.text.trim();
        if (!text)
            return;
        show([new Adw.ActionRow({title: _('Searching…')})]);
        let places;
        try {
            const session = new Soup.Session({timeout: 15, user_agent: 'Froonty'});
            const message = Soup.Message.new('GET', searchUrl(text));
            const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
            places = parseSearch(new TextDecoder().decode(bytes.toArray()));
        } catch (e) {
            show([new Adw.ActionRow({title: _('The search failed: %s').format(GLib.markup_escape_text(e.message, -1))})]);
            return;
        }
        if (!places.length) {
            show([new Adw.ActionRow({title: _('No place by that name')})]);
            return;
        }
        const full = saved(settings).length >= MAX_CITIES;
        show(places.map(place => {
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(place.name, -1),
                subtitle: GLib.markup_escape_text(place.detail, -1),
            });
            const add = new Gtk.Button({
                label: _('Add'),
                valign: Gtk.Align.CENTER,
                sensitive: !full,
                tooltip_text: full ? _('Up to %d cities; remove one first').format(MAX_CITIES) : null,
            });
            add.connect('clicked', () => {
                const cities = saved(settings);
                if (cities.length < MAX_CITIES)
                    store(settings, [...cities, [place.name, place.lat, place.lon]]);
                entry.text = '';
                clear();
            });
            row.add_suffix(add);
            return row;
        }));
    };
    // With the apply button shown, Enter emits 'apply' too.
    entry.connect('apply', () => search());
    return group;
}
