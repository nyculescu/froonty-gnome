// SPDX-License-Identifier: GPL-3.0-or-later
// Settings → Widgets → On the desktop (GTK 4 + libadwaita): the switches,
// the picture of the desktop with each item's box where the Shell put it,
// the selected item's rows, arrow keys and Reset. Plain gjs, no Shell.
//
// tools/unit/run.sh gives it a display of its own. The page runs from a copy
// of its modules whose gettext import names a stub.

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

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

function copyModules() {
    const root = Gio.File.new_for_path(GLib.dir_make_tmp('froonty-ext-XXXXXX'));
    const stub = root.get_child('gettext-stub.js');
    stub.replace_contents('export const gettext = s => s;\n', null, false, 0, null);
    for (const path of ['features/widgets/desktopPrefs.js', 'features/widgets/placement.js', 'prefs/rows.js']) {
        const source = Gio.File.new_for_path(GLib.build_filenamev([EXTENSION_DIR, path]));
        const [, bytes] = source.load_contents(null);
        const text = new TextDecoder().decode(bytes).replaceAll(`'${PREFS_IMPORT}'`, `'${stub.get_uri()}'`);
        const target = root.resolve_relative_path(path);
        GLib.mkdir_with_parents(target.get_parent().get_path(), 0o700);
        target.replace_contents(text, null, false, 0, null);
    }
    return root;
}

const dir = copyModules();
const {changePlacement, desktopGroups, keyChange} =
    await import(dir.resolve_relative_path('features/widgets/desktopPrefs.js').get_uri());

function* descendants(widget) {
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        yield child;
        yield* descendants(child);
    }
}

const flush = () => {
    while (GLib.MainContext.default().iteration(false)) { /* drain */ }
};

const PLACEMENT = 'widgets-desktop-positions';
// The page's three groups in one box, as the page holds them.
function desktopGroup(settings) {
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
    for (const group of desktopGroups(settings))
        box.append(group);
    return box;
}
const placement = settings => settings.get_value(PLACEMENT).deepUnpack();
// The Shell's geometry: a 1920×1080 monitor, a 32 px top bar, a 64 px dock
// on the left; Markets shown at the top left of the work area.
const GEOMETRY = {monitor: [0, 0, 1920, 1080], work: [64, 32, 1856, 1048], dock: [0, 600, 64, 400],
    markets: [64, 32, 386, 445]};
const SCALE = 560 / 1920;

function boxes(group) {
    const fixed = [...descendants(group)].find(w => w instanceof Gtk.Fixed);
    const found = {};
    for (let box = fixed.get_first_child(); box; box = box.get_next_sibling()) {
        const [x, y] = fixed.get_child_transform(box)?.to_translate() ?? [0, 0];
        found[box.get_first_child().label] = {x, y, width: box.width_request, tooltip: box.tooltip_text, off: box.has_css_class('off'),
            selected: box.has_css_class('selected')};
    }
    return found;
}

test('a switch for all and one per item; everything greyed out while all are off', () => {
    const settings = makeSettings();
    const group = desktopGroup(settings);
    const all = [...descendants(group)];
    eq(all.filter(w => w instanceof Adw.SwitchRow).map(r => r.title),
        ['Show widgets on the desktop', 'Markets', 'Horizon news', 'System', 'Notes stickies', 'Clicks on Markets and Horizon']);
    settings.set_boolean('widgets-desktop-enabled', false);
    flush();
    const greyed = all.filter(w => (w instanceof Adw.SwitchRow && w.title !== 'Show widgets on the desktop') ||
        w.has_css_class?.('froonty-desktop-picture'));
    ok(greyed.length >= 6 && greyed.every(w => !w.sensitive), greyed.map(w => `${w.title ?? 'picture'}=${w.sensitive}`).join(' '));
});

test('the picture: boxes where the Shell put them, scaled; dimmed while not on the desktop', () => {
    const settings = makeSettings();
    settings.set_value('widgets-desktop-geometry', new GLib.Variant('a{s(iiii)}', GEOMETRY));
    const group = desktopGroup(settings);
    flush();
    const b = boxes(group);
    // Shown items as the Shell reported them.
    eq([b.Markets.x, b.Markets.y, b.Markets.off], [Math.round(64 * SCALE), Math.round(32 * SCALE), false],
        'where the Shell put it: ' + JSON.stringify(b));
    eq([b['Horizon news'].off, b.System.off], [true, true]);
    ok(!b['Notes stickies'], 'no stickies until the Shell lists them');
    // No room under the dock: Horizon would go beside Markets, never over it.
    ok(b['Horizon news'].y > b.Markets.y || b['Horizon news'].x >= b.Markets.x + b.Markets.width,
        'Horizon would go under or beside Markets');
    eq(b.Markets.selected, true, 'Markets selected first');
    const titled = [...descendants(group)].filter(w => w instanceof Adw.PreferencesGroup).map(g => g.title);
    eq(titled, ['On the desktop', ''], 'the switches, then the picture; no size rows');
});

test('no corner, shift or size rows: sizes are dragged on the picture; a change is kept in range', () => {
    const settings = makeSettings();
    const group = desktopGroup(settings);
    ok(![...descendants(group)].some(w => w instanceof Gtk.Scale || w instanceof Adw.ComboRow));
    changePlacement(settings, 'markets', {width: 500});
    eq(placement(settings).markets, [0, 0, 500, 0]);
    changePlacement(settings, 'news', {y: 90000, height: 5});
    eq(placement(settings).news, [0, 10000, 360, 120]);
});

test('arrow keys: 1 % of the box\'s room that way; with Shift, 10 px of size', () => {
    const p = {x: 500, y: 500, width: 360, height: 0};
    eq(keyChange(p, Gdk.KEY_Right, false, 300), {x: 600});
    eq(keyChange(p, Gdk.KEY_Up, false, 300), {y: 400});
    eq(keyChange(p, Gdk.KEY_Left, true, 300), {width: 350});
    eq(keyChange(p, Gdk.KEY_Down, true, 300), {height: 310}, 'from its height as shown');
    eq(keyChange(p, Gdk.KEY_a, false, 300), null);
});

test('each pinned note is its own box, "Notes sticky N" in pin order, with its own place', () => {
    const settings = makeSettings();
    settings.set_value('widgets-desktop-geometry', new GLib.Variant('a{s(iiii)}', {...GEOMETRY,
        'sticky:Shopping': [1594, 32, 326, 200], 'sticky:Ideas': [1594, 244, 326, 150]}));
    const group = desktopGroup(settings);
    flush();
    const b = boxes(group);
    ok(b['Notes sticky 1'] && b['Notes sticky 2'], JSON.stringify(Object.keys(b)));
    ok(b['Notes sticky 2'].y > b['Notes sticky 1'].y, 'where the Shell put them');
    eq(b['Notes sticky 1'].tooltip, 'Notes sticky 1: Shopping', 'its note named in the tooltip');
    changePlacement(settings, 'sticky:Ideas', {width: 420});
    changePlacement(settings, 'markets', {width: 400});
    eq(placement(settings)['sticky:Ideas'], [10000, 0, 420, 300], 'kept when another item changes');
});

test('Reset layout gives the default placement back', () => {
    const settings = makeSettings();
    const group = desktopGroup(settings);
    changePlacement(settings, 'markets', {x: 5000});
    [...descendants(group)].find(w => w instanceof Gtk.Button && w.label === 'Reset layout').emit('clicked');
    flush();
    eq(placement(settings).markets, [0, 0, 360, 0]);
});

await done();
