// SPDX-License-Identifier: GPL-3.0-or-later
// Notes: store and service against a temporary folder (plain gjs, no Shell).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {test, eq, ok, done} from './test.js';
import {NotesStore} from '../../froonty@catalin/features/notes/store.js';
import {NotesService} from '../../froonty@catalin/features/notes/service.js';

// Trashing files must not reach the real Trash: only run via tools/unit/run.sh.
if (!GLib.getenv('FROONTY_UNIT_ISOLATED')) {
    printerr('Run this through tools/unit/run.sh (isolated TMPDIR/XDG_DATA_HOME).');
    imports.system.exit(2);
}

const EXTENSION_DIR = GLib.build_filenamev([
    GLib.path_get_dirname(GLib.path_get_dirname(GLib.path_get_dirname(
        GLib.filename_from_uri(import.meta.url)[0]))),
    'froonty@catalin']);

const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms,
    () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));

// Froonty's real schema, with an in-memory backend: nothing touches dconf.
function makeSettings() {
    const source = Gio.SettingsSchemaSource.new_from_directory(
        GLib.build_filenamev([EXTENSION_DIR, 'schemas']), null, false);
    return new Gio.Settings({
        settings_schema: source.lookup('org.gnome.shell.extensions.froonty', false),
        backend: Gio.memory_settings_backend_new(),
    });
}

function tempDir() {
    return Gio.File.new_for_path(GLib.dir_make_tmp('froonty-notes-XXXXXX'));
}

async function readFile(dir, name) {
    const [, bytes] = dir.get_child(name).load_contents(null);
    return new TextDecoder().decode(bytes);
}

// ---- store

test('store: creates nested folder, lists only .md, sorted naturally', async () => {
    const root = tempDir();
    const store = new NotesStore(root.get_child('a').get_child('b'));
    await store.ensureFolder();
    await store.ensureFolder(); // idempotent
    for (const name of ['Note 10', 'note 2'])
        await store.create(name);
    store.folder.get_child('ignore.txt').replace_contents('x', null, false, 0, null);
    eq(await store.list(), ['note 2', 'Note 10']);
});

test('store: write/read round-trip with non-ASCII text', async () => {
    const store = new NotesStore(tempDir());
    await store.create('n');
    await store.write('n', 'Ță 😀\nline 2');
    eq(await store.read('n'), 'Ță 😀\nline 2');
});

test('store: create and rename never overwrite another note', async () => {
    const store = new NotesStore(tempDir());
    await store.create('a');
    await store.create('b');
    let failed = false;
    try {
        await store.create('a');
    } catch {
        failed = true;
    }
    ok(failed, 'create over an existing note must fail');

    failed = false;
    try {
        await store.rename('a', 'b');
    } catch (e) {
        failed = e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS);
    }
    ok(failed, 'rename onto an existing note must fail with EXISTS');
    await store.rename('a', 'c');
    eq(await store.list(), ['b', 'c']);
});

// ---- service

async function startService(folder) {
    const settings = makeSettings();
    settings.set_string('notes-folder', folder.get_path());
    const service = new NotesService({settings, dataDir: tempDir()});
    let changes = 0;
    service.connect('changed', () => changes++);
    service.start();
    await service.whenReady();
    return {service, settings, changes: () => changes};
}

test('service: empty folder, then create selects a timestamped note', async () => {
    const {service} = await startService(tempDir());
    eq(service.notes, []);
    eq(service.selected, null);
    await service.create();
    ok(/^\d\d\.\d\d\.\d\d \d\d\.\d\d$/.test(service.selected), service.selected);
    await service.create();
    ok(service.selected.endsWith(' (2)'), 'second note in the same minute');
    eq(service.notes.length, 2);
    service.stop();
});

test('service: autosaves 0.8 s after the last change, not before', async () => {
    const dir = tempDir();
    const {service} = await startService(dir);
    await service.create();
    const file = `${service.selected}.md`;
    service.setText('draft');
    await sleep(300);
    eq(await readFile(dir, file), '', 'not saved yet');
    service.setText('draft 2'); // resets the timer
    await sleep(600);
    eq(await readFile(dir, file), '', 'timer was reset');
    await sleep(500);
    eq(await readFile(dir, file), 'draft 2');
    service.stop();
});

