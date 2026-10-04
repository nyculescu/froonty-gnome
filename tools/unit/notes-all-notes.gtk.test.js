// SPDX-License-Identifier: GPL-3.0-or-later
// Notes: the settings window's All notes page (GTK 4 + libadwaita), driven
// through its widgets against temporary notes folders: search, label chips,
// All/Any, Clear, the note pane's Labels menu and formatting bar, and what
// happens to the open note when the folder changes, a save fails, the
// search hides it or the island moves on. Plain gjs, no Shell.
//
// tools/unit/run.sh gives it a display of its own: a private Broadway
// server (GTK's HTML5 backend; nothing shows on screen). The page imports
// gettext from the preferences service's resource, which only exists in
// that process; the test runs a copy of the extension's modules in which
// that one import names a stub instead (nothing else differs).

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

// "%s".format(), as the preferences service sets it up (its main.js).
imports.package.initFormat();

Adw.init();
if (!Gdk.Display.get_default()) {
    printerr('No display: run this through tools/unit/run.sh (it starts a Broadway server).');
    imports.system.exit(1);
}
// Page transitions finish at once.
Gtk.Settings.get_default().gtk_enable_animations = false;

const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

async function waitFor(predicate, timeoutMs = 5000) {
    for (let waited = 0; waited < timeoutMs; waited += 50) {
        if (predicate())
            return true;
        // eslint-disable-next-line no-await-in-loop
        await sleep(50);
    }
    return predicate();
}

// Folder events (inotify, then GIO's rate limit for changes); autosave.
const SETTLE = 1500;
const AUTOSAVE = 1200;

// ---- the modules under test, with the gettext import pointing at a stub
// (and the notes' bundled icons, which the pane loads by path)

function copyModules() {
    const root = Gio.File.new_for_path(GLib.dir_make_tmp('froonty-ext-XXXXXX'));
    const stub = root.get_child('gettext-stub.js');
    stub.replace_contents([
        'export const gettext = s => s;',
        'export const ngettext = (one, many, n) => (n === 1 ? one : many);',
        'export const pgettext = (_context, s) => s;',
    ].join('\n'), null, false, 0, null);
    for (const dir of ['core', 'features/notes', 'features/notes/icons']) {
        const source = Gio.File.new_for_path(GLib.build_filenamev([EXTENSION_DIR, dir]));
        const target = root.resolve_relative_path(dir);
        target.make_directory_with_parents(null);
        const children = source.enumerate_children('standard::name,standard::type', 0, null);
        for (let info; (info = children.next_file(null));) {
            const name = info.get_name();
            if (info.get_file_type() !== Gio.FileType.REGULAR)
                continue;
            if (!name.endsWith('.js')) {
                source.get_child(name).copy(target.get_child(name), Gio.FileCopyFlags.NONE, null, null);
                continue;
            }
            const [, bytes] = source.get_child(name).load_contents(null);
            const text = new TextDecoder().decode(bytes)
                .replaceAll(`'${PREFS_IMPORT}'`, `'${stub.get_uri()}'`);
            target.get_child(name).replace_contents(text, null, false, 0, null);
        }
    }
    return root;
}

const {attachAllNotes} = await import(
    copyModules().resolve_relative_path('features/notes/allNotesPage.js').get_uri());

// ---- folders, settings, the window

function makeSettings(folder) {
    const source = Gio.SettingsSchemaSource.new_from_directory(
        GLib.build_filenamev([EXTENSION_DIR, 'schemas']), null, false);
    const settings = new Gio.Settings({
        settings_schema: source.lookup('org.gnome.shell.extensions.froonty', false),
        backend: Gio.memory_settings_backend_new(),
    });
    settings.set_string('notes-folder', folder.get_path());
    return settings;
}

function tempFolder(notes = {}) {
    const dir = Gio.File.new_for_path(GLib.dir_make_tmp('froonty-window-XXXXXX'));
    for (const [name, text] of Object.entries(notes))
        write(dir, `${name}.md`, text);
    return dir;
}

function write(dir, file, text) {
    dir.get_child(file).replace_contents(text, null, false, 0, null);
}

