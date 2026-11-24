// SPDX-License-Identifier: GPL-3.0-or-later
// Settings → Widgets → System (GTK 4 + libadwaita): a switch per reading,
// following and setting widgets-system-metrics in the catalog's order, and
// the interval. Plain gjs, no Shell.
//
// tools/unit/run.sh gives it a display of its own. The page runs from a copy
// of its modules whose gettext import names a stub.

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import 'gi://Gtk?version=4.0';

import {test, eq, ok, done, EXTENSION_DIR, makeSettings} from './test.js';

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

// The page and rows.js with the gettext stub; the metrics from the tree.
function copyModules() {
    const root = Gio.File.new_for_path(GLib.dir_make_tmp('froonty-ext-XXXXXX'));
    const stub = root.get_child('gettext-stub.js');
    stub.replace_contents('export const gettext = s => s;\n', null, false, 0, null);
    const metrics = Gio.File.new_for_path(GLib.build_filenamev(
        [EXTENSION_DIR, 'features', 'widgets', 'system', 'metrics.js'])).get_uri();
    for (const path of ['features/widgets/system/prefs.js', 'prefs/rows.js']) {
        const [, bytes] = Gio.File.new_for_path(GLib.build_filenamev([EXTENSION_DIR, path])).load_contents(null);
        const text = new TextDecoder().decode(bytes)
            .replaceAll(`'${PREFS_IMPORT}'`, `'${stub.get_uri()}'`)
            .replaceAll('\'./metrics.js\'', `'${metrics}'`);
        const target = root.resolve_relative_path(path);
        GLib.mkdir_with_parents(target.get_parent().get_path(), 0o700);
        target.replace_contents(text, null, false, 0, null);
    }
    return root;
}

const dir = copyModules();
const {systemGroup} = await import(dir.resolve_relative_path('features/widgets/system/prefs.js').get_uri());

function* descendants(widget) {
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        yield child;
        yield* descendants(child);
    }
}

const switches = group => Object.fromEntries([...descendants(group)]
    .filter(w => w instanceof Adw.SwitchRow).map(row => [row.title, row]));

test('a switch per reading, on for the chosen ones; the interval', () => {
    const settings = makeSettings();
    const group = systemGroup(settings);
    const rows = switches(group);
    eq(Object.keys(rows).length, 13);
    eq(Object.entries(rows).filter(([, row]) => row.active).map(([title]) => title),
        ['CPU load', 'CPU temperature', 'RAM usage', 'Download speed', 'Upload speed']);
    const titles = [...descendants(group)].filter(w => w instanceof Adw.SpinRow || w instanceof Adw.ComboRow)
        .map(w => w.title);
    eq(titles, ['Refresh interval (s)', 'History (minutes)', 'Moving average', 'Order in each row']);
});

test('a switch adds or takes away its reading, kept in the catalog\'s order', () => {
    const settings = makeSettings();
    const rows = switches(systemGroup(settings));
    rows['GPU load'].active = true;
    rows['RAM usage'].active = false;
    eq(settings.get_strv('widgets-system-metrics'), ['cpu-load', 'cpu-temp', 'gpu-load', 'net-down', 'net-up']);
    settings.set_strv('widgets-system-metrics', ['disk-used']);
    eq(Object.entries(rows).filter(([, row]) => row.active).map(([title]) => title), ['Disk used']);
});

await done();