test('service: hide flushes immediately; stop flushes too', async () => {
    const dir = tempDir();
    const {service} = await startService(dir);
    await service.create();
    const file = `${service.selected}.md`;
    service.setText('on hide');
    service.setActive(false);
    await sleep(100);
    eq(await readFile(dir, file), 'on hide');
    service.setText('on stop');
    service.stop();
    await sleep(100);
    eq(await readFile(dir, file), 'on stop');
});

test('service: remembers the last note across restarts', async () => {
    const dir = tempDir();
    const store = new NotesStore(dir);
    for (const name of ['a', 'b', 'c'])
        await store.create(name);
    const first = await startService(dir);
    eq(first.service.selected, 'c', 'defaults to the last note');
    await first.service.select('a');
    const last = first.settings.get_string('notes-last');
    first.service.stop();
    eq(last, 'a');
});

test('service: rename validates, renames the file and keeps the selection', async () => {
    const dir = tempDir();
    const {service} = await startService(dir);
    await service.create();
    service.setText('keep me');
    eq(await service.rename('bad/name'), false);
    eq(await service.rename('Plan'), true);
    eq(service.selected, 'Plan');
    eq(await readFile(dir, 'Plan.md'), 'keep me', 'pending text flushed before rename');
    service.stop();
});

test('service: trash selects the neighbour and drops unsaved edits', async () => {
    const dir = tempDir();
    const store = new NotesStore(dir);
    for (const name of ['a', 'b', 'c'])
        await store.create(name);
    const {service} = await startService(dir);
    await service.select('b');
    service.setText('unsaved');
    await service.trash('b');
    eq(service.notes, ['a', 'c']);
    eq(service.selected, 'c');
    ok(!dir.get_child('b.md').query_exists(null), 'b.md moved away');
    service.stop();
});

test('service: tabs keep creation order, not name order', async () => {
    const dir = tempDir();
    const store = new NotesStore(dir);
    await store.create('28.09.26 10.00');
    const {service} = await startService(dir);
    // Created elsewhere later, but its name sorts first ("01." < "28.").
    await store.create('01.10.26 09.00');
    await sleep(1500); // let the folder monitor report it
    eq(service.notes, ['28.09.26 10.00', '01.10.26 09.00']);
    await service.create(); // appended, whatever its name
    const created = service.selected;
    service.stop();

    const again = await startService(dir);
    eq(again.service.notes.at(-1), created, 'the newest note stays last after a restart');
    again.service.stop();
});

test('service: colour is per note, persisted, and survives rename', async () => {
    const dir = tempDir();
    const {service} = await startService(dir);
    await service.create();
    eq(service.color, 'yellow', 'default');
    await service.setColor('green');
    await service.setColor('not-a-colour');
    eq(service.color, 'green');
    await service.rename('Plan');
    service.stop();

    const again = await startService(dir);
    eq(again.service.colorOf('Plan'), 'green');
    eq(await readFile(dir, 'Plan.md'), '', 'the .md file stays plain text');
    again.service.stop();
});

test('service: external edit reloads a clean note, not a dirty one', async () => {
    const dir = tempDir();
    const store = new NotesStore(dir);
    await store.create('n');
    const {service} = await startService(dir);
    await store.write('n', 'from another editor');
    await sleep(1500); // inotify + the monitor's rate limit
    eq(service.text, 'from another editor');

    service.setText('typing…');
    await store.write('n', 'external again');
    await sleep(1500);
    eq(service.text, 'typing…', 'unsaved edits are not replaced');
    service.stop();
});

// ---- labels, conflicts and races

// Modification times are etags; competing writes stay this far apart.
const GAP = 30;

const labelsFile = dir => dir.get_child('.froonty-labels.json');

function readLabelsFile(dir) {
    const [, bytes] = labelsFile(dir).load_contents(null);
    return JSON.parse(new TextDecoder().decode(bytes));
}

function fileBytes(file) {
    return new TextDecoder().decode(file.load_contents(null)[1]);
}

async function notesIn(names) {
    const dir = tempDir();
    const store = new NotesStore(dir);
    for (const name of names)
        await store.create(name);
    return {dir, store};
}