function read(dir, file) {
    return new TextDecoder().decode(dir.get_child(file).load_contents(null)[1]);
}

const setMode = (file, mode) =>
    file.set_attribute_uint32('unix::mode', mode, Gio.FileQueryInfoFlags.NONE, null);

function* walk(widget) {
    yield widget;
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling())
        yield* walk(child);
}

const find = (root, predicate) => {
    for (const widget of walk(root)) {
        if (predicate(widget))
            return widget;
    }
    return null;
};

// The page, found through its widgets (as a user would).
class Ui {
    constructor(window) {
        this.window = window;
    }

    get page() {
        return find(this.window, w => w instanceof Adw.NavigationPage && w.tag === 'all-notes' &&
            w.get_mapped());
    }

    get search() {
        return find(this.page, w => w instanceof Gtk.SearchEntry);
    }

    get list() {
        return find(this.page, w => w instanceof Gtk.ListBox && w.has_css_class('navigation-sidebar'));
    }

    get rows() {
        const rows = [];
        for (let row = this.list.get_first_child(); row; row = row.get_next_sibling()) {
            if (row._noteName)
                rows.push(row);
        }
        return rows;
    }

    get rowNames() {
        return this.rows.map(row => row._noteName);
    }

    get selectedRow() {
        return this.list.get_selected_row()?._noteName ?? null;
    }

    get chips() {
        const box = find(this.page, w => w instanceof Adw.WrapBox);
        const chips = [];
        for (let chip = box.get_first_child(); chip; chip = chip.get_next_sibling())
            chips.push(chip);
        return chips;
    }

    chip(label) {
        return this.chips.find(c => find(c, w => w instanceof Gtk.Label && w.label === label));
    }

    get mode() {
        return find(this.page, w => w instanceof Adw.ToggleGroup);
    }

    get clear() {
        return find(this.page, w => w instanceof Gtk.Button && w.label === 'Clear');
    }

    get editor() {
        return find(this.page, w => w instanceof Gtk.TextView);
    }

    get text() {
        return this.editor.buffer.text;
    }

    // The note pane's title: the open note.
    get open() {
        const stack = find(this.page, w => w instanceof Gtk.Stack);
        if (stack.visible_child_name !== 'note')
            return null;
        return find(stack, w => w instanceof Gtk.Label && w.has_css_class('title-4')).label;
    }

    get banners() {
        const banners = [];
        for (const w of walk(this.page)) {
            if (w instanceof Adw.Banner && w.revealed)
                banners.push(w.title);
        }
        return banners;
    }

    get labelsButton() {
        return find(this.page, w => w instanceof Gtk.MenuButton && w.label === 'Labels');
    }

    get formatBar() {
        return find(this.page, w => w instanceof Gtk.Box && w.has_css_class('froonty-format-bar'));
    }

    // A button of the formatting bar, by its tooltip (its accessible name).
    format(name) {
        return find(this.formatBar, w => w instanceof Gtk.Button && w.tooltip_text === name);
    }

    get formatButtons() {
        const buttons = [];
        for (let b = this.formatBar.get_first_child(); b; b = b.get_next_sibling())
            buttons.push(b);
        return buttons;
    }

    // The tooltips of the lit toggles (Wrap lines left out).
    get lit() {
        return this.formatButtons.filter(b => b instanceof Gtk.ToggleButton && b.active &&
            b.tooltip_text !== 'Wrap lines').map(b => b.tooltip_text);
    }

    get foldButton() {
        return find(this.page, w => w instanceof Gtk.Button && /formatting tools/.test(w.tooltip_text ?? ''));
    }

    // Selects [start, end) in the editor, the cursor at `end` (character
    // offsets); a bare cursor without `end`.
    select(start, end = start) {
        const buffer = this.editor.buffer;
        buffer.select_range(buffer.get_iter_at_offset(end), buffer.get_iter_at_offset(start));
    }

    // [selection bound, cursor], as character offsets.
    get selection() {
        const buffer = this.editor.buffer;
        return [buffer.get_selection_bound(), buffer.get_insert()]
            .map(mark => buffer.get_iter_at_mark(mark).get_offset());
    }

