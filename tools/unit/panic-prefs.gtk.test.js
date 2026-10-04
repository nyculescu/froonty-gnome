// SPDX-License-Identifier: GPL-3.0-or-later
// Panic buttons: the settings window's page (GTK 4 + libadwaita), driven
// through its widgets: up to 8 buttons in the bar, and no 9th. Plain gjs,
// no Shell.
//
// tools/unit/run.sh gives it a display of its own (a private Broadway
// server). As in notes-all-notes.gtk.test.js, the page runs from a copy of
// the panic modules whose gettext import names a stub. Froonty has fewer
// than 9 panic buttons yet: stand-ins are added to that copy's catalog.

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {test, eq, ok, done} from './test.js';

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
if (!Gdk.Display.get_default()) {
    printerr('No display: run this through tools/unit/run.sh (it starts a Broadway server).');
    imports.system.exit(1);
}

const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

function copyModules() {
    const root = Gio.File.new_for_path(GLib.dir_make_tmp('froonty-ext-XXXXXX'));
    const stub = root.get_child('gettext-stub.js');
    stub.replace_contents('export const gettext = s => s;\n', null, false, 0, null);
    const source = Gio.File.new_for_path(GLib.build_filenamev([EXTENSION_DIR, 'panic']));
    const target = root.get_child('panic');
    target.make_directory_with_parents(null);
    const children = source.enumerate_children('standard::name', 0, null);
    for (let info; (info = children.next_file(null));) {
        const name = info.get_name();
        if (!name.endsWith('.js'))
            continue;
        const [, bytes] = source.get_child(name).load_contents(null);
        const text = new TextDecoder().decode(bytes).replaceAll(`'${PREFS_IMPORT}'`, `'${stub.get_uri()}'`);
        target.get_child(name).replace_contents(text, null, false, 0, null);
    }
    return target;
}

const panicDir = copyModules();
const Catalog = await import(panicDir.get_child('catalog.js').get_uri());
const {panicPage} = await import(panicDir.get_child('prefs.js').get_uri());

const STAND_INS = Array.from({length: 10}, (_, i) => ({
    id: `stand-in-${i + 1}`,
    icon: 'dialog-information-symbolic',
    title: () => `Stand-in ${i + 1}`,
}));
Catalog.PANIC_BUTTONS.push(...STAND_INS);
const IDS = STAND_INS.map(b => b.id);

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

// The page as the user reads it: each group's rows, by title, with their
// Add button (the Available group's).
function read(page) {
    const groups = {};
    for (const group of [...descendants(page)].filter(w => w instanceof Adw.PreferencesGroup)) {
        groups[group.title] = {
            description: group.description,
            rows: [...descendants(group)].filter(w => w instanceof Adw.ActionRow).map(row => ({
                title: row.title,
                add: [...descendants(row)].find(w => w instanceof Gtk.Button &&
                    w.icon_name === 'list-add-symbolic') ?? null,
            })),
        };
    }
    return groups;
}

test('the bar takes up to 8 buttons; the 9th is refused', async () => {
    const settings = makeSettings();
    settings.set_strv('panic-buttons', IDS.slice(0, 7));
    const page = panicPage(settings);
    let groups = read(page);
    const bar = () => groups['In the bar'];
    const available = () => groups['Available'];
    ok(bar().description.startsWith('Up to 8 '), bar().description);
    eq(bar().rows.length, 7);
    const offered = available().rows.find(row => row.title === 'Stand-in 8');
    ok(offered?.add?.sensitive, 'with 7 in the bar, Add works');

    offered.add.emit('clicked');
    await sleep(100);
    groups = read(page);
    eq(settings.get_strv('panic-buttons'), IDS.slice(0, 8));
    eq(bar().rows.map(row => row.title), STAND_INS.slice(0, 8).map(b => b.title()));
    const ninth = available().rows.find(row => row.title === 'Stand-in 9');
    ok(ninth?.add && !ninth.add.sensitive, 'with 8 in the bar, Add is off');
    eq(ninth.add.tooltip_text, 'The bar holds at most 8 buttons');
    ok(available().rows.filter(row => row.add).every(row => !row.add.sensitive),
        'every Add is off');

    // A 9th written elsewhere (gsettings) is not shown.
    settings.set_strv('panic-buttons', IDS.slice(0, 9));
    await sleep(100);
    groups = read(page);
    eq(bar().rows.length, 8);
    ok(!bar().rows.some(row => row.title === 'Stand-in 9'));
});

await done();
