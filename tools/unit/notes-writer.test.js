// SPDX-License-Identifier: GPL-3.0-or-later
// Notes: the note writer (autosave, etag checks, conflict copies) against a
// temporary folder (plain gjs, no Shell).
//
// Modification times are etags, and a file system only notices changes a
// few milliseconds apart: competing writes here are at least 30 ms apart.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {test, eq, ok, done} from './test.js';
import {NotesStore} from '../../froonty@catalin/features/notes/store.js';
import {NoteWriter} from '../../froonty@catalin/features/notes/noteWriter.js';

if (!GLib.getenv('FROONTY_UNIT_ISOLATED')) {
    printerr('Run this through tools/unit/run.sh (isolated TMPDIR/XDG_DATA_HOME).');
    imports.system.exit(2);
}

const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms,
    () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
const GAP = 30;

function tempStore() {
    return new NotesStore(Gio.File.new_for_path(GLib.dir_make_tmp('froonty-writer-XXXXXX')));
}

function readFile(store, name) {
    const [, bytes] = store.folder.get_child(`${name}.md`).load_contents(null);
    return new TextDecoder().decode(bytes);
}

// Another program writing the note (no etag check).
function writeElsewhere(store, name, text) {
    store.folder.get_child(`${name}.md`).replace_contents(text, null, false, 0, null);
}

async function openNote(store, name, text = '') {
    await store.create(name);
    if (text)
        await store.write(name, text);
    const writer = new NoteWriter(store);
    const conflicts = [];
    const errors = [];
    writer.connect('conflict', (_w, c) => conflicts.push(c));
    writer.connect('error', (_w, e) => errors.push(e.message));
    const disk = await store.readTagged(name);
    writer.open(name, disk.text, disk.etag);
    return {writer, conflicts, errors};
}

test('autosave 0.8 s after the last edit, not before; flush writes at once', async () => {
    const store = tempStore();
    const {writer, conflicts} = await openNote(store, 'n');
    writer.edited('a');
    await sleep(300);
    writer.edited('ab'); // restarts the pause
    await sleep(600);
    eq(readFile(store, 'n'), '', 'not yet');
    ok(writer.dirty);
    await sleep(400);
    eq(readFile(store, 'n'), 'ab');
    ok(!writer.dirty && !writer.busy);
    writer.edited('abc');
    await writer.flush();
    eq(readFile(store, 'n'), 'abc');
    eq(conflicts.length, 0);
    writer.stop();
});

test('quick successive writes are not mistaken for a conflict', async () => {
    const store = tempStore();
    const {writer, conflicts, errors} = await openNote(store, 'n');
    for (const text of ['1', '12', '123', '1234']) {
        writer.edited(text);
        writer.flush();
    }
    await writer.idle();
    eq(readFile(store, 'n'), '1234');
    eq(conflicts.length, 0);
    eq(errors, []);
    eq(await store.list(), ['n']);
    writer.stop();
});

test('a different text written elsewhere: ours goes to "<n> (conflict)", once', async () => {
    const store = tempStore();
    const {writer, conflicts} = await openNote(store, 'n', 'base');
    await sleep(GAP);
    writeElsewhere(store, 'n', 'external');
    await sleep(GAP);
    writer.edited('mine');
    await writer.flush();
    eq(readFile(store, 'n'), 'external', 'theirs is untouched');
    eq(readFile(store, 'n (conflict)'), 'mine');
    eq(conflicts, [{name: 'n', copy: 'n (conflict)'}]);
    eq(writer.name, 'n (conflict)', 'the writer follows the copy');
    await sleep(GAP);
    writer.edited('mine, more');
    await writer.flush();
    eq(readFile(store, 'n (conflict)'), 'mine, more');
    eq(readFile(store, 'n'), 'external');
    eq(conflicts.length, 1);
    writer.stop();
});

test('a touched file (same text, new time) is no conflict', async () => {
    const store = tempStore();
    const {writer, conflicts} = await openNote(store, 'n', 'base');
    await sleep(GAP);
    writeElsewhere(store, 'n', 'base'); // e.g. a sync tool rewriting it
    await sleep(GAP);
    writer.edited('mine');
    await writer.flush();
    eq(readFile(store, 'n'), 'mine');
    eq(conflicts.length, 0);
    eq(await store.list(), ['n']);
    writer.stop();
});

test('our own text written elsewhere is no conflict', async () => {
    const store = tempStore();
    const {writer, conflicts} = await openNote(store, 'n', 'base');
    await sleep(GAP);
    writeElsewhere(store, 'n', 'same');
    await sleep(GAP);
    writer.edited('same');
    await writer.flush();
    eq(conflicts.length, 0);
    eq(await store.list(), ['n']);
    // Its etag was taken over: the next write is no conflict either.
    await sleep(GAP);
    writer.edited('same, then more');
    await writer.flush();
    eq(readFile(store, 'n'), 'same, then more');
    eq(conflicts.length, 0);
    writer.stop();
});

test('stop() writes what is unsaved; a conflict found then is still kept', async () => {
    const store = tempStore();
    const {writer} = await openNote(store, 'n', 'base');
    writer.edited('on stop');
    await writer.stop();
    eq(readFile(store, 'n'), 'on stop');
    writer.edited('after stop'); // no timer any more
    await sleep(1000);
    eq(readFile(store, 'n'), 'on stop');

    const second = await openNote(store, 'm', 'base');
    await sleep(GAP);
    writeElsewhere(store, 'm', 'external');
    await sleep(GAP);
    second.writer.edited('mine');
    second.writer.stop(); // not awaited: disable() does not wait either
    await sleep(500);
    eq(readFile(store, 'm (conflict)'), 'mine');
    eq(readFile(store, 'm'), 'external');
});

