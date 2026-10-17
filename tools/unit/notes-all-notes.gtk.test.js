// SPDX-License-Identifier: GPL-3.0-or-later
// Notes: the settings window's All notes page (GTK 4 + libadwaita), driven
// through its widgets against temporary notes folders: search, label chips,
// All/Any, Clear, the note pane's Labels menu and formatting bar, and what
// happens to the open note when the folder changes, a save fails, the
// search hides it or the island moves on; drawn blocks (their menus, their
// failures), pasted images and the direct edits of the rendered view
// (click to edit, Edit table, Edit Mermaid code). Plain gjs, no Shell. A note shows rendered,
// to read and copy; the tests that type or format turn MD (the Markdown
// source) on first, as a user would.
//
// tools/unit/run.sh gives it a display of its own: a private Broadway
// server (GTK's HTML5 backend; nothing shows on screen). The page imports
// gettext from the preferences service's resource, which only exists in
// that process; the test runs a copy of the extension's modules in which
// that one import names a stub instead, and the block renderer's helper is
// a stand-in (HELPER_STUB; nothing else differs).

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gsk from 'gi://Gsk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

import {test, eq, ok, done, EXTENSION_DIR, makeSettings as froontySettings, sleep, waitFor} from './test.js';

if (!GLib.getenv('FROONTY_UNIT_ISOLATED')) {
    printerr('Run this through tools/unit/run.sh (isolated TMPDIR/XDG_DATA_HOME, a private display).');
    imports.system.exit(2);
}

const PREFS_IMPORT = 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
// "%s".format(), as the preferences service sets it up (its main.js).
imports.package.initFormat();
// The formulas' renderer, in the copy below, draws with the working
// tree's MathJax (when fetched: `make mathjax`).
const MATHJAX_DIR = GLib.build_filenamev([EXTENSION_DIR, 'third_party', 'mathjax']);
GLib.setenv('FROONTY_MATHJAX_DIR', MATHJAX_DIR, true);
const MATHJAX = GLib.file_test(GLib.build_filenamev([MATHJAX_DIR, 'fetched.json']), GLib.FileTest.EXISTS);

Adw.init();
if (!Gdk.Display.get_default()) {
    printerr('No display: run this through tools/unit/run.sh (it starts a Broadway server).');
    imports.system.exit(1);
}
// Page transitions finish at once.
Gtk.Settings.get_default().gtk_enable_animations = false;

// Folder events (inotify, then GIO's rate limit for changes); autosave.
const SETTLE = 1500;
const AUTOSAVE = 1200;

// ---- the modules under test, with the gettext import pointing at a stub
// (and the notes' bundled icons, which the pane loads by path)

// The block renderer's helper (renderer/helper.js: GTK 3 and WebKit) cannot
// use the test's GTK 4 Broadway display. Its stand-in answers the same
// requests: an image decoded as the helper does (GdkPixbuf); a table as a
// white 120 × 40 box, a diagram 20 px high per line of its code; a table
// that names missing.png with the helper's warning for it; a pie diagram
// fails.
const HELPER_STUB = [
    "import Gio from 'gi://Gio';",
    "import GioUnix from 'gi://GioUnix';",
    "import GdkPixbuf from 'gi://GdkPixbuf';",
    "import GLib from 'gi://GLib';",
    'const input = new Gio.DataInputStream({base_stream: new GioUnix.InputStream({fd: 0, close_fd: false})});',
    'const output = new GioUnix.OutputStream({fd: 1, close_fd: false});',
    "const png = image => GLib.base64_encode(image.save_to_bufferv('png', [], [])[1]);",
    'function render(request) {',
    "    if (request.kind === 'image') {",
    '        const image = GdkPixbuf.Pixbuf.new_from_file(Gio.File.new_for_uri(request.uri).get_path());',
    '        return {png: png(image), width: image.get_width(), height: image.get_height(), warnings: []};',
    '    }',
    "    if (request.source.trim().startsWith('pie'))",
    "        throw new Error('pie diagrams cannot be drawn offline');",
    "    const height = request.kind === 'mermaid' ? 20 * request.source.trim().split('\\n').length : 40;",
    '    const box = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 120, height);',
    '    box.fill(0xffffffff);',
    "    const warnings = request.source.includes('missing.png') ? ['Image not found: missing.png'] : [];",
    '    return {png: png(box), width: 120, height: 40, warnings};',
    '}',
    'for (let line; (line = input.read_line(null)[0]) !== null;) {',
    '    const request = JSON.parse(new TextDecoder().decode(line));',
    '    let reply;',
    '    try {',
    '        reply = {id: request.id, ...render(request)};',
    '    } catch (e) {',
    '        reply = {id: request.id, error: e.message};',
    '    }',
    "    output.write_all(new TextEncoder().encode(`${JSON.stringify(reply)}\\n`), null);",
    '}',
].join('\n');

