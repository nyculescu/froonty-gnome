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
    ok(/^\d{4}-\d\d-\d\d \d\d\.\d\d$/.test(service.selected), service.selected);
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

await done();