test('labels: set on another note, written at once, only labels-changed, kept', async () => {
    const {dir} = await notesIn(['a', 'b', 'c']);
    const {service, changes} = await startService(dir);
    let labelChanges = 0;
    service.connect('labels-changed', () => labelChanges++);
    const before = changes();
    await service.setLabel('a', 'work', true);
    eq(changes(), before, 'no "changed": the tabs are not rebuilt');
    eq(labelChanges, 1);
    eq(readLabelsFile(dir), {version: 1, labels: {a: ['work']}});
    eq(service.labelsOf('a'), ['work']);
    eq(service.selected, 'c', 'the selection did not move');
    await service.setLabel('nope', 'x', true);
    eq(Object.keys(readLabelsFile(dir).labels), ['a'], 'not for notes that do not exist');
    service.stop();

    const again = await startService(dir);
    eq(again.service.labelsOf('a'), ['work']);
    eq(again.service.allLabels(), [{label: 'work', count: 1}]);
    again.service.stop();
});

test('labels: follow a rename; stay after Trash (not counted); a new note of that name clears them', async () => {
    const {dir} = await notesIn(['a', 'b']);
    const {service} = await startService(dir);
    await service.select('a');
    await service.setLabel('a', 'work', true);
    await service.setLabel('b', 'home', true);
    eq(await service.rename('Plan'), true);
    eq(service.labelsOf('Plan'), ['work']);
    eq(readLabelsFile(dir).labels, {b: ['home'], Plan: ['work']});

    await service.trash('Plan');
    eq(readLabelsFile(dir).labels.Plan, ['work'], 'kept for a restore from the Trash');
    eq(service.allLabels(), [{label: 'home', count: 1}], 'not counted while trashed');

    // An old entry under the name the next new note gets.
    const now = GLib.DateTime.new_now_local();
    const soon = now.add_minutes(1);
    const stale = {};
    for (const time of [now, soon])
        stale[time.format('%d.%m.%y %H.%M')] = ['stale'];
    labelsFile(dir).replace_contents(JSON.stringify({version: 1, labels: {...readLabelsFile(dir).labels, ...stale}}),
        null, false, 0, null);
    await sleep(1500);
    await service.create();
    eq(service.labelsOf(service.selected), [], 'a new note starts without labels');
    ok(!readLabelsFile(dir).labels[service.selected], 'and its stale entry is gone');
    service.stop();
});

test('labels: an edit of the file elsewhere between two of ours is kept', async () => {
    const {dir} = await notesIn(['a', 'b']);
    const {service} = await startService(dir);
    await service.setLabel('a', 'x', true);
    await sleep(GAP);
    const data = readLabelsFile(dir);
    data.labels.b = ['theirs'];
    labelsFile(dir).replace_contents(JSON.stringify(data), null, false, 0, null);
    await sleep(GAP);
    await service.setLabel('a', 'y', true);
    eq(readLabelsFile(dir).labels, {a: ['x', 'y'], b: ['theirs']});
    ok(dir.get_child('.froonty-labels.json~').query_exists(null), 'the previous version is kept as ~');
    service.stop();
});

test('labels: a file Froonty cannot read stays as it is; labels are read-only', async () => {
    for (const content of ['{"version": 1, "labels": {"a": [', '{"version": 2, "labels": {"a": ["x"]}}']) {
        const {dir} = await notesIn(['a']);
        labelsFile(dir).replace_contents(content, null, false, 0, null);
        const {service} = await startService(dir);
        eq(service.labelsState, 'unreadable', content);
        await service.setLabel('a', 'work', true);
        ok(service.error?.includes('.froonty-labels.json'), `error shown: ${service.error}`);
        await service.rename('b');
        eq(fileBytes(labelsFile(dir)), content, 'byte for byte');
        service.stop();
    }
});

test('conflict: an edit elsewhere during unsaved typing keeps both', async () => {
    const {dir, store} = await notesIn(['n']);
    await store.write('n', 'base');
    const {service} = await startService(dir);
    eq(service.text, 'base');
    service.setText('mine'); // unsaved: the 0.8 s pause has not passed
    await sleep(GAP);
    store.folder.get_child('n.md').replace_contents('external', null, false, 0, null);
    await sleep(200);
    eq(service.text, 'mine', 'not reloaded under the typing');
    await service.flush();
    await sleep(300);
    eq(await readFile(dir, 'n.md'), 'external', 'theirs is untouched');
    eq(await readFile(dir, 'n (conflict).md'), 'mine');
    eq(service.selected, 'n (conflict)');
    eq(service.text, 'mine');
    eq(service.notice, {kind: 'conflict', name: 'n', copy: 'n (conflict)'});
    eq(service.notes, ['n', 'n (conflict)'], 'the copy is added at the end');
    const [, metaBytes] = dir.get_child('.froonty.json').load_contents(null);
    eq(JSON.parse(new TextDecoder().decode(metaBytes)).order, ['n', 'n (conflict)']);
    await service.select('n');
    eq(service.notice, null, 'cleared on select');
    service.stop();
});