    // A click on a bar button (a toggle flips itself first, as on a click).
    click(name) {
        const button = this.format(name);
        if (!button)
            throw new Error(`no "${name}" button`);
        button.emit('clicked');
    }

    // Typing at the cursor, as a key press does (honours read-only).
    type(text) {
        this.editor.emit('insert-at-cursor', text);
    }

    async searchFor(query) {
        this.search.text = query;
        await sleep(400); // the entry's search delay
    }
}

async function openWindow(dir, {last = '', view = 'all-notes'} = {}) {
    const settings = makeSettings(dir);
    settings.set_string('notes-last', last);
    settings.set_string('settings-window-view', view);
    const window = new Adw.PreferencesWindow();
    window.add(new Adw.PreferencesPage({title: 'General'}));
    attachAllNotes(window, settings);
    window.present();
    const ui = new Ui(window);
    if (view === 'all-notes')
        await waitFor(() => ui.page && ui.rows.length > 0 && ui.open !== null);
    return {window, settings, ui};
}

async function closeWindow(window) {
    window.close();
    await sleep(300);
}

// Leaves the page by its back arrow, and comes back (the island's button).
async function hidePage(settings, ui) {
    settings.set_string('settings-window-view', 'settings');
    await waitFor(() => !ui.page);
}

async function showPage(settings, ui) {
    settings.set_string('settings-window-view', 'all-notes');
    await waitFor(() => Boolean(ui.page));
    await sleep(300);
}

// ---- search, labels and the filter

test('window: the search lists matching notes with the matches in bold', async () => {
    const dir = tempFolder({
        Plan: '# Q4 plan\nShip the café menu by Friday',
        Groceries: 'milk\nbread',
        Ideas: 'Plan a party',
    });
    const {window, ui} = await openWindow(dir, {last: 'Plan'});
    eq(ui.open, 'Plan', 'opens on the island\'s note');
    eq(ui.rowNames.length, 3);
    await ui.searchFor('cafe');
    eq(ui.rowNames, ['Plan']);
    const markup = [...walk(ui.rows[0])].filter(w => w instanceof Gtk.Label && w.use_markup)
        .map(l => l.label).join(' | ');
    ok(markup.includes('<b>café</b>'), markup);
    await ui.searchFor('plan');
    eq(ui.rowNames, ['Plan', 'Ideas'], 'name matches first');
    await ui.searchFor('');
    eq(ui.rowNames.length, 3);
    await closeWindow(window);
});

test('window: label chips narrow the list, all or any (notes-label-match); Clear', async () => {
    const dir = tempFolder({a: 'one', b: 'two', c: 'three', d: 'four'});
    write(dir, '.froonty-labels.json', JSON.stringify({version: 1, labels: {
        a: ['work', 'q4'], b: ['work'], c: ['q4', 'home'], d: ['home'], gone: ['work'],
    }}));
    const {window, settings, ui} = await openWindow(dir, {last: 'a'});
    eq(ui.chips.length, 3, 'one chip per label');
    const count = label => [...walk(ui.chip(label))].filter(w => w instanceof Gtk.Label).map(l => l.label);
    eq(count('work'), ['work', '2'], 'counts only notes that exist');
    ok(!ui.mode.visible && !ui.clear.visible);

    ui.chip('work').active = true;
    await sleep(100);
    eq(ui.rowNames.sort(), ['a', 'b']);
    ok(!ui.mode.visible && ui.clear.visible, 'All/Any only from two chips on');
    ui.chip('q4').active = true;
    await sleep(100);
    ok(ui.mode.visible);
    eq(settings.get_string('notes-label-match'), 'all');
    eq(ui.rowNames, ['a'], 'all of them');
    ui.mode.active_name = 'any';
    await sleep(100);
    eq(settings.get_string('notes-label-match'), 'any', 'the toggle is the setting');
    eq(ui.rowNames.sort(), ['a', 'b', 'c'], 'any of them');
    settings.set_string('notes-label-match', 'all');
    await sleep(100);
    eq(ui.mode.active_name, 'all');
    eq(ui.rowNames, ['a']);

    ui.clear.emit('clicked');
    await sleep(100);
    eq(ui.rowNames.length, 4, 'Clear: every note again');
    ok(ui.chips.every(chip => !chip.active) && !ui.clear.visible && !ui.mode.visible);
    await closeWindow(window);
});