test('saveAsCopy never overwrites: (conflict), (conflict) (2)…', async () => {
    const store = tempStore();
    const {writer, conflicts} = await openNote(store, 'n', 'base');
    await store.create('n (conflict)');
    await store.write('n (conflict)', 'older copy');
    writer.edited('unsaved');
    store.folder.get_child('n.md').delete(null); // gone elsewhere
    await writer.saveAsCopy();
    eq(readFile(store, 'n (conflict)'), 'older copy');
    eq(readFile(store, 'n (conflict) (2)'), 'unsaved');
    eq(conflicts, [{name: 'n', copy: 'n (conflict) (2)'}]);
    ok(!writer.dirty);
    writer.stop();
});

test('idle() resolves once writes in flight are done; discard drops edits', async () => {
    const store = tempStore();
    const {writer} = await openNote(store, 'n');
    writer.edited('x'.repeat(200000));
    writer.flush();
    ok(writer.busy, 'a write is in flight');
    await writer.idle();
    ok(!writer.busy);
    eq(readFile(store, 'n').length, 200000);
    writer.edited('dropped');
    writer.discard();
    await sleep(1000);
    eq(readFile(store, 'n').length, 200000);
    ok(!writer.dirty);
    writer.stop();
});

test('open() for another note does not redirect a write in flight', async () => {
    const store = tempStore();
    const {writer} = await openNote(store, 'a');
    await store.create('b');
    writer.edited('for a');
    writer.flush();
    writer.open('b', '', await store.etagOf('b'));
    await writer.idle();
    eq(readFile(store, 'a'), 'for a');
    eq(readFile(store, 'b'), '');
    writer.stop();
});

test('a failed write keeps the text unsaved; open() will not replace it', async () => {
    const store = tempStore();
    const {writer, errors} = await openNote(store, 'a', 'a');
    await store.create('b');
    const note = store.folder.get_child('a.md');
    note.set_attribute_uint32('unix::mode', 0o444, Gio.FileQueryInfoFlags.NONE, null);
    store.folder.set_attribute_uint32('unix::mode', 0o555, Gio.FileQueryInfoFlags.NONE, null);
    try {
        writer.edited('a typed');
        await writer.flush();
        eq(errors.length, 1, 'the failure is reported');
        ok(writer.dirty, 'the text is still unsaved');
        eq(writer.text, 'a typed');
        let refused = false;
        try {
            writer.open('b', '', null);
        } catch {
            refused = true;
        }
        ok(refused, 'open() refuses to drop unsaved text');
        eq(writer.name, 'a');
    } finally {
        store.folder.set_attribute_uint32('unix::mode', 0o755, Gio.FileQueryInfoFlags.NONE, null);
        note.set_attribute_uint32('unix::mode', 0o644, Gio.FileQueryInfoFlags.NONE, null);
    }
    await writer.flush();
    eq(readFile(store, 'a'), 'a typed', 'saved once it can be');
    ok(!writer.dirty);
    writer.open('b', '', await store.etagOf('b'));
    eq(writer.name, 'b');
    writer.stop();
});

test('a note opened read-only is never written', async () => {
    const store = tempStore();
    store.folder.get_child('latin1.md').replace_contents(new Uint8Array([0x63, 0x61, 0x66, 0xE9, 0x0A]),
        null, false, 0, null);
    const read = await store.readTagged('latin1');
    eq(read.readOnly, 'not-utf8');
    eq(read.text, 'caf\uFFFD\n', 'shown with U+FFFD');
    const writer = new NoteWriter(store);
    writer.open('latin1', read.text, read.etag, {readOnly: true});
    writer.edited('café\nx');
    ok(!writer.dirty, 'an edit is not taken');
    await writer.flush();
    await writer.stop();
    eq([...store.folder.get_child('latin1.md').load_contents(null)[1]], [0x63, 0x61, 0x66, 0xE9, 0x0A],
        'byte for byte');

    store.folder.get_child('nul.md').replace_contents(new Uint8Array([0x61, 0x62, 0x00, 0x63, 0x64, 0x0A]),
        null, false, 0, null);
    const nul = await store.readTagged('nul');
    eq(nul.readOnly, 'nul');
    eq(nul.text, 'ab\u2400cd\n', 'the whole text, NUL shown as ␀');
    await store.create('ok');
    await store.write('ok', 'Ță 😀');
    eq(await store.readTagged('ok').then(r => [r.text, r.readOnly]), ['Ță 😀', null], 'UTF-8 is editable');
});

test('a conflict copy starts without the labels an older note of its name had', async () => {
    const store = tempStore();
    const {writer, conflicts} = await openNote(store, 'n', 'base');
    store.folder.get_child('.froonty-labels.json').replace_contents(
        JSON.stringify({version: 1, labels: {'n (conflict)': ['old'], n: ['keep']}}), null, false, 0, null);
    await sleep(GAP);
    writeElsewhere(store, 'n', 'external');
    await sleep(GAP);
    writer.edited('mine');
    await writer.flush();
    eq(conflicts, [{name: 'n', copy: 'n (conflict)'}]);
    const labels = await store.readLabels();
    eq(labels.data.labels, {n: ['keep']}, 'the copy\'s stale entry is gone, the others stay');
    writer.stop();
});

await done();