function copyModules() {
    const root = Gio.File.new_for_path(GLib.dir_make_tmp('froonty-ext-XXXXXX'));
    const stub = root.get_child('gettext-stub.js');
    stub.replace_contents([
        'export const gettext = s => s;',
        'export const ngettext = (one, many, n) => (n === 1 ? one : many);',
        'export const pgettext = (_context, s) => s;',
    ].join('\n'), null, false, 0, null);
    // The formulas in notes come with the working tree's Notes (local:begin
    // notes-math in its modules).
    for (const dir of ['core', 'features/notes', 'features/notes/icons', 'features/notes/renderer',
        'features/formulas/notes',
        'features/formulas/renderer']) {
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
    root.resolve_relative_path('features/notes/renderer/helper.js')
        .replace_contents(HELPER_STUB, null, false, 0, null);
    return root;
}

const {attachAllNotes} = await import(
    copyModules().resolve_relative_path('features/notes/allNotesPage.js').get_uri());

// ---- folders, settings, the window

function makeSettings(folder) {
    const settings = froontySettings();
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

// A formatting button's name: its tooltip, without the shortcut it names
// ("Bold (Ctrl+B)").
const nameOf = button => button.tooltip_text?.replace(/ \(Ctrl\+[^)]+\)$/, '');

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

    // The note as Markdown source (MD on), and as the rendered display copy
    // (allNotesStyler.js; the default): the two pages of its stack.
    _view(name) {
        const stack = find(this.page, w => w instanceof Gtk.Stack && w.get_child_by_name('rendered'));
        return find(stack.get_child_by_name(name), w => w instanceof Gtk.TextView);
    }

    get editor() {
        return this._view('source');
    }

    get rendered() {
        return this._view('rendered');
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

    // A button of the formatting bar, by its name (its tooltip, its
    // accessible name).
    format(name) {
        return find(this.formatBar, w => w instanceof Gtk.Button && nameOf(w) === name);
    }

    get formatButtons() {
        const buttons = [];
        for (let b = this.formatBar.get_first_child(); b; b = b.get_next_sibling())
            buttons.push(b);
        return buttons;
    }

    // MD: its tooltip names the other mode.
    get markdownButton() {
        return this.formatButtons.find(b => b.label === 'MD');
    }

    // The buttons that edit (MD and Wrap lines, view options, left out).
    get edits() {
        return this.formatButtons.filter(b => b !== this.markdownButton && nameOf(b) !== 'Wrap lines');
    }

    // The names of the lit formatting toggles.
    get lit() {
        return this.edits.filter(b => b instanceof Gtk.ToggleButton && b.active).map(nameOf);
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

// source: MD on, the Markdown source shown to edit (the rendered view is
// to read and copy).
async function openWindow(dir, {last = '', view = 'all-notes', source = false} = {}) {
    const settings = makeSettings(dir);
    settings.set_string('notes-last', last);
    settings.set_string('settings-window-view', view);
    settings.set_boolean('notes-markdown-source', source);
    // As prefs.js: a navigation view over the settings, the window's content.
    const window = new Adw.PreferencesWindow();
    window.add(new Adw.PreferencesPage({title: 'General'}));
    const navigationView = new Adw.NavigationView();
    navigationView.add(new Adw.NavigationPage({tag: 'settings', title: 'Settings',
        child: new Gtk.Label({label: 'Settings'})}));
    window.set_content(navigationView);
    attachAllNotes(window, settings, navigationView);
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

test('window: New note makes a note named after the time and opens it, also under a search', async () => {
    const dir = tempFolder({Plan: 'ship the menu'});
    const {window, settings, ui} = await openWindow(dir, {last: 'Plan', source: true});
    await ui.searchFor('ship');
    const button = find(ui.page, w => w instanceof Gtk.Button && w.tooltip_text === 'New note');
    ok(button, 'a New note button');
    button.emit('clicked');
    ok(await waitFor(() => ui.open !== 'Plan'), `open: ${ui.open}`);
    ok(/^\d{2}\.\d{2}\.\d{2} \d{2}\.\d{2}/.test(ui.open), `named after the time: ${ui.open}`);
    eq(read(dir, `${ui.open}.md`), '', 'an empty file');
    eq(ui.search.text, '', 'the search is cleared');
    ok(ui.rowNames.includes(ui.open) && ui.rowNames.includes('Plan'), `listed: ${ui.rowNames}`);
    eq(settings.get_string('notes-last'), ui.open, 'the island follows');
    await closeWindow(window);
});

test('window: a double-click on the title renames the note, with its labels, place and colour', async () => {
    const dir = tempFolder({Plan: 'ship', Other: 'x'});
    write(dir, '.froonty-labels.json', JSON.stringify({version: 1, labels: {Plan: ['work']}}));
    write(dir, '.froonty.json', JSON.stringify({version: 1, order: ['Plan', 'Other'], colors: {Plan: 'blue'}}));
    const {window, settings, ui} = await openWindow(dir, {last: 'Plan'});
    const title = find(ui.page, w => w instanceof Gtk.Label && w.tooltip_text === 'Double-click to rename');
    ok(title, 'the title');
    // What the double click does (GTK has no synthetic clicks here).
    const stack = title.get_parent();
    stack.visible_child_name = 'entry';
    const entry = stack.get_child_by_name('entry');
    entry.text = 'Q4 plan';
    entry.emit('activate');
    ok(await waitFor(() => ui.open === 'Q4 plan' && ui.rowNames.includes('Q4 plan')),
        `open: ${ui.open} rows: ${ui.rowNames}`);
    eq(stack.visible_child_name, 'title', 'the title again');
    eq(read(dir, 'Q4 plan.md'), 'ship', 'the file renamed');
    ok(!ui.rowNames.includes('Plan'), `rows: ${ui.rowNames}`);
    eq(JSON.parse(read(dir, '.froonty-labels.json')).labels, {'Q4 plan': ['work']}, 'its labels');
    const meta = JSON.parse(read(dir, '.froonty.json'));
    eq(meta.order.slice(0, 3), ['Plan', 'Q4 plan', 'Other'], 'its place, beside the old name');
    eq(meta.colors['Q4 plan'], 'blue', 'its colour');
    eq(settings.get_string('notes-last'), 'Q4 plan', 'the island follows');

    // A name taken by another note: nothing changes, and says so.
    stack.visible_child_name = 'entry';
    entry.text = 'Other';
    entry.emit('activate');
    await sleep(500);
    eq(ui.open, 'Q4 plan');
    eq(read(dir, 'Other.md'), 'x', 'the other note untouched');
    eq(settings.get_string('notes-last'), 'Q4 plan', 'the selection back');
    await closeWindow(window);
});

test('window: undo and redo (Ctrl+Z, Ctrl+Y) reach a task ticked in the rendered view', async () => {
    const dir = tempFolder({T: '- [ ] milk'});
    const {window, ui} = await openWindow(dir, {last: 'T'});
    const checkOf = () => find(ui.page, w => w instanceof Gtk.CheckButton &&
        w.has_css_class('froonty-task-check') && w.visible);
    ok(await waitFor(() => checkOf()), 'a task check in the rendered view');
    const check = checkOf();
    check.active = true;
    eq(ui.text, '- [x] milk', 'ticked');
    check.activate_action('note.undo', null);
    eq(ui.text, '- [ ] milk', 'undo');
    check.activate_action('note.redo', null);
    eq(ui.text, '- [x] milk', 'redo');
    await sleep(AUTOSAVE);
    eq(read(dir, 'T.md'), '- [x] milk', 'saved');
    await closeWindow(window);
});

test('window: Enter in a search that hides the open note opens the first result', async () => {
    const dir = tempFolder({Plan: 'ship the menu', Groceries: 'eggs? milk'});
    const {window, settings, ui} = await openWindow(dir, {last: 'Plan', source: true});
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

    // Rendered (MD off): into the rendered view, to read; the hidden
    // source never takes the focus.
    settings.set_boolean('notes-markdown-source', false);
    ui.search.grab_focus();
    await ui.searchFor('ship');
    ui.search.emit('activate');
    ok(await waitFor(() => ui.open === 'Plan'), `open: ${ui.open}`);
    ok(await waitFor(() => ui.rendered.has_focus), 'the rendered view has the focus');
    ok(!ui.editor.has_focus, 'not the source');
    await closeWindow(window);
});

test('window: a note whose save failed stays open; another one is not opened over it', async () => {
    const dir = tempFolder({A: 'a', B: 'b'});
    const {window, ui} = await openWindow(dir, {last: 'A', source: true});
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
    const {window, settings, ui} = await openWindow(old, {last: 'Plan', source: true});
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
    const {window, settings, ui} = await openWindow(old, {last: 'Plan', source: true});
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

// The island picks a note: it writes the folder's marker (store.js
// writeCurrentNote) and notes-last, as service.js does.
function islandSelects(settings, dir, name) {
    write(dir, '.froonty-current-note', name);
    settings.set_string('notes-last', name);
}

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
    islandSelects(settings, dir, 'Groceries'); // the island moves on
    await showPage(settings, ui);
    ok(await waitFor(() => ui.open === 'Groceries'), `open: ${ui.open}`);
    eq(ui.selectedRow, 'Groceries');

    // Raised while on the page (the key does not change).
    const other = new Gtk.Window();
    other.present();
    await waitFor(() => !window.is_active);
    islandSelects(settings, dir, 'Plan');
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
    const {window, ui} = await openWindow(dir, {last: 'Plan', source: true});
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
    const {window, ui} = await openWindow(dir, {last: 'L', source: true});
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
    'Checklist', 'Code', 'Link', 'Insert image', 'Show Markdown source', 'Wrap lines'];

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
    const {window, settings, ui} = await openWindow(dir, {last: 'F'});
    eq(ui.formatButtons.map(nameOf), BAR);
    eq(ui.formatButtons.map(b => b.tooltip_text), ['Bold (Ctrl+B)', 'Italic (Ctrl+I)',
        'Strikethrough (Ctrl+Shift+X)', 'Heading (Ctrl+Shift+H)', 'Bulleted list (Ctrl+Shift+8)',
        'Numbered list (Ctrl+Shift+7)', 'Checklist (Ctrl+Shift+9)', 'Code (Ctrl+E)', 'Link (Ctrl+K)',
        'Insert image', 'Show Markdown source (Ctrl+Shift+M)', 'Wrap lines'], 'tooltips name the shortcuts');
    eq(ui.formatButtons.map(b => b instanceof Gtk.ToggleButton),
        [true, true, true, true, true, true, true, true, false, false, true, true],
        'Link and Insert image are no toggles');
    ok(ui.formatButtons.every(b => !b.focus_on_click), 'a click leaves the focus in the editor');
    eq(ui.format('Heading').label, 'H');
    eq(ui.format('Code').label, '</>');
    eq(ui.format('Bold').icon_name, 'format-text-bold-symbolic');
    // Rendered (the default) is to read and copy: only MD and Wrap work.
    ok(ui.edits.every(b => !b.sensitive), 'rendered: the buttons that edit are insensitive');
    ok(ui.markdownButton.sensitive && ui.format('Wrap lines').sensitive);
    ok(!ui.markdownButton.active && ui.rendered.get_mapped() && !ui.editor.get_mapped());
    ui.markdownButton.emit('clicked');
    ok(settings.get_boolean('notes-markdown-source'), 'MD is notes-markdown-source');
    ok(ui.editor.get_mapped() && !ui.rendered.get_mapped(), 'the source shown');
    eq(ui.markdownButton.tooltip_text, 'Show rendered Markdown (Ctrl+Shift+M)');
    ok(ui.formatButtons.every(b => b.sensitive), 'source: every button works');
    settings.set_boolean('notes-markdown-source', false);
    ok(ui.edits.every(b => !b.sensitive) && ui.rendered.get_mapped(), 'follows the setting');
    await closeWindow(window);
});

test('window: each toggle on a selection and on a bare cursor, saved, lit, and off again', async () => {
    const dir = tempFolder({F: 'say hi now'});
    const {window, ui} = await openWindow(dir, {last: 'F', source: true});
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
    const {window, ui} = await openWindow(dir, {last: 'F', source: true});
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
    const {window, ui} = await openWindow(dir, {last: 'F', source: true});
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
    const {window, ui} = await openWindow(dir, {last: 'F', source: true});
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
    const {window, ui} = await openWindow(dir, {last: 'L', source: true});
    eq(ui.open, 'L');
    const edits = () => ui.edits;
    ok(edits().every(b => !b.sensitive), 'formatting buttons insensitive');
    ok(ui.format('Wrap lines').sensitive && ui.markdownButton.sensitive, 'Wrap and MD, view options, still work');
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
    const {window, settings, ui} = await openWindow(dir, {last: 'F', source: true});
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

// ---- the note drawn rendered (allNotesStyler.js)

// The rendered styles at a character offset of the display copy ('h1',
// 'bold', 'hidden'…).
function stylesAt(ui, offset) {
    return ui.rendered.buffer.get_iter_at_offset(offset).get_tags()
        .map(tag => tag.name).filter(name => name?.startsWith('froonty-markdown-'))
        .map(name => name.slice('froonty-markdown-'.length)).sort();
}

const taskChecks = ui => [...walk(ui.rendered.get_parent())]
    .filter(w => w instanceof Gtk.CheckButton && w.has_css_class('froonty-task-check') && w.visible);

test('window: rendered, the note reads formatted; its source stays plain Markdown', async () => {
    const note = '# Title\nsay **hi** and `x`\n- [x] done\n> quote';
    const dir = tempFolder({F: note, E: '😀 **hi**'});
    const {window, settings, ui} = await openWindow(dir, {last: 'F'});
    const buffer = ui.editor.buffer;
    // Offsets: "# Title\n" 0-7, "say **hi** and `x`\n" 8-26, "- [x] done\n"
    // 27-37, "> quote" 38-44.
    eq(ui.rendered.buffer.text, note, 'without blocks, the display copy is the text');
    ok(!ui.rendered.editable, 'to read and copy');
    eq(stylesAt(ui, 2), ['h1'], 'a heading');
    eq(stylesAt(ui, 14), ['bold']);
    eq(stylesAt(ui, 24), ['code']);
    eq(stylesAt(ui, 34), ['done'], 'a checked item');
    eq(stylesAt(ui, 41), ['quote']);
    for (const at of [0, 12, 13, 16, 17, 23, 25, 27])
        ok(stylesAt(ui, at).includes('hidden'), `the marker at ${at} is hidden`);
    // The checkbox's place, a check drawn over it; a quote's ">" stays, dimmed.
    eq(stylesAt(ui, 30), ['taskbox'], 'the checkbox');
    ok(await waitFor(() => taskChecks(ui).length === 1 && taskChecks(ui)[0].active), 'a ticked check');
    eq(stylesAt(ui, 38), ['marker'], 'the quote mark');
    ok(!ui.editor.has_focus, 'the hidden source has no focus');
    ok(buffer.get_iter_at_offset(14).get_tags().every(tag => !tag.name?.startsWith('froonty-markdown-')),
        'the source is not styled');

    // Typed in the source (MD): the text, the undo history and the file
    // stay plain; the rendered view shows the new span.
    settings.set_boolean('notes-markdown-source', true);
    ui.select(buffer.get_char_count());
    ui.type(' *it*');
    eq(ui.text, `${note} *it*`);
    await sleep(AUTOSAVE);
    eq(read(dir, 'F.md'), `${note} *it*`, 'saved with every marker');
    settings.set_boolean('notes-markdown-source', false);
    eq(stylesAt(ui, 47), ['italic', 'quote'], 'a new span');
    settings.set_boolean('notes-markdown-source', true);
    buffer.undo();
    eq(ui.text, note, 'one undo step: the typing, not the styling');
    ok(!buffer.can_undo);
    settings.set_boolean('notes-markdown-source', false);
    ok(stylesAt(ui, 47).length === 0 && ui.rendered.buffer.text === note, 'the undo shows too');

    // A search match shows over the styles.
    await ui.searchFor('hi');
    const at = ui.rendered.buffer.get_iter_at_offset(14);
    const match = at.get_tags().find(tag => tag.name === 'froonty-match');
    ok(match, 'the match is marked');
    ok(at.get_tags().every(tag => tag === match || tag.get_priority() < match.get_priority()), 'over the bold');
    await ui.searchFor('');

    ui.list.select_row(ui.rows.find(row => row._noteName === 'E'));
    await waitFor(() => ui.open === 'E');
    eq(stylesAt(ui, 5), ['bold'], 'after an emoji: code points as offsets');
    ok(stylesAt(ui, 3).includes('hidden'));
    await sleep(AUTOSAVE);
    eq(read(dir, 'E.md'), '😀 **hi**', 'untouched');
    await closeWindow(window);
});

// ---- formulas in notes (working-tree builds)

// Formulas are drawn in the rendered view only.
const pictures = (ui, view = ui.rendered) =>
    [...walk(view)].filter(w => w instanceof Gtk.Picture && w.visible && w.paintable);
const mathTags = (ui, offset, view = ui.rendered) => view.buffer.get_iter_at_offset(offset).get_tags()
    .map(tag => tag.name).filter(name => name?.startsWith('froonty-math-')).sort();
// An iterator's box, in the rendered view's own coordinates.
function boxAt(ui, offset) {
    const view = ui.rendered;
    const box = view.get_iter_location(view.buffer.get_iter_at_offset(offset));
    const [x, y] = view.buffer_to_window_coords(Gtk.TextWindowType.WIDGET, box.x, box.y);
    return {x, y, width: box.width, height: box.height};
}
function boundsOf(widget, view) {
    const [, bounds] = widget.compute_bounds(view);
    return {x: bounds.get_x(), y: bounds.get_y(), width: bounds.get_width(), height: bounds.get_height()};
}

test('window: formulas are drawn rendered, the LaTeX in the source; text, file and undo stay', async () => {
    if (!MATHJAX) {
        print('     (skipped: MathJax is not fetched; run `make mathjax`)');
        return;
    }
    // "Energy $E=mc^2$ here\n" 0-20, "and $5 and $10\n" 21-35, "$$\n" 36-38,
    // "\int_0^1 x\,dx\n" 39-53, "$$\n" 54-56, "end" 57-59.
    const note = 'Energy $E=mc^2$ here\nand $5 and $10\n$$\n\\int_0^1 x\\,dx\n$$\nend';
    const dir = tempFolder({F: note});
    const {window, settings, ui} = await openWindow(dir, {last: 'F'});
    const view = ui.rendered;
    const buffer = view.buffer;
    // Broadway, with no browser watching, lays out about once a second.
    ok(await waitFor(() => pictures(ui).length === 2 && pictures(ui).every(p => p.get_width() > 0), 15000),
        `two pictures (${pictures(ui).length})`);
    await waitFor(() => Math.abs(boundsOf(pictures(ui)[0], view).x - boxAt(ui, 7).x) <= 1, 3000);
    eq(mathTags(ui, 8), ['froonty-math-hidden'], 'the source is hidden');
    // A picture's paintable draws its texture at its size on screen.
    const snapshot = new Gtk.Snapshot();
    const paintable = pictures(ui)[0].paintable;
    paintable.snapshot(snapshot, paintable.get_intrinsic_width(), paintable.get_intrinsic_height());
    const node = snapshot.to_node();
    ok(node && [Gsk.RenderNodeType.TEXTURE_NODE, Gsk.RenderNodeType.TEXTURE_SCALE_NODE]
        .includes(node.get_node_type()), `drawn as ${node?.get_node_type()}`);
    eq(mathTags(ui, 24), [], 'money stays text');

    // The inline picture on its room: where "$" starts, as wide as the
    // room up to " here", on the line.
    const [inline, block] = pictures(ui).sort((a, b) => boundsOf(a, view).y - boundsOf(b, view).y);
    const p = boundsOf(inline, view);
    const start = boxAt(ui, 7);
    const after = boxAt(ui, 15);
    ok(Math.abs(p.x - start.x) <= 1 && Math.abs(p.y - start.y) <= 2, `picture at ${p.x},${p.y}, room at ${start.x},${start.y}`);
    ok(after.x - start.x >= p.width && after.x - start.x <= p.width + 3,
        `room ${after.x - start.x} px for a picture ${p.width} px wide`);
    const [lineTop, lineHeight] = view.get_line_yrange(buffer.get_iter_at_offset(0));
    ok(lineHeight >= p.height && p.y - view.top_margin >= lineTop - 1, `line ${lineHeight} px for ${p.height}`);
    // The display one: centred, its first line as tall as it.
    const middle = view.left_margin + (view.get_width() - view.left_margin - view.right_margin) / 2;
    const centred = () => Math.abs(boundsOf(block, view).x + boundsOf(block, view).width / 2 - middle) <= 2;
    ok(await waitFor(centred, 3000), `centred: ${boundsOf(block, view).x + boundsOf(block, view).width / 2} vs ${middle}`);
    const b = boundsOf(block, view);
    const [, blockLine] = view.get_line_yrange(buffer.get_iter_at_offset(36));
    ok(blockLine >= b.height, `the $$ line ${blockLine} px for ${b.height}`);

    // The source (MD) shows the LaTeX: no picture, nothing hidden.
    settings.set_boolean('notes-markdown-source', true);
    const source = ui.editor.buffer;
    eq(pictures(ui, ui.editor).length, 0, 'the source: no picture');
    eq(mathTags(ui, 8, ui.editor), [], 'the source: its LaTeX shown');

    // The text, the saved file and undo are the plain note.
    eq(ui.text, note);
    ui.select(20);
    ui.type(' too');
    ui.select(source.get_char_count());
    ui.type('!');
    await sleep(AUTOSAVE);
    const typed = note.replace('here', 'here too') + '!';
    eq(read(dir, 'F.md'), typed, 'saved, byte for byte');
    source.undo();
    source.undo();
    eq(ui.text, note, 'undo: the typing only');
    ok(!source.can_undo, 'nothing else in the history');

    // The formatting bar edits by the plain text's offsets.
    ui.select(16, 20);
    ui.click('Bold');
    eq(ui.text, note.replace('here', '**here**'), 'Bold around the word after a formula');
    eq(ui.selection, [18, 22], 'the word still selected');
    await sleep(AUTOSAVE);
    eq(read(dir, 'F.md'), note.replace('here', '**here**'));

    // Rendered again: the edited note, its formulas drawn.
    settings.set_boolean('notes-markdown-source', false);
    ok(await waitFor(() => pictures(ui).length === 2 && mathTags(ui, 8).includes('froonty-math-hidden'), 15000),
        'drawn again');
    eq(stylesAt(ui, 18), ['bold'], 'the new bold');
    await closeWindow(window);
});

test('window: a formula MathJax refuses shows its source, underlined, with the message', async () => {
    if (!MATHJAX) {
        print('     (skipped: MathJax is not fetched; run `make mathjax`)');
        return;
    }
    const note = 'bad $\\frac{1}{$ x\nother';
    const dir = tempFolder({F: note});
    const {window, ui} = await openWindow(dir, {last: 'F'});
    ok(await waitFor(() => mathTags(ui, 6).includes('froonty-math-refused'), 15000), 'underlined');
    eq(pictures(ui).length, 0, 'no picture');
    eq(stylesAt(ui, 6), [], 'not dimmed: plain source');
    ok(ui.rendered.has_tooltip, 'tooltips on');
    await closeWindow(window);
});

// ---- drawn blocks, pasted images and direct edits (allNotesStyler.js)

Gio._promisify(Gdk.Clipboard.prototype, 'read_async');
Gio._promisify(Gio.OutputStream.prototype, 'splice_async');

// A PNG of a blue `width` × `height` box: its bytes, written as `name` in
// `dir` when given.
function png(width, height, dir = null, name = null) {
    const image = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, width, height);
    image.fill(0x3366ccff);
    const [, bytes] = image.save_to_bufferv('png', [], []);
    dir?.get_child(name).replace_contents(bytes, null, false, 0, null);
    return bytes;
}

const controllers = widget => {
    const list = widget.observe_controllers();
    return Array.from({length: list.get_n_items()}, (_, i) => list.get_item(i));
};

// Shown: it and every widget above it visible.
const shown = widget => {
    for (let w = widget; w; w = w.get_parent()) {
        if (!w.visible)
            return false;
    }
    return true;
};

// The layer of the rendered view: the text, and over it the blocks'
// pictures and captions.
const layer = ui => ui.rendered.get_parent();
const blockPictures = ui => [...walk(layer(ui))]
    .filter(w => w instanceof Gtk.Picture && shown(w) && w.paintable);
const labelOf = (ui, text) => find(layer(ui), w => w instanceof Gtk.Label && shown(w) && w.label === text);

// A picture's right-click menu: its items' buttons.
async function menuOf(picture) {
    controllers(picture).find(c => c instanceof Gtk.GestureClick && c.get_button() === Gdk.BUTTON_SECONDARY)
        .emit('pressed', 1, 4, 4);
    await sleep(100);
    const popover = find(picture, w => w instanceof Gtk.Popover);
    return [...walk(popover)].filter(w => w instanceof Gtk.Button && w.label);
}

async function readClipboard(clipboard, mime) {
    const [stream] = await clipboard.read_async([mime], GLib.PRIORITY_DEFAULT, null);
    const output = Gio.MemoryOutputStream.new_resizable();
    await output.splice_async(stream, Gio.OutputStreamSpliceFlags.CLOSE_SOURCE |
        Gio.OutputStreamSpliceFlags.CLOSE_TARGET, GLib.PRIORITY_DEFAULT, null);
    return [...output.steal_as_bytes().toArray()];
}

test('window: a block that fails says why over its Markdown; the others are drawn, warnings dim', async () => {
    const remote = '![remote](https://example.com/x.png)';
    const note = `Good:\n\n![dot](dot.png)\n\nBad:\n\n${remote}\n\n` +
        '| a | b |\n| --- | --- |\n| ![m](missing.png) | 2 |\n\nend';
    const dir = tempFolder({F: note});
    png(8, 6, dir, 'dot.png');
    const {window, ui} = await openWindow(dir, {last: 'F'});
    ok(await waitFor(() => blockPictures(ui).length === 2, 15000), `drawn: ${blockPictures(ui).length}`);
    ok(blockPictures(ui).some(p => p.paintable.get_intrinsic_width() === 8), 'the image, at its own size');
    const reason = labelOf(ui, 'Could not render image: Use an image file path relative to this note');
    ok(reason, 'the reason');
    const source = labelOf(ui, remote);
    ok(source?.selectable && source.has_css_class('monospace'), 'its Markdown under it, selectable');
    const top = widget => widget.translate_coordinates(layer(ui), 0, 0)[2];
    ok(await waitFor(() => top(source) > top(reason), 3000), 'under the reason');
    // Placed once the view is laid out.
    const warningOf = () => labelOf(ui, 'Not drawn: Image not found: missing.png');
    ok(await waitFor(() => warningOf()), 'the table\'s warning');
    const warning = warningOf();
    ok(warning.has_css_class('dim-label'), 'the table\'s warning, a dim line');
    eq(warning.tooltip_text, 'Image not found: missing.png', 'every warning in its tooltip');
    // Room for the Markdown: the next block starts under it.
    const tableOf = () => blockPictures(ui).find(p => p.paintable.get_intrinsic_width() === 120);
    ok(await waitFor(() => tableOf()), 'the table');
    const table = tableOf();
    ok(await waitFor(() => source.get_height() > 0 && top(table) >= top(source) + source.get_height(), 3000),
        `the table at ${top(table)}, the Markdown down to ${top(source) + source.get_height()}`);
    await closeWindow(window);
});

test('window: right-click on an image file: Copy original and Open file location; on a table, Copy as Markdown and Edit table', async () => {
    const dir = tempFolder({F: '![dot](dot.png)\n\n| a | b |\n| --- | --- |\n| 1 | 2 |'});
    const bytes = png(8, 6, dir, 'dot.png');
    const {window, ui} = await openWindow(dir, {last: 'F'});
    ok(await waitFor(() => blockPictures(ui).length === 2, 15000), `drawn: ${blockPictures(ui).length}`);
    const image = blockPictures(ui).find(p => p.paintable.get_intrinsic_width() === 8);
    const table = blockPictures(ui).find(p => p !== image);
    eq((await menuOf(image)).map(b => b.label), ['Copy as PNG', 'Open file location', 'Copy original']);
    eq((await menuOf(table)).map(b => b.label), ['Copy as JPEG', 'Copy as Markdown', 'Edit table'],
        'no file: no file items');
    (await menuOf(table)).find(b => b.label === 'Copy as Markdown').emit('clicked');
    const markdown = await new Promise(resolve => ui.rendered.get_clipboard()
        .read_text_async(null, (clip, result) => resolve(clip.read_text_finish(result))));
    eq(markdown, '| a | b |\n| --- | --- |\n| 1 | 2 |', 'the table\'s Markdown, as written');

    // The original: the file's bytes as its type, and the file, for Files.
    (await menuOf(image)).find(b => b.label === 'Copy original').emit('clicked');
    const clipboard = ui.rendered.get_clipboard();
    ok(await waitFor(() => clipboard.get_formats().contain_mime_type('text/uri-list')), 'copied');
    ok(clipboard.get_formats().contain_mime_type('x-special/gnome-copied-files'), 'as a file for Files');
    eq(await readClipboard(clipboard, 'image/png'), [...bytes], 'the file\'s own bytes');
    const uri = dir.get_child('dot.png').get_uri();
    eq(new TextDecoder().decode(new Uint8Array(await readClipboard(clipboard, 'text/uri-list'))), `${uri}\r\n`);
    await closeWindow(window);
});

test('window: an image pasted into the source is saved beside the note and referenced; text stays text', async () => {
    const dir = tempFolder({P: 'see '});
    const {window, ui} = await openWindow(dir, {last: 'P', source: true});
    const bytes = png(5, 4);
    ui.select(4);
    const clipboard = ui.editor.get_clipboard();
    clipboard.set_content(Gdk.ContentProvider.new_for_bytes('image/png', new GLib.Bytes(bytes)));
    ui.editor.emit('paste-clipboard');
    ok(await waitFor(() => /^see !\[\]\(pasted-\d{4}-\d\d-\d\d-\d{4}\.png\)$/.test(ui.text)), ui.text);
    const name = /\((.*)\)/.exec(ui.text)[1];
    eq([...dir.get_child(name).load_contents(null)[1]], [...bytes], 'the image, as copied');
    await sleep(AUTOSAVE);
    eq(read(dir, 'P.md'), ui.text, 'saved');
    clipboard.set(' and words');
    ui.editor.emit('paste-clipboard');
    ok(await waitFor(() => ui.text.endsWith(') and words')), ui.text);
    await closeWindow(window);
});

// The open field of the rendered view, if any.
const fieldOf = ui => find(ui.rendered, w => w instanceof Gtk.TextView && w !== ui.rendered);
// A key pressed in it (its frame takes them first).
const press = (field, keyval, state = 0) => controllers(field.get_parent())
    .find(c => c instanceof Gtk.EventControllerKey).emit('key-pressed', keyval, 0, state);
// A click at a character of the rendered view, as its click controller
// takes it once no double click follows.
const clickAt = (ui, offset) => ui.rendered.activate_action('rendered.edit-at', new GLib.Variant('i', offset));

test('window: a click edits a paragraph in place: Ctrl+Enter writes it back as one undo step, Escape drops it', async () => {
    // "# Title\n" 0-7, "first line\n" 8-18, "second line\n" 19-30, "\n" 31,
    // "- [ ] milk" 32-41.
    const note = '# Title\nfirst line\nsecond line\n\n- [ ] milk';
    const dir = tempFolder({F: note});
    const {window, ui} = await openWindow(dir, {last: 'F'});
    clickAt(ui, 22);
    const field = fieldOf(ui);
    ok(field, 'a field');
    eq(field.buffer.text, 'first line\nsecond line', 'the paragraph\'s Markdown');
    eq(field.buffer.cursor_position, 14, 'the caret where the click was');
    ok(await waitFor(() => field.has_focus), 'with the focus');
    field.buffer.text = 'first line\nsecond **line**';
    press(field, Gdk.KEY_Return);
    ok(fieldOf(ui) === field && ui.text === note, 'Enter: a new line (the view\'s own), the field stays open');
    press(field, Gdk.KEY_Return, Gdk.ModifierType.CONTROL_MASK);
    const edited = '# Title\nfirst line\nsecond **line**\n\n- [ ] milk';
    eq(ui.text, edited, 'Ctrl+Enter writes it back');
    ok(!fieldOf(ui), 'and closes the field');
    eq(stylesAt(ui, 28), ['bold'], 'drawn again');
    await sleep(AUTOSAVE);
    eq(read(dir, 'F.md'), edited, 'saved');
    ui.rendered.activate_action('note.undo', null);
    eq(ui.text, note, 'one undo step');
    ui.rendered.activate_action('note.redo', null);
    eq(ui.text, edited, 'redo');

    // A heading, whole; Escape drops the change.
    clickAt(ui, 3);
    eq(fieldOf(ui).buffer.text, '# Title');
    fieldOf(ui).buffer.text = '# Changed';
    press(fieldOf(ui), Gdk.KEY_Escape);
    eq(ui.text, edited, 'Escape: unchanged');
    ok(!fieldOf(ui));

    // A task's text, its check still a check; Shift+Enter leaves the field
    // open (a new line); clicking away writes it back.
    clickAt(ui, edited.indexOf('milk') + 1);
    const task = fieldOf(ui);
    eq(task.buffer.text, 'milk', 'a task: its text');
    ok(taskChecks(ui).length === 1, 'its check stays');
    task.buffer.place_cursor(task.buffer.get_end_iter());
    press(task, Gdk.KEY_Return, Gdk.ModifierType.SHIFT_MASK);
    ok(fieldOf(ui) === task, 'Shift+Enter: the field stays open');
    task.buffer.text = 'oat milk';
    ok(await waitFor(() => task.has_focus));
    ui.rendered.grab_focus();
    ok(await waitFor(() => ui.text.endsWith('- [ ] oat milk')), ui.text);
    ok(!fieldOf(ui), 'closed');
    await closeWindow(window);
});

// ---- keyboard shortcuts (formatActions.js): the bar's edits as note.bold,
// …, and MD as note.markdown; the note's key controller activates them

const CTRL = Gdk.ModifierType.CONTROL_MASK;
const SHIFT = Gdk.ModifierType.SHIFT_MASK;
// XKB keycodes (evdev): B, K, M, and 8 on the digit row.
const KEY = {b: 56, k: 45, m: 58, 8: 17};
// A key pressed in the note (its views and fields): true if taken.
const shortcut = (ui, keyval, keycode, state) => controllers(
    find(ui.page, w => w instanceof Gtk.Stack && w.get_child_by_name('rendered')))
    .find(c => c instanceof Gtk.EventControllerKey).emit('key-pressed', keyval, keycode, state);

test('window: shortcuts in the source: Ctrl+B on and off, Ctrl+Shift+8 a bullet, Ctrl+K a link, one undo step', async () => {
    const dir = tempFolder({F: 'say hi now'});
    const {window, ui} = await openWindow(dir, {last: 'F', source: true});
    ui.select(4, 6);
    ui.editor.activate_action('note.bold', null);
    eq(ui.text, 'say **hi** now', 'note.bold wraps the selection');
    eq(ui.selection, [6, 8], 'inside the markers');
    eq(ui.lit, ['Bold'], 'and lights Bold');
    ok(ui.editor.has_focus, 'the editor keeps the focus');
    ok(shortcut(ui, Gdk.KEY_b, KEY.b, CTRL), 'Ctrl+B is taken');
    eq(ui.text, 'say hi now', 'Ctrl+B again: off');
    // US: Shift+8 types "*"; the key is the 8.
    ok(shortcut(ui, Gdk.KEY_asterisk, KEY[8], CTRL | SHIFT), 'Ctrl+Shift+8 is taken');
    eq(ui.text, '- say hi now', 'a bullet');
    shortcut(ui, Gdk.KEY_asterisk, KEY[8], CTRL | SHIFT);
    eq(ui.text, 'say hi now', 'and off');
    ui.select(4, 6);
    shortcut(ui, Gdk.KEY_k, KEY.k, CTRL);
    eq(ui.text, 'say [hi](https://) now', 'Ctrl+K: a link');
    eq(ui.selection, [9, 17], 'its URL selected');
    await sleep(AUTOSAVE);
    eq(read(dir, 'F.md'), 'say [hi](https://) now', 'saved like a click');
    ui.editor.buffer.undo();
    eq(ui.text, 'say hi now', 'one undo step');

    ok(!shortcut(ui, Gdk.KEY_b, KEY.b, CTRL | Gdk.ModifierType.ALT_MASK), 'Ctrl+Alt+B is no shortcut');
    ok(!shortcut(ui, Gdk.KEY_B, KEY.b, CTRL | SHIFT), 'nor Ctrl+Shift+B');
    ok(!shortcut(ui, Gdk.KEY_a, 38, CTRL), 'Ctrl+A goes on to the editor');
    eq(ui.text, 'say hi now');
    // Every other action, as its button.
    for (const [id, text] of [['italic', 'say _hi_ now'], ['strikethrough', 'say ~~hi~~ now'],
        ['heading', '# say hi now'], ['numbered', '1. say hi now'], ['checklist', '- [ ] say hi now'],
        ['code', 'say `hi` now']]) {
        ui.select(4, 6);
        ui.editor.activate_action(`note.${id}`, null);
        eq(ui.text, text, id);
        ui.editor.activate_action(`note.${id}`, null);
        eq(ui.text, 'say hi now', `${id} off`);
    }
    await closeWindow(window);
});

test('window: shortcuts in a click-to-edit field format its Markdown; rendered without one, nothing', async () => {
    const note = 'first line\n\nsecond';
    const dir = tempFolder({F: note});
    const {window, ui} = await openWindow(dir, {last: 'F'});
    shortcut(ui, Gdk.KEY_b, KEY.b, CTRL);
    eq(ui.text, note, 'rendered, no field: unchanged');
    clickAt(ui, 2);
    const field = fieldOf(ui);
    ok(field, 'a field');
    eq(field.buffer.text, 'first line');
    const buffer = field.buffer;
    buffer.select_range(buffer.get_iter_at_offset(10), buffer.get_iter_at_offset(6));
    ok(shortcut(ui, Gdk.KEY_b, KEY.b, CTRL), 'Ctrl+B is taken');
    eq(buffer.text, 'first **line**', 'the field\'s selection in bold');
    eq(ui.text, note, 'the source waits for the field');
    field.activate_action('note.bold', null);
    eq(buffer.text, 'first line', 'again: off');
    field.activate_action('note.link', null);
    eq(buffer.text, 'first [line](https://)', 'Link in the field');
    buffer.undo();
    eq(buffer.text, 'first line', 'one step of the field\'s own undo');
    buffer.select_range(buffer.get_iter_at_offset(10), buffer.get_iter_at_offset(6));
    shortcut(ui, Gdk.KEY_b, KEY.b, CTRL);
    press(field, Gdk.KEY_Return, CTRL);
    ok(!fieldOf(ui), 'Ctrl+Enter writes it');
    eq(ui.text, 'first **line**\n\nsecond');
    ui.rendered.activate_action('note.undo', null);
    eq(ui.text, note, 'one undo step in the note');
    await closeWindow(window);
});

test('window: Ctrl+Shift+M switches MD, the keys staying in the note; an open field is written first', async () => {
    const note = 'first line\n\nsecond';
    const dir = tempFolder({F: note});
    const {window, settings, ui} = await openWindow(dir, {last: 'F'});
    ok(shortcut(ui, Gdk.KEY_M, KEY.m, CTRL | SHIFT), 'taken');
    ok(settings.get_boolean('notes-markdown-source') && ui.markdownButton.active, 'MD on');
    ok(ui.editor.get_mapped() && await waitFor(() => ui.editor.has_focus), 'the source, focused');
    eq(ui.markdownButton.tooltip_text, 'Show rendered Markdown (Ctrl+Shift+M)');
    ui.editor.activate_action('note.markdown', null);
    ok(!settings.get_boolean('notes-markdown-source') && ui.rendered.get_mapped(), 'MD off');
    ok(await waitFor(() => ui.rendered.has_focus), 'the rendered view, focused');
    ok(!shortcut(ui, Gdk.KEY_m, KEY.m, CTRL), 'Ctrl+M is no shortcut');

    clickAt(ui, 2);
    fieldOf(ui).buffer.text = 'first word';
    shortcut(ui, Gdk.KEY_M, KEY.m, CTRL | SHIFT);
    eq(ui.text, 'first word\n\nsecond', 'the field written into the source');
    ok(settings.get_boolean('notes-markdown-source'), 'MD on');
    await closeWindow(window);
});

test('window: on a read-only note the shortcuts change nothing; Ctrl+Shift+M still switches MD', async () => {
    const latin1 = [0x63, 0x61, 0x66, 0xE9, 0x0A];
    const dir = tempFolder({});
    dir.get_child('L.md').replace_contents(new Uint8Array(latin1), null, false, 0, null);
    const {window, settings, ui} = await openWindow(dir, {last: 'L', source: true});
    eq(ui.open, 'L');
    const before = ui.text;
    ui.select(0, 3);
    ui.editor.activate_action('note.bold', null);
    shortcut(ui, Gdk.KEY_b, KEY.b, CTRL);
    shortcut(ui, Gdk.KEY_asterisk, KEY[8], CTRL | SHIFT);
    shortcut(ui, Gdk.KEY_k, KEY.k, CTRL);
    eq(ui.text, before, 'unchanged');
    shortcut(ui, Gdk.KEY_M, KEY.m, CTRL | SHIFT);
    ok(!settings.get_boolean('notes-markdown-source'), 'MD off');
    clickAt(ui, 1);
    ok(!fieldOf(ui), 'rendered, no field opens');
    shortcut(ui, Gdk.KEY_b, KEY.b, CTRL);
    eq(ui.text, before, 'still unchanged');
    await sleep(AUTOSAVE);
    eq([...dir.get_child('L.md').load_contents(null)[1]], latin1, 'byte for byte');
    await closeWindow(window);
});

test('window: Edit table: a grid of cells; Add row, then Done writes the table, one undo step', async () => {
    const note = 'Intro\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nend';
    const dir = tempFolder({F: note});
    const {window, ui} = await openWindow(dir, {last: 'F'});
    ok(await waitFor(() => blockPictures(ui).length === 1, 15000), 'the table drawn');
    const picture = blockPictures(ui)[0];
    const entries = () => [...walk(ui.rendered)].filter(w => w instanceof Gtk.Entry);
    const button = label => find(ui.rendered, w => w instanceof Gtk.Button && w.label === label);
    (await menuOf(picture)).find(b => b.label === 'Edit table').emit('clicked');
    eq(entries().map(e => e.text), ['a', 'b', '1', '2'], 'its cells');
    ok(entries()[0].attributes && !entries()[2].attributes, 'the header in bold');
    ok(!entries().some(e => e.text.includes('|')), 'no pipes');
    ok(await waitFor(() => !shown(picture)), 'the grid instead of the picture');
    button('Add row').emit('clicked');
    eq(entries().length, 6, 'a row of two more cells');
    entries()[4].text = 'x';
    entries()[5].text = 'y';
    button('Done').emit('clicked');
    const table = '| a   | b   |\n| --- | --- |\n| 1   | 2   |\n| x   | y   |';
    eq(ui.text, `Intro\n\n${table}\n\nend`, 'Done: the table written back');
    ok(await waitFor(() => entries().length === 0 && blockPictures(ui).length === 1, 15000), 'drawn again');
    await sleep(AUTOSAVE);
    eq(read(dir, 'F.md'), `Intro\n\n${table}\n\nend`, 'saved');
    ui.rendered.activate_action('note.undo', null);
    eq(ui.text, note, 'one undo step');

    // Cancel leaves it as it was.
    ok(await waitFor(() => blockPictures(ui).length === 1, 15000));
    (await menuOf(blockPictures(ui)[0])).find(b => b.label === 'Edit table').emit('clicked');
    find(ui.rendered, w => w instanceof Gtk.Button && w.tooltip_text === 'Remove column').emit('clicked');
    eq(entries().map(e => e.text), ['b', '2'], 'a column removed in the grid');
    button('Cancel').emit('clicked');
    eq(ui.text, note, 'Cancel: unchanged');
    ok(entries().length === 0, 'closed');
    await closeWindow(window);
});

test('window: a diagram: Copy Mermaid code; Edit Mermaid code beside its live picture; Done, one undo step; Cancel', async () => {
    const note = 'Intro\n\n```mermaid\ngraph TD\nA-->B\n```\n\nend';
    const dir = tempFolder({F: note});
    const {window, ui} = await openWindow(dir, {last: 'F'});
    ok(await waitFor(() => blockPictures(ui).length === 1, 15000), 'the diagram drawn');
    const picture = blockPictures(ui)[0];
    const choose = async label => (await menuOf(picture)).find(b => b.label === label).emit('clicked');
    eq((await menuOf(picture)).map(b => b.label), ['Copy as JPEG', 'Copy Mermaid code', 'Edit Mermaid code']);
    await choose('Copy Mermaid code');
    await sleep(100);
    eq(new TextDecoder().decode(new Uint8Array(await readClipboard(ui.rendered.get_clipboard(),
        'text/plain;charset=utf-8'))), 'graph TD\nA-->B', 'the code alone, without the fence lines');

    await choose('Edit Mermaid code');
    const editor = () => find(ui.rendered, w => w instanceof Gtk.Box && w.has_css_class('card'));
    ok(editor(), 'the editor, in the text');
    const field = find(editor(), w => w instanceof Gtk.TextView);
    const live = find(editor(), w => w instanceof Gtk.Picture);
    const toggle = label => find(editor(), w => w instanceof Gtk.ToggleButton && w.label === label);
    const button = label => find(editor(), w => w instanceof Gtk.Button && w.label === label);
    const caption = () => find(editor(), w => w instanceof Gtk.Label && shown(w) && /^(Not drawn|Could not)/.test(w.label));
    const height = () => live.paintable?.get_intrinsic_height() ?? 0;
    eq(field.buffer.text, 'graph TD\nA-->B', 'its code');
    ok(field.monospace, 'monospace');
    ok(await waitFor(() => field.has_focus), 'with the focus');
    ok(await waitFor(() => height() === 40, 15000), 'its picture');
    ok(!shown(picture), 'in place of the drawn diagram');
    ok(toggle('Split').active && shown(field) && shown(live), 'Split: both');
    const [code, drawing] = [field, live].map(w => boundsOf(w, ui.rendered));
    ok(code.x + code.width <= drawing.x && Math.abs(code.y - drawing.y) < 40,
        `side by side: the code at ${code.x},${code.y}, the picture at ${drawing.x},${drawing.y}`);
    toggle('Code').active = true;
    ok(shown(field) && !shown(live), 'Code: the code alone');
    toggle('Preview').active = true;
    ok(!shown(field) && shown(live), 'Preview: the picture alone');
    toggle('Split').active = true;

    // Drawn again as the code changes: a failure says why, under it.
    field.buffer.text = 'pie\n"a" : 1';
    ok(await waitFor(() => /^Could not render diagram: pie diagrams/.test(caption()?.label ?? ''), 15000),
        `why: ${caption()?.label}`);
    field.buffer.text = 'graph TD\nA-->B\nB-->C';
    ok(await waitFor(() => height() === 60 && !caption(), 15000), `a node more: ${height()} high, ${caption()?.label}`);

    // Ctrl+Enter is Done: the code between the fence lines.
    controllers(editor()).find(c => c instanceof Gtk.EventControllerKey)
        .emit('key-pressed', Gdk.KEY_Return, 0, Gdk.ModifierType.CONTROL_MASK);
    const edited = note.replace('A-->B', 'A-->B\nB-->C');
    eq(ui.text, edited, 'written back, the fence as it was');
    ok(await waitFor(() => !editor() && blockPictures(ui).length === 1 &&
        blockPictures(ui)[0].paintable.get_intrinsic_height() === 60, 15000), 'drawn again');
    ui.rendered.activate_action('note.undo', null);
    eq(ui.text, note, 'one undo step');

    // Cancel (and Escape) leave it as it was; the layout chosen stays.
    ok(await waitFor(() => blockPictures(ui).length === 1 &&
        blockPictures(ui)[0].paintable.get_intrinsic_height() === 40, 15000));
    await choose('Edit Mermaid code');
    toggle('Preview').active = true;
    find(editor(), w => w instanceof Gtk.TextView).buffer.text = 'graph LR';
    button('Cancel').emit('clicked');
    eq(ui.text, note, 'Cancel: unchanged');
    ok(!editor(), 'closed');
    await choose('Edit Mermaid code');
    ok(toggle('Preview').active && !shown(find(editor(), w => w instanceof Gtk.TextView)),
        'opened again as it was left: Preview');
    toggle('Split').active = true;
    controllers(editor()).find(c => c instanceof Gtk.EventControllerKey).emit('key-pressed', Gdk.KEY_Escape, 0, 0);
    ok(!editor() && ui.text === note, 'Escape: closed, unchanged');
    await closeWindow(window);
});

// A right click at a character of the rendered view: the items of the
// code menu it opens (none: the view's own menu would show).
async function codeMenuAt(ui, offset) {
    const box = boxAt(ui, offset);
    controllers(ui.rendered).find(c => c instanceof Gtk.GestureClick && c.get_button() === Gdk.BUTTON_SECONDARY)
        .emit('pressed', 1, box.x + 1, box.y + box.height / 2);
    await sleep(100);
    const popover = [...walk(layer(ui))].find(w => w instanceof Gtk.Popover &&
        find(w, b => b instanceof Gtk.Button && b.label === 'Copy code'));
    return popover?.visible ? [...walk(popover)].filter(w => w instanceof Gtk.Button && w.label) : [];
}

test('window: right-click code: Copy code copies the code alone; Edit code opens its part, one undo step', async () => {
    // "Run `npm test` first\n" 0-20, "\n" 21, "```js\n" 22-27, "let a = 1;\n"
    // 28-38, "let b = 2;\n" 39-49, "```\n" 50-53, "\n" 54, "end" 55-57.
    const fence = '```js\nlet a = 1;\nlet b = 2;\n```';
    const note = `Run \`npm test\` first\n\n${fence}\n\nend`;
    const dir = tempFolder({F: note});
    const {window, ui} = await openWindow(dir, {last: 'F'});
    const clipboard = ui.rendered.get_clipboard();
    const copied = async () => new TextDecoder().decode(new Uint8Array(
        await readClipboard(clipboard, 'text/plain;charset=utf-8')));
    const labels = items => items.map(b => b.label);
    const choose = (items, label) => {
        const item = items.find(b => b.label === label);
        if (!item)
            throw new Error(`no ${label} in [${labels(items)}]`);
        item.emit('clicked');
    };

    let items = await codeMenuAt(ui, 7);
    eq(labels(items), ['Copy code', 'Edit code'], 'on an inline span');
    choose(items, 'Copy code');
    ok(await waitFor(() => clipboard.get_formats().contain_mime_type('text/plain;charset=utf-8')));
    eq(await copied(), 'npm test', 'the span\'s text');

    items = await codeMenuAt(ui, 30);
    eq(labels(items), ['Copy code', 'Edit code'], 'on a code block');
    choose(items, 'Copy code');
    await sleep(100);
    eq(await copied(), 'let a = 1;\nlet b = 2;', 'its lines, without the fences and "js"');

    eq(labels(await codeMenuAt(ui, 56)), [], 'plain text: the view\'s own menu');
    const buffer = ui.rendered.buffer;
    buffer.select_range(buffer.get_iter_at_offset(0), buffer.get_iter_at_offset(3));
    items = await codeMenuAt(ui, 42);
    eq(labels(items), ['Copy', 'Copy code', 'Edit code'], 'over a selection, Copy too');
    items[0].get_ancestor(Gtk.Popover.$gtype).popdown();
    buffer.place_cursor(buffer.get_start_iter());
    await sleep(300);

    // Edit code: the part holding it, in a field.
    choose(await codeMenuAt(ui, 9), 'Edit code');
    eq(fieldOf(ui)?.buffer.text, 'Run `npm test` first', 'a span: its line');
    press(fieldOf(ui), Gdk.KEY_Escape);
    await sleep(500); // laid out again without the field
    choose(await codeMenuAt(ui, 30), 'Edit code');
    const field = fieldOf(ui);
    eq(field?.buffer.text, fence, 'a code block: its Markdown, fences too');
    ok(await waitFor(() => field.has_focus), 'with the focus');
    field.buffer.text = fence.replace('1;', '10;');
    press(field, Gdk.KEY_Return, Gdk.ModifierType.CONTROL_MASK);
    eq(ui.text, note.replace('1;', '10;'), 'Ctrl+Enter writes it back');
    ok(!fieldOf(ui), 'closed');
    ui.rendered.activate_action('note.undo', null);
    eq(ui.text, note, 'one undo step');
    await closeWindow(window);
});

// The rows of the note's one table, its header and divider too.
const parseRows = text => text.split('\n').filter(line => line.startsWith('|')).length;

// The rendered view's resize grips that show.
const grips = ui => [...walk(layer(ui))]
    .filter(w => w instanceof Gtk.Button && w.has_css_class('froonty-render-resize') && shown(w));

// Each drawn picture on its block's line, top to bottom, its grip at its
// bottom right corner; '' when all are, else what is not.
function misplaced(ui) {
    const view = ui.rendered;
    const offsets = [...view.buffer.text].flatMap((char, i) => (char === '￼' ? [i] : []));
    const placed = blockPictures(ui).map(p => boundsOf(p, view)).sort((a, b) => a.y - b.y);
    const problems = [];
    if (placed.length !== offsets.length)
        problems.push(`${placed.length} pictures for ${offsets.length} blocks`);
    placed.forEach((p, i) => {
        const line = offsets[i] === undefined ? null : boxAt(ui, offsets[i]);
        if (!line || Math.abs(p.x - line.x) > 1 || Math.abs(p.y - line.y) > 1)
            problems.push(`picture ${i} at ${p.x},${p.y}, its line at ${line?.x},${line?.y}`);
        if (i && p.y < placed[i - 1].y + placed[i - 1].height)
            problems.push(`picture ${i} over picture ${i - 1}`);
    });
    const corners = grips(ui).map(g => boundsOf(g, view));
    if (corners.length !== placed.length)
        problems.push(`${corners.length} grips for ${placed.length} pictures`);
    for (const g of corners) {
        if (!placed.some(p => Math.abs(g.x + g.width - p.x - p.width) <= 1 &&
            Math.abs(g.y + g.height - p.y - p.height) <= 1))
            problems.push(`a grip at ${g.x},${g.y} on no picture`);
    }
    return problems.join('; ');
}

test('window: Edit table, Add row, Done or Cancel: pictures and grips on their lines, nothing selected', async () => {
    const table = '| a | b |\n| --- | --- |\n| 1 | 2 |';
    const note = `- [ ] task\n\n\`\`\`mermaid\ngraph TD\nA-->B\n\`\`\`\n\n![big](big.png)\n\n${table}\n\nend`;
    const dir = tempFolder({F: note});
    png(900, 700, dir, 'big.png');
    const {window, ui} = await openWindow(dir, {last: 'F'});
    window.set_default_size(760, 400);
    ok(await waitFor(() => blockPictures(ui).length === 3, 15000), `drawn: ${blockPictures(ui).length}`);
    // Scrolled down to the table, as to right-click it.
    const scroll = ui.rendered.get_ancestor(Gtk.ScrolledWindow.$gtype).vadjustment;
    ok(await waitFor(() => scroll.upper > scroll.page_size + 60, 5000), `scrolls: ${scroll.upper} for ${scroll.page_size}`);
    scroll.value = scroll.upper - scroll.page_size;
    eq(ui.lit, [], 'rendered: no toggle lit, though the source\'s cursor is on a task');
    ok(await waitFor(() => !misplaced(ui), 5000), `placed: ${misplaced(ui)}`);
    const entries = () => [...walk(ui.rendered)].filter(w => w instanceof Gtk.Entry);
    const button = label => find(ui.rendered, w => w instanceof Gtk.Button && w.label === label);
    const editTable = async (beforeClick = () => {}) => {
        // The lowest: the diagram, above, is as wide.
        const picture = blockPictures(ui).filter(p => p.paintable.get_intrinsic_width() === 120)
            .sort((a, b) => boundsOf(b, ui.rendered).y - boundsOf(a, ui.rendered).y)[0];
        const items = await menuOf(picture);
        beforeClick();
        items.find(b => b.label === 'Edit table').emit('clicked');
        ok(await waitFor(() => entries().length > 0 && blockPictures(ui).length === 2),
            `the grid open: ${entries().length} cells, ${blockPictures(ui).length} pictures`);
    };
    const grid = () => find(ui.rendered, w => w instanceof Gtk.Box && w.has_css_class('card'));
    const noSelection = () => !ui.rendered.buffer.get_has_selection();

    // The image's place selected (a double click there): none once the grid is open.
    const rendered = ui.rendered.buffer;
    const imageAt = [...rendered.text].flatMap((char, i) => (char === '\uFFFC' ? [i] : []))[1];
    await editTable(() => rendered.select_range(rendered.get_iter_at_offset(imageAt),
        rendered.get_iter_at_offset(imageAt + 1)));
    ok(await waitFor(() => grips(ui).length === 2 && !misplaced(ui), 5000), `the grid open: ${misplaced(ui)}`);
    const image = blockPictures(ui).find(p => p.paintable.get_intrinsic_width() === 900);
    const below = () => boundsOf(image, ui.rendered).y + boundsOf(image, ui.rendered).height;
    ok(await waitFor(() => boundsOf(grid(), ui.rendered).y >= below(), 3000),
        `the grid at ${boundsOf(grid(), ui.rendered).y}, under the image (to ${below()})`);
    ok(noSelection(), 'nothing selected');
    eq(ui.lit, [], 'the grid open: no toggle lit');
    button('Add row').emit('clicked');
    // Taller now: still under the image, the text after it under the grid.
    const end = () => boxAt(ui, [...ui.rendered.buffer.text].length - 1).y;
    const gridBottom = () => boundsOf(grid(), ui.rendered).y + boundsOf(grid(), ui.rendered).height;
    ok(await waitFor(() => boundsOf(grid(), ui.rendered).y >= below() && end() >= gridBottom(), 3000),
        `a row more: the grid at ${boundsOf(grid(), ui.rendered).y}-${gridBottom()}, the image to ${below()}, ` +
        `the next line at ${end()}`);
    button('Done').emit('clicked');
    ok(ui.text !== note && parseRows(ui.text) === 4, `Done: written (${ui.text})`);
    ok(await waitFor(() => entries().length === 0 && blockPictures(ui).length === 3, 15000), 'drawn again');
    ok(await waitFor(() => !misplaced(ui), 5000), `after Done: ${misplaced(ui)}`);
    ok(noSelection(), 'after Done: nothing selected');
    eq(ui.lit, [], 'after Done: no toggle lit');

    await editTable();
    button('Cancel').emit('clicked');
    ok(await waitFor(() => entries().length === 0 && blockPictures(ui).length === 3, 15000), 'closed');
    ok(await waitFor(() => !misplaced(ui), 5000), `after Cancel: ${misplaced(ui)}`);
    ok(noSelection(), 'after Cancel: nothing selected');
    await closeWindow(window);
});

await done();