test('window: the Labels menu adds and removes a label of the open note, on disk', async () => {
    const dir = tempFolder({Plan: 'plan', Other: 'other'});
    write(dir, '.froonty-labels.json', JSON.stringify({version: 1, labels: {Other: ['home']}}));
    const {window, ui} = await openWindow(dir, {last: 'Plan'});
    ui.labelsButton.popup();
    await sleep(200);
    const popover = ui.labelsButton.popover;
    const entry = find(popover, w => w instanceof Gtk.Entry);
    entry.text = '#ideas';
    entry.emit('activate');
    const onDisk = () => JSON.parse(read(dir, '.froonty-labels.json')).labels;
    ok(await waitFor(() => onDisk().Plan?.includes('ideas')), JSON.stringify(onDisk()));
    eq(onDisk().Other, ['home'], 'the other note keeps its labels');
    await waitFor(() => ui.chips.length === 2);
    eq(ui.chips.length, 2, 'a chip for the new label');
    const check = () => find(popover, w => w instanceof Gtk.CheckButton && w.label === 'ideas');
    ok(await waitFor(() => check()?.active), 'ticked in the menu');
    find(popover, w => w instanceof Gtk.CheckButton && w.label === 'home').active = true;
    ok(await waitFor(() => onDisk().Plan?.includes('home')), JSON.stringify(onDisk()));
    check().active = false;
    ok(await waitFor(() => !onDisk().Plan?.includes('ideas')), JSON.stringify(onDisk()));
    eq(onDisk().Plan, ['home']);
    popover.popdown();
    await closeWindow(window);
});

// ---- the open note

test('window: Enter in a search that hides the open note opens the first result', async () => {
    const dir = tempFolder({Plan: 'ship the menu', Groceries: 'eggs? milk'});
    const {window, ui} = await openWindow(dir, {last: 'Plan'});
    eq(ui.open, 'Plan');
    ui.search.text = 'milk';
    ui.search.emit('activate'); // before the search delay ran out
    ok(await waitFor(() => ui.open === 'Groceries'), `open: ${ui.open}`);
    eq(ui.selectedRow, 'Groceries');
    ok(ui.editor.has_focus, 'the editor has the focus');
    ui.type('+');
    await sleep(AUTOSAVE);
    eq(read(dir, 'Groceries.md'), 'eggs? +milk', 'typed at the first match');
    eq(read(dir, 'Plan.md'), 'ship the menu', 'not into the hidden note');

    // The open note listed: Enter goes into it.
    await ui.searchFor('');
    ui.search.emit('activate');
    await sleep(200);
    eq(ui.open, 'Groceries');
    ok(ui.editor.has_focus);
    await closeWindow(window);
});

test('window: a note whose save failed stays open; another one is not opened over it', async () => {
    const dir = tempFolder({A: 'a', B: 'b'});
    const {window, ui} = await openWindow(dir, {last: 'A'});
    ui.editor.buffer.place_cursor(ui.editor.buffer.get_end_iter());
    ui.type(' typed');
    setMode(dir.get_child('A.md'), 0o444);
    setMode(dir, 0o555);
    try {
        const b = ui.rows.find(row => row._noteName === 'B');
        ui.list.select_row(b);
        await sleep(500);
        eq(ui.open, 'A', 'A stays open');
        eq(ui.text, 'a typed', 'with the text');
        eq(ui.selectedRow, 'A', 'and its row');
    } finally {
        setMode(dir, 0o755);
        setMode(dir.get_child('A.md'), 0o644);
    }
    ui.list.select_row(ui.rows.find(row => row._noteName === 'B'));
    ok(await waitFor(() => ui.open === 'B'), `open: ${ui.open}`);
    eq(read(dir, 'A.md'), 'a typed', 'saved on the way to B');
    await closeWindow(window);
});

