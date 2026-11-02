// SPDX-License-Identifier: GPL-3.0-or-later
// Readouts: the settings window's page (GTK 4 + libadwaita), driven through
// its widgets: up to 8 on the pill, and no 9th. Plain gjs, no Shell.
//
// tools/unit/run.sh gives it a display of its own. The page runs from a copy
// of its modules whose gettext import names a stub.

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {test, eq, ok, done, EXTENSION_DIR, makeSettings, sleep} from './test.js';

if (!GLib.getenv('FROONTY_UNIT_ISOLATED')) {
    printerr('Run this through tools/unit/run.sh (isolated TMPDIR/XDG_DATA_HOME, a private display).');
    imports.system.exit(2);
}

const PREFS_IMPORT = 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
Adw.init();
if (!Gdk.Display.get_default()) {
    printerr('No display: run this through tools/unit/run.sh (it starts a Broadway server).');
    imports.system.exit(1);
}

function copyModules() {
    const root = Gio.File.new_for_path(GLib.dir_make_tmp('froonty-ext-XXXXXX'));
    const stub = root.get_child('gettext-stub.js');
    stub.replace_contents('export const gettext = s => s;\n', null, false, 0, null);
    for (const folder of ['readouts', 'panic', 'prefs']) {
        const source = Gio.File.new_for_path(GLib.build_filenamev([EXTENSION_DIR, folder]));
        const target = root.get_child(folder);
        target.make_directory_with_parents(null);
        const children = source.enumerate_children('standard::name', 0, null);
        for (let info; (info = children.next_file(null));) {
            const name = info.get_name();
            if (!name.endsWith('.js'))
                continue;
            const [, bytes] = source.get_child(name).load_contents(null);
            const text = new TextDecoder().decode(bytes)
                .replaceAll(`'${PREFS_IMPORT}'`, `'${stub.get_uri()}'`);
            target.get_child(name).replace_contents(text, null, false, 0, null);
        }
    }
    return root.get_child('readouts');
}

const dir = copyModules();
const Catalog = await import(dir.get_child('catalog.js').get_uri());
const {readoutsPage} = await import(dir.get_child('prefs.js').get_uri());

const IDS = Catalog.READOUTS.map(r => r.id);
const titleOf = id => Catalog.byId(id).title(s => s);

function* descendants(widget) {
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        yield child;
        yield* descendants(child);
    }
}

function read(page) {
    const groups = {};
    for (const group of [...descendants(page)].filter(w => w instanceof Adw.PreferencesGroup)) {
        groups[group.title] = {
            rows: [...descendants(group)].filter(w => w instanceof Adw.ActionRow).map(row => ({
                title: row.title,
                add: [...descendants(row)].find(w => w instanceof Gtk.Button &&
                    w.icon_name === 'list-add-symbolic') ?? null,
            })),
        };
    }
    return groups;
}

test('empty by default; Add puts a readout on the pill', async () => {
    const settings = makeSettings();
    eq(settings.get_strv('readouts'), []);
    const page = readoutsPage(settings);
    let groups = read(page);
    eq(groups['On the pill'].rows.map(row => row.title), ['No readouts']);
    groups['Available'].rows.find(row => row.title === titleOf('cpu-load')).add.emit('clicked');
    await sleep(100);
    groups = read(page);
    eq(settings.get_strv('readouts'), ['cpu-load']);
    eq(groups['On the pill'].rows.map(row => row.title), [titleOf('cpu-load')]);
});

test('the pill takes up to 8; the 9th is refused', async () => {
    const settings = makeSettings();
    settings.set_strv('readouts', IDS.slice(0, 7));
    const page = readoutsPage(settings);
    let groups = read(page);
    const offered = groups['Available'].rows.find(row => row.title === titleOf(IDS[7]));
    ok(offered?.add?.sensitive, 'with 7, Add works');

    offered.add.emit('clicked');
    await sleep(100);
    groups = read(page);
    eq(settings.get_strv('readouts'), IDS.slice(0, 8));
    const ninth = groups['Available'].rows.find(row => row.title === titleOf(IDS[8]));
    ok(ninth?.add && !ninth.add.sensitive, 'with 8, Add is off');
    eq(ninth.add.tooltip_text, 'The pill holds at most 8 readouts');
});

await done();