test('race: typing during a reload read wins; no reload while a write is in flight', async () => {
    const {dir, store} = await notesIn(['n']);
    await store.write('n', 'base');
    const {service} = await startService(dir);
    // A refresh re-reads the note; a keystroke lands before the read does.
    const reading = service._load('n');
    service.setText('base!');
    await reading;
    eq(service.text, 'base!', 'the keystroke is not undone by the older disk text');
    await service.flush();
    eq(await readFile(dir, 'n.md'), 'base!');
    eq(service.selected, 'n', 'no conflict with our own note');

    service.setText('x'.repeat(300000));
    service.flush(); // a write in flight
    await service._load('n');
    eq(service.text.length, 300000, 'not replaced by what the disk had');
    await service.flush();
    service.stop();
});

test('trash waits for a write in flight (the note is not made again)', async () => {
    const {dir} = await notesIn(['a', 'b']);
    const {service} = await startService(dir);
    await service.select('a');
    service.setText('y'.repeat(300000));
    service.flush();
    await service.trash('a');
    await sleep(500);
    ok(!dir.get_child('a.md').query_exists(null), 'a.md stays in the Trash');
    eq(service.notes, ['b']);
    service.stop();
});

test('the selected note deleted elsewhere with unsaved edits: they go to a copy', async () => {
    const {dir} = await notesIn(['n', 'other']);
    const {service} = await startService(dir);
    await service.select('n');
    service.setText('unsaved');
    dir.get_child('n.md').delete(null);
    await sleep(400); // before the 0.8 s autosave
    eq(await readFile(dir, 'n (conflict).md'), 'unsaved');
    ok(!dir.get_child('n.md').query_exists(null), 'the deleted note is not made again');
    eq(service.selected, 'n (conflict)');
    await sleep(1000);
    ok(!dir.get_child('n.md').query_exists(null), 'nor by the autosave');
    service.stop();
});

test('.froonty.json: keys Froonty does not know survive setColor', async () => {
    const {dir} = await notesIn(['n']);
    dir.get_child('.froonty.json').replace_contents(
        JSON.stringify({version: 1, order: ['n'], colors: {}, later: {x: 1}}), null, false, 0, null);
    const {service} = await startService(dir);
    await service.setColor('green');
    const [, bytes] = dir.get_child('.froonty.json').load_contents(null);
    const meta = JSON.parse(new TextDecoder().decode(bytes));
    eq(meta.later, {x: 1});
    eq(meta.colors, {n: 'green'});
    service.stop();
});

// ---- failed saves, unreadable files, notes from elsewhere

const setMode = (file, mode) =>
    file.set_attribute_uint32('unix::mode', mode, Gio.FileQueryInfoFlags.NONE, null);

test('a failed save keeps the note selected, with its text and error; saved once possible', async () => {
    const {dir, store} = await notesIn(['A', 'B']);
    await store.write('A', 'a');
    await store.write('B', 'b');
    const {service} = await startService(dir);
    await service.select('A');
    service.setText('a typed');
    setMode(dir.get_child('A.md'), 0o444);
    setMode(dir, 0o555);
    try {
        await service.select('B');
        eq(service.selected, 'A', 'the tab did not switch');
        eq(service.text, 'a typed');
        ok(service.error, 'the error stays shown');
        ok(service._writer.dirty, 'still unsaved');
        await service.create();
        eq(service.notes, ['A', 'B'], 'no new note over it either');
        eq(service.selected, 'A');
    } finally {
        setMode(dir, 0o755);
        setMode(dir.get_child('A.md'), 0o644);
    }
    await service.select('B');
    eq(service.selected, 'B');
    eq(await readFile(dir, 'A.md'), 'a typed', 'saved on the way to B');
    eq(service.error, null);
    service.stop();
});