test('window: another folder while the page is hidden: typing goes to the new folder', async () => {
    const old = tempFolder({Plan: 'plan', Other: 'x'});
    const fresh = tempFolder({Plan: 'plan, synced copy'});
    const {window, settings, ui} = await openWindow(old, {last: 'Plan'});
    eq(ui.open, 'Plan');
    await hidePage(settings, ui);
    settings.set_string('notes-folder', fresh.get_path());
    await showPage(settings, ui);
    ok(await waitFor(() => ui.open === 'Plan' && ui.rowNames.length === 1),
        `${ui.open} ${ui.rowNames}`);
    eq(ui.text, 'plan, synced copy', 'the new folder\'s note');
    ui.editor.buffer.place_cursor(ui.editor.buffer.get_end_iter());
    ui.type('!');
    await sleep(AUTOSAVE);
    eq(read(fresh, 'Plan.md'), 'plan, synced copy!');
    eq(read(old, 'Plan.md'), 'plan', 'the old folder is untouched');
    await closeWindow(window);
});

test('window: a failed save, then another folder: the text is kept there as a copy', async () => {
    const old = tempFolder({Plan: 'plan'});
    const fresh = tempFolder({Other: 'other'});
    const {window, settings, ui} = await openWindow(old, {last: 'Plan'});
    ui.editor.buffer.place_cursor(ui.editor.buffer.get_end_iter());
    ui.type(' typed');
    setMode(old.get_child('Plan.md'), 0o444);
    setMode(old, 0o555);
    try {
        await hidePage(settings, ui); // saving fails
        settings.set_string('notes-folder', fresh.get_path());
        await showPage(settings, ui);
        ok(await waitFor(() => ui.open === 'Plan (conflict)'), `open: ${ui.open}`);
    } finally {
        setMode(old, 0o755);
        setMode(old.get_child('Plan.md'), 0o644);
    }
    eq(read(fresh, 'Plan (conflict).md'), 'plan typed');
    eq(read(old, 'Plan.md'), 'plan');
    eq(ui.text, 'plan typed');
    await closeWindow(window);
});

test('window: it follows the island\'s note when shown again or raised', async () => {
    const dir = tempFolder({Plan: 'plan', Groceries: 'milk', Ideas: 'idea'});
    const {window, settings, ui} = await openWindow(dir, {last: 'Plan'});
    eq(ui.open, 'Plan');
    // Picked in the window: kept while the island stays on its note.
    ui.list.select_row(ui.rows.find(row => row._noteName === 'Ideas'));
    await waitFor(() => ui.open === 'Ideas');
    await hidePage(settings, ui);
    await showPage(settings, ui);
    eq(ui.open, 'Ideas', 'the island did not move: the window\'s choice stays');

    await hidePage(settings, ui);
    settings.set_string('notes-last', 'Groceries'); // the island moves on
    await showPage(settings, ui);
    ok(await waitFor(() => ui.open === 'Groceries'), `open: ${ui.open}`);
    eq(ui.selectedRow, 'Groceries');

    // Raised while on the page (the key does not change).
    const other = new Gtk.Window();
    other.present();
    await waitFor(() => !window.is_active);
    settings.set_string('notes-last', 'Plan');
    window.present();
    ok(await waitFor(() => ui.open === 'Plan'), `raised, open: ${ui.open}`);
    other.destroy();
    await closeWindow(window);
});

test('window: a conflict copy starts without labels of an old note of its name', async () => {
    const dir = tempFolder({Plan: 'base'});
    write(dir, '.froonty-labels.json', JSON.stringify({version: 1, labels: {
        'Plan (conflict)': ['old'], Plan: ['work'],
    }}));
    const {window, ui} = await openWindow(dir, {last: 'Plan'});
    ui.editor.buffer.place_cursor(ui.editor.buffer.get_end_iter());
    ui.type(' mine');
    await sleep(50);
    write(dir, 'Plan.md', 'theirs');
    ok(await waitFor(() => ui.open === 'Plan (conflict)', 4000), `open: ${ui.open}`);
    eq(read(dir, 'Plan (conflict).md'), 'base mine');
    eq(read(dir, 'Plan.md'), 'theirs');
    eq(JSON.parse(read(dir, '.froonty-labels.json')).labels, {Plan: ['work']});
    await sleep(SETTLE);
    eq(ui.chips.map(chip => chip.tooltip_text), ['1 note'], 'only "work", once');
    await closeWindow(window);
});

