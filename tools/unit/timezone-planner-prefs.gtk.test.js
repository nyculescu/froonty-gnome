// SPDX-License-Identifier: GPL-3.0-or-later
// Time zone settings: add any number of cities and select no more than two
// favourites for Quick Settings.

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {done, eq, EXTENSION_DIR, makeSettings, ok, test} from './test.js';

if (!GLib.getenv('FROONTY_UNIT_ISOLATED')) {
    printerr('Run this through tools/unit/run.sh (isolated TMPDIR/XDG_DATA_HOME, a private display).');
    imports.system.exit(2);
}

const PREFS_IMPORT = 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
Adw.init();
imports.package.initFormat();
if (!Gdk.Display.get_default()) {
    printerr('No display: run this through tools/unit/run.sh (it starts a Broadway server).');
    imports.system.exit(1);
}

// The page and the shared rows it uses, laid out as in the extension.
function copyModules() {
    const root = Gio.File.new_for_path(GLib.dir_make_tmp('froonty-timezones-XXXXXX'));
    const stub = root.get_child('gettext-stub.js');
    stub.replace_contents('export const gettext = s => s;\n', null, false, 0, null);
    for (const path of ['features/timezonePlanner/clock.js',
        'features/timezonePlanner/prefs.js', 'prefs/rows.js']) {
        const source = Gio.File.new_for_path(GLib.build_filenamev([EXTENSION_DIR, path]));
        const target = root.resolve_relative_path(path);
        if (!target.get_parent().query_exists(null))
            target.get_parent().make_directory_with_parents(null);
        const [, bytes] = source.load_contents(null);
        const text = new TextDecoder().decode(bytes)
            .replaceAll(`'${PREFS_IMPORT}'`, `'${stub.get_uri()}'`);
        target.replace_contents(text, null, false, 0, null);
    }
    return root;
}

const {timezonesPage} = await import(
    copyModules().resolve_relative_path('features/timezonePlanner/prefs.js').get_uri());

function* descendants(widget) {
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        yield child;
        yield* descendants(child);
    }
}

function cityRows(page) {
    return [...descendants(page)].filter(widget => widget._timezonePlannerFavorite);
}

test('settings can add cities beyond the two favourite slots', () => {
    const settings = makeSettings();
    const page = timezonesPage(settings);
    const entries = [...descendants(page)].filter(widget => widget instanceof Gtk.Entry);
    const name = entries.find(entry => entry.placeholder_text === 'City name');
    const timezone = entries.find(entry => entry.placeholder_text.includes('IANA timezone ID'));
    const add = [...descendants(page)].find(widget =>
        widget instanceof Gtk.Button && widget.label === 'Add city');
    ok(name && timezone && add, 'city-name entry, timezone entry and Add city button are shown');

    name.text = 'Paris';
    timezone.text = 'Europe/Paris';
    add.emit('clicked');
    eq(settings.get_strv('timezone-planner-cities'), [
        'Dublin|Europe/Dublin', 'Timisoara|Europe/Bucharest', 'Paris|Europe/Paris',
    ]);
    eq(cityRows(page).length, 3);
    eq(settings.get_strv('timezone-planner-favorites'), ['Europe/Dublin', 'Europe/Bucharest']);
});

test('no more than two cities can be favourite, and favourites can be changed', () => {
    const settings = makeSettings();
    settings.set_strv('timezone-planner-cities', [
        'Dublin|Europe/Dublin', 'Timisoara|Europe/Bucharest', 'Paris|Europe/Paris',
    ]);
    const page = timezonesPage(settings);
    let rows = cityRows(page);
    eq(rows.map(row => row._timezonePlannerFavorite.active), [true, true, false]);

    rows[0]._timezonePlannerFavorite.active = false;
    rows = cityRows(page);
    rows[2]._timezonePlannerFavorite.active = true;
    eq(settings.get_strv('timezone-planner-favorites'), ['Europe/Bucharest', 'Europe/Paris']);

    rows = cityRows(page);
    rows[0]._timezonePlannerFavorite.active = true;
    eq(settings.get_strv('timezone-planner-favorites'), ['Europe/Bucharest', 'Europe/Paris']);
    ok(!rows[0]._timezonePlannerFavorite.active,
        'a third favourite is refused without changing the saved selection');
});

test('removing a city also removes it from the favourites', () => {
    const settings = makeSettings();
    settings.set_strv('timezone-planner-cities', [
        'Dublin|Europe/Dublin', 'Timisoara|Europe/Bucharest', 'Paris|Europe/Paris',
    ]);
    settings.set_strv('timezone-planner-favorites', ['Europe/Bucharest', 'Europe/Paris']);
    const page = timezonesPage(settings);
    const paris = cityRows(page).find(row => row.title === 'Paris');
    ok(paris?._timezonePlannerRemove, 'the city has a remove button');
    paris._timezonePlannerRemove.emit('clicked');
    eq(settings.get_strv('timezone-planner-cities'), [
        'Dublin|Europe/Dublin', 'Timisoara|Europe/Bucharest',
    ]);
    eq(settings.get_strv('timezone-planner-favorites'), ['Europe/Bucharest']);
});

test('the time format follows the clock by default and can be 24- or 12-hour', () => {
    const settings = makeSettings();
    const page = timezonesPage(settings);
    const row = [...descendants(page)].find(widget =>
        widget instanceof Adw.ComboRow && widget.title === 'Time format');
    ok(row, 'the page has a Time format row');
    eq(settings.get_string('timezone-planner-time-format'), 'clock');
    eq(row.selected, 0);
    eq([0, 1, 2].map(i => row.model.get_string(i)),
        ['Same as the clock', '24-hour', '12-hour']);

    row.selected = 2;
    eq(settings.get_string('timezone-planner-time-format'), '12h');
    settings.set_string('timezone-planner-time-format', '24h');
    eq(row.selected, 1);
});

await done();
