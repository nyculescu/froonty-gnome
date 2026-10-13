// SPDX-License-Identifier: GPL-3.0-or-later
// Time zone settings: add any number of cities and select no more than two
// favourites for Quick Settings.

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {done, eq, ok, test} from './test.js';

if (!GLib.getenv('FROONTY_UNIT_ISOLATED')) {
    printerr('Run this through tools/unit/run.sh (isolated TMPDIR/XDG_DATA_HOME, a private display).');
    imports.system.exit(2);
}

const PREFS_IMPORT = 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
const EXTENSION_DIR = GLib.build_filenamev([
    GLib.path_get_dirname(GLib.path_get_dirname(GLib.path_get_dirname(
        GLib.filename_from_uri(import.meta.url)[0]))),
    'froonty@catalin']);

Adw.init();
imports.package.initFormat();
if (!Gdk.Display.get_default()) {
    printerr('No display: run this through tools/unit/run.sh (it starts a Broadway server).');
    imports.system.exit(1);
}

function copyModules() {
    const root = Gio.File.new_for_path(GLib.dir_make_tmp('froonty-timezones-XXXXXX'));
    const stub = root.get_child('gettext-stub.js');
    stub.replace_contents('export const gettext = s => s;\n', null, false, 0, null);
    const source = Gio.File.new_for_path(GLib.build_filenamev([
        EXTENSION_DIR, 'features', 'timezonePlanner',
    ]));
    const target = root.get_child('timezonePlanner');
    target.make_directory_with_parents(null);
    for (const name of ['clock.js', 'prefs.js']) {
        const [, bytes] = source.get_child(name).load_contents(null);
        const text = new TextDecoder().decode(bytes)
            .replaceAll(`'${PREFS_IMPORT}'`, `'${stub.get_uri()}'`);
        target.get_child(name).replace_contents(text, null, false, 0, null);
    }
    return target;
}

const {timezonesPage} = await import(copyModules().get_child('prefs.js').get_uri());

function makeSettings() {
    const source = Gio.SettingsSchemaSource.new_from_directory(
        GLib.build_filenamev([EXTENSION_DIR, 'schemas']), null, false);
    return new Gio.Settings({
        settings_schema: source.lookup('org.gnome.shell.extensions.froonty', false),
        backend: Gio.memory_settings_backend_new(),
    });
}

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

await done();