test('window: a note that is not UTF-8 is read-only; .froonty.json problems are shown', async () => {
    const dir = tempFolder({Plain: 'plain'});
    const latin1 = [0x63, 0x61, 0x66, 0xE9, 0x0A];
    dir.get_child('L.md').replace_contents(new Uint8Array(latin1), null, false, 0, null);
    write(dir, '.froonty.json', '{"version": 1, "order": [');
    const {window, ui} = await openWindow(dir, {last: 'L'});
    eq(ui.open, 'L');
    ok(!ui.editor.editable, 'not editable');
    ok(ui.banners.some(b => b.includes('read-only')), JSON.stringify(ui.banners));
    ok(ui.banners.some(b => b.includes('.froonty.json')), JSON.stringify(ui.banners));
    ui.type('x');
    await sleep(AUTOSAVE);
    eq([...dir.get_child('L.md').load_contents(null)[1]], latin1, 'byte for byte');
    ui.list.select_row(ui.rows.find(row => row._noteName === 'Plain'));
    await waitFor(() => ui.open === 'Plain');
    ok(ui.editor.editable, 'a plain note is editable again');
    eq(read(dir, '.froonty.json'), '{"version": 1, "order": [', 'never written by the window');
    await closeWindow(window);
});

// ---- the formatting bar

const BAR = ['Bold', 'Italic', 'Strikethrough', 'Heading', 'Bulleted list', 'Numbered list',
    'Checklist', 'Code', 'Link', 'Wrap lines'];

// Each action on "hi" selected in "say hi now", and on a bare cursor
// between "h" and "i": the text, the selection (the edit's, inside the
// markers), the toggle lit; a second click takes it off again. [text,
// selection] for the selection, then for the cursor.
const ACTIONS = {
    'Bold': [['say **hi** now', [6, 8]], ['say h****i now', [7, 7]]],
    'Italic': [['say _hi_ now', [5, 7]], ['say h__i now', [6, 6]]],
    'Strikethrough': [['say ~~hi~~ now', [6, 8]], ['say h~~~~i now', [7, 7]]],
    'Code': [['say `hi` now', [5, 7]], ['say h``i now', [6, 6]]],
    'Heading': [['# say hi now', [0, 12]], ['# say hi now', [0, 12]]],
    'Bulleted list': [['- say hi now', [0, 12]], ['- say hi now', [0, 12]]],
    'Numbered list': [['1. say hi now', [0, 13]], ['1. say hi now', [0, 13]]],
    'Checklist': [['- [ ] say hi now', [0, 16]], ['- [ ] say hi now', [0, 16]]],
};

test('window: the formatting bar has the island\'s buttons, in its order, with names', async () => {
    const dir = tempFolder({F: 'say hi now'});
    const {window, ui} = await openWindow(dir, {last: 'F'});
    eq(ui.formatButtons.map(b => b.tooltip_text), BAR);
    eq(ui.formatButtons.map(b => b instanceof Gtk.ToggleButton),
        [true, true, true, true, true, true, true, true, false, true], 'Link is no toggle');
    ok(ui.formatButtons.every(b => !b.focus_on_click), 'a click leaves the focus in the editor');
    eq(ui.format('Heading').label, 'H');
    eq(ui.format('Code').label, '</>');
    eq(ui.format('Bold').icon_name, 'format-text-bold-symbolic');
    ok(ui.formatButtons.every(b => b.sensitive));
    await closeWindow(window);
});