test('a failed save, then another folder: the text is kept as a copy there', async () => {
    const {dir, store} = await notesIn(['A']);
    await store.write('A', 'a');
    const other = await notesIn(['Elsewhere']);
    const {service, settings} = await startService(dir);
    service.setText('a typed');
    setMode(dir.get_child('A.md'), 0o444);
    setMode(dir, 0o555);
    try {
        await service.flush();
        ok(service._writer.dirty);
        settings.set_string('notes-folder', other.dir.get_path());
        await service._enqueue(async () => {}); // after the folder change
    } finally {
        setMode(dir, 0o755);
        setMode(dir.get_child('A.md'), 0o644);
    }
    eq(await readFile(dir, 'A.md'), 'a', 'the old folder is as it was');
    eq(await readFile(other.dir, 'A (conflict).md'), 'a typed', 'the text is in the new folder');
    eq([...service.notes].sort(), ['A (conflict)', 'Elsewhere']);
    eq(service.selected, 'A (conflict)', 'and it is open');
    eq(service.notice, {kind: 'rescued', name: 'A', copy: 'A (conflict)'});
    service.stop();
});

test('a note that is not UTF-8, or holds NUL bytes, is read-only and never written', async () => {
    const {dir} = await notesIn([]);
    const latin1 = [0x63, 0x61, 0x66, 0xE9, 0x0A];
    const nul = [0x61, 0x62, 0x00, 0x63, 0x64, 0x0A];
    dir.get_child('L.md').replace_contents(new Uint8Array(latin1), null, false, 0, null);
    dir.get_child('N.md').replace_contents(new Uint8Array(nul), null, false, 0, null);
    const {service} = await startService(dir);
    await service.select('L');
    eq(service.readOnly, 'not-utf8');
    service.setText('café\nx');
    await service.flush();
    eq(service.text, 'caf\uFFFD\n', 'not taken');
    await service.select('N');
    eq(service.readOnly, 'nul');
    eq(service.text, 'ab\u2400cd\n', 'the whole text, NUL shown as ␀');
    service.setText('abx');
    await service.flush();
    await service.rename('N2'); // a rename moves the file, its bytes stay
    await sleep(300);
    eq([...dir.get_child('L.md').load_contents(null)[1]], latin1, 'L.md byte for byte');
    eq([...dir.get_child('N2.md').load_contents(null)[1]], nul, 'N2.md byte for byte');
    service.stop();
});

test('.froonty.json that cannot be read is never written; it counts again once fixed', async () => {
    const broken = [
        '{"version": 1, "order": ["B", "A"], "colors": {"A": "green", "B": "pink"',
        '{"version": 1, "order": ["B", "A"], "colors": {"A": "green"},, "future": 1}',
        '{"version": 2, "order": ["B", "A"]}',
    ];
    for (const content of broken) {
        const {dir} = await notesIn(['A', 'B']);
        const meta = dir.get_child('.froonty.json');
        meta.replace_contents(content, null, false, 0, null);
        const {service} = await startService(dir);
        eq(service.metaState, 'unreadable', content);
        eq(service.colorOf('A'), 'yellow', 'shown with the defaults');
        await service.select('A');
        await service.setColor('blue');
        await service.create();
        await service.rename('Plan');
        eq(fileBytes(meta), content, 'byte for byte');

        meta.replace_contents(JSON.stringify({version: 1, order: ['B', 'A'], colors: {B: 'pink'}}),
            null, false, 0, null);
        await sleep(1500);
        eq(service.metaState, 'ok');
        eq(service.colorOf('B'), 'pink', 'read again once fixed');
        service.stop();
    }
});

test('notes that appear elsewhere reach the view, even when the open note is unchanged', async () => {
    const {dir, store} = await notesIn(['A']);
    await store.write('A', 'a');
    const {service, changes} = await startService(dir);
    const before = changes();
    dir.get_child('zzz external.md').replace_contents('x', null, false, 0, null);
    await sleep(1500);
    eq(service.notes, ['A', 'zzz external']);
    ok(changes() > before, `"changed" was emitted (${changes() - before})`);
    const after = changes();
    dir.get_child('.froonty.json').replace_contents(
        JSON.stringify({version: 1, order: ['A', 'zzz external'], colors: {A: 'green'}}), null, false, 0, null);
    await sleep(1500);
    eq(service.color, 'green');
    ok(changes() > after, 'a colour changed elsewhere reaches the view too');
    service.stop();
});

await done();