test('window: each toggle on a selection and on a bare cursor, saved, lit, and off again', async () => {
    const dir = tempFolder({F: 'say hi now'});
    const {window, ui} = await openWindow(dir, {last: 'F'});
    for (const [name, cases] of Object.entries(ACTIONS)) {
        for (const [i, [text, selection]] of cases.entries()) {
            const what = `${name} on ${i === 0 ? 'a selection' : 'a cursor'}`;
            if (i === 0)
                ui.select(4, 6);
            else
                ui.select(5);
            eq(ui.lit, [], `${what}: nothing lit before`);
            ui.click(name);
            eq(ui.text, text, what);
            eq(ui.selection, selection, `${what}: selection`);
            // "- [ ] " is a bulleted line too, as in the island.
            eq(ui.lit, name === 'Checklist' ? ['Bulleted list', name] : [name], `${what}: lit`);
            ok(ui.editor.has_focus, `${what}: the editor has the focus`);
            // eslint-disable-next-line no-await-in-loop
            await sleep(AUTOSAVE);
            eq(read(dir, 'F.md'), text, `${what}: saved`);
            ui.click(name);
            eq(ui.text, 'say hi now', `${what}: off again`);
            eq(ui.lit, [], `${what}: unlit`);
        }
    }
    await sleep(AUTOSAVE);
    eq(read(dir, 'F.md'), 'say hi now', 'saved off again');
    await closeWindow(window);
});

test('window: Link selects the URL; an edit is one undo step', async () => {
    const dir = tempFolder({F: 'say hi now'});
    const {window, ui} = await openWindow(dir, {last: 'F'});
    ui.select(4, 6);
    ui.click('Link');
    eq(ui.text, 'say [hi](https://) now');
    eq(ui.selection, [9, 17], 'the URL is selected');
    eq(ui.lit, [], 'Link is no toggle');
    ui.select(1);
    ui.click('Link');
    eq(ui.text, 's[link](https://)ay [hi](https://) now', 'a cursor: "link" as the label');
    eq(ui.selection, [8, 16]);
    await sleep(AUTOSAVE);
    eq(read(dir, 'F.md'), ui.text, 'saved');

    const buffer = ui.editor.buffer;
    buffer.undo();
    eq(ui.text, 'say [hi](https://) now', 'undo: the last edit, whole');
    buffer.undo();
    eq(ui.text, 'say hi now', 'undo: the first');
    ok(!buffer.can_undo, 'not into the loaded text');
    buffer.redo();
    eq(ui.text, 'say [hi](https://) now', 'redo');
    await sleep(AUTOSAVE);
    eq(read(dir, 'F.md'), 'say [hi](https://) now', 'undo and redo save too');
    await closeWindow(window);
});

test('window: the toggles follow the cursor and the selection', async () => {
    const dir = tempFolder({F: '# Title\nsay **hi** now\n- [ ] a\n- [ ] b'});
    const {window, ui} = await openWindow(dir, {last: 'F'});
    ui.select(3);
    eq(ui.lit, ['Heading'], 'in a heading');
    ui.select(15);
    eq(ui.lit, ['Bold'], 'inside **hi**');
    ui.select(20);
    eq(ui.lit, [], 'plain text');
    ui.select(23, 36);
    eq(ui.lit, ['Bulleted list', 'Checklist'], 'two checklist lines selected');
    ui.select(15, 36);
    eq(ui.lit, [], 'and the line before');
    // Typing moves no mark explicitly; the toggles follow it too.
    ui.select(15);
    eq(ui.lit, ['Bold']);
    ui.type('** ');
    eq(ui.text.split('\n')[1], 'say **h** i** now');
    eq(ui.lit, [], 'typed out of the span');
    await closeWindow(window);
});

test('window: Bold over several lines wraps each line; code points as offsets', async () => {
    const dir = tempFolder({F: 'one\n\n  two  \nthree', E: '😀 hi'});
    const {window, ui} = await openWindow(dir, {last: 'F'});
    ui.select(0, 18);
    ui.click('Bold');
    eq(ui.text, '**one**\n\n  **two**  \n**three**', 'each line on its own, blank ones left');
    eq(ui.selection, [2, 28]);
    eq(ui.lit, ['Bold']);
    ui.click('Bold');
    eq(ui.text, 'one\n\n  two  \nthree', 'all wrapped: unwrapped');
    await sleep(AUTOSAVE);
    eq(read(dir, 'F.md'), 'one\n\n  two  \nthree');

    ui.list.select_row(ui.rows.find(row => row._noteName === 'E'));
    await waitFor(() => ui.open === 'E');
    ui.select(2, 4);
    ui.click('Bold');
    eq(ui.text, '😀 **hi**', 'after an emoji');
    eq(ui.selection, [4, 6]);
    await sleep(AUTOSAVE);
    eq(read(dir, 'E.md'), '😀 **hi**');
    await closeWindow(window);
});

test('window: the bar is insensitive on a read-only note and with no note open', async () => {
    const dir = tempFolder({Plain: 'plain'});
    const latin1 = [0x63, 0x61, 0x66, 0xE9, 0x0A];
    dir.get_child('L.md').replace_contents(new Uint8Array(latin1), null, false, 0, null);
    const {window, ui} = await openWindow(dir, {last: 'L'});
    eq(ui.open, 'L');
    const edits = () => ui.formatButtons.filter(b => b.tooltip_text !== 'Wrap lines');
    ok(edits().every(b => !b.sensitive), 'formatting buttons insensitive');
    ok(ui.format('Wrap lines').sensitive, 'Wrap, a view option, still works');
    const before = ui.text;
    ui.select(0, 3);
    ui.click('Bold');
    eq(ui.text, before, 'a click (were it to come) changes nothing');
    eq(ui.lit, [], 'and lights nothing');
    await sleep(AUTOSAVE);
    eq([...dir.get_child('L.md').load_contents(null)[1]], latin1, 'byte for byte');

    ui.list.select_row(ui.rows.find(row => row._noteName === 'Plain'));
    await waitFor(() => ui.open === 'Plain');
    ok(edits().every(b => b.sensitive), 'a plain note: sensitive again');

    // The note goes: "Moved to the Trash", nothing to edit.
    dir.get_child('Plain.md').delete(null);
    ok(await waitFor(() => ui.open === null), `open: ${ui.open}`);
    ok(edits().every(b => !b.sensitive), 'no note open: insensitive');
    await closeWindow(window);
});

test('window: Wrap lines and the fold button are the island\'s settings', async () => {
    const dir = tempFolder({F: 'say hi now'});
    const {window, settings, ui} = await openWindow(dir, {last: 'F'});
    const wrap = ui.format('Wrap lines');
    ok(wrap.active && ui.editor.wrap_mode === Gtk.WrapMode.WORD_CHAR, 'wrapped by default');
    wrap.emit('clicked');
    ok(!settings.get_boolean('notes-wrap'), 'notes-wrap off');
    eq(ui.editor.wrap_mode, Gtk.WrapMode.NONE);
    settings.set_boolean('notes-wrap', true);
    ok(wrap.active && ui.editor.wrap_mode === Gtk.WrapMode.WORD_CHAR, 'follows the setting');

    const fold = ui.foldButton;
    eq(fold.tooltip_text, 'Hide formatting tools');
    ok(fold.child.gicon.get_file().get_basename() === 'froonty-fold-up-symbolic.svg' &&
        fold.child.gicon.get_file().query_exists(null), 'the bundled ⤴ icon');
    fold.emit('clicked');
    ok(!settings.get_boolean('notes-show-tools'), 'notes-show-tools off');
    ok(!ui.formatBar.get_parent().visible, 'the bar is folded away');
    eq(fold.tooltip_text, 'Show formatting tools');
    eq(fold.child.gicon.get_file().get_basename(), 'froonty-fold-down-symbolic.svg');
    // Folded: the toggles catch up when it comes back.
    const buffer = ui.editor.buffer;
    ui.select(4);
    buffer.insert_at_cursor('**', -1);
    ui.select(8);
    buffer.insert_at_cursor('**', -1);
    ui.select(7);
    eq(ui.text, 'say **hi** now');
    settings.set_boolean('notes-show-tools', true);
    ok(ui.formatBar.get_parent().visible, 'back with the setting');
    eq(ui.lit, ['Bold'], 'lit for the cursor inside **hi**');
    await closeWindow(window);
});

await done();
