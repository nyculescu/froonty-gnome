// SPDX-License-Identifier: GPL-3.0-or-later
// Notes: the All notes window's library (every note, followed through the
// folder monitor) against a temporary folder (plain gjs, no Shell, no GTK).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {test, eq, ok, done, makeSettings as froontySettings, sleep, waitFor} from './test.js';
import {NotesStore} from '../../froonty@catalin/features/notes/store.js';
import {NotesLibrary} from '../../froonty@catalin/features/notes/library.js';

if (!GLib.getenv('FROONTY_UNIT_ISOLATED')) {
    printerr('Run this through tools/unit/run.sh (isolated TMPDIR/XDG_DATA_HOME).');
    imports.system.exit(2);
}

// Folder events (inotify, then GIO's rate limit for changes).
const SETTLE = 1500;

function makeSettings(folder) {
    const settings = froontySettings();
    settings.set_string('notes-folder', folder.get_path());
    return settings;
}

function write(dir, file, text) {
    dir.get_child(file).replace_contents(text, null, false, 0, null);
}

async function startLibrary(dir, createStore) {
    const library = new NotesLibrary({
        settings: makeSettings(dir),
        dataDir: Gio.File.new_for_path(GLib.dir_make_tmp('froonty-data-XXXXXX')),
        ...createStore ? {createStore} : {},
    });
    const events = [];
    library.connect('changed', (_l, change) => events.push(['changed', change]));
    library.connect('renamed', (_l, from, to) => events.push(['renamed', from, to]));
    library.connect('removed', (_l, name) => events.push(['removed', name]));
    let refreshes = 0;
    library.connect('refreshed', () => refreshes++);
    await library.start();
    return {library, events, refreshes: () => refreshes};
}

function folder() {
    return Gio.File.new_for_path(GLib.dir_make_tmp('froonty-library-XXXXXX'));
}

test('library: text, modified time, colour and labels', async () => {
    const dir = folder();
    write(dir, 'Plan.md', '# Q4');
    write(dir, 'b.md', 'two');
    write(dir, 'note.txt', 'not a note');
    write(dir, '.froonty.json', JSON.stringify({version: 1, order: ['b', 'Plan'], colors: {Plan: 'green'}}));
    write(dir, '.froonty-labels.json', JSON.stringify({version: 1, labels: {Plan: ['work'], gone: ['x']}}));
    const {library, events} = await startLibrary(dir);
    eq([...library.notes.keys()].sort(), ['Plan', 'b']);
    eq(library.notes.get('Plan').text, '# Q4');
    const age = Date.now() - library.notes.get('Plan').modified;
    ok(age >= 0 && age < 60000, `modified ${age} ms ago`);
    eq(library.colorOf('Plan'), 'green');
    eq(library.colorOf('b'), 'yellow');
    eq(library.labelsOf('Plan'), ['work']);
    eq(library.allLabels(), [{label: 'work', count: 1}], 'labels of missing notes are not counted');
    eq(events.length, 1, 'one "changed" for the first read');
    library.stop();
});

test('library: follows create, edit, delete and rename', async () => {
    const dir = folder();
    write(dir, 'a.md', 'one');
    const {library, events} = await startLibrary(dir);
    events.length = 0;

    write(dir, 'new.md', 'fresh');
    await sleep(SETTLE);
    eq(library.notes.get('new')?.text, 'fresh');
    ok(events.some(([kind, change]) => kind === 'changed' && change.structure));

    events.length = 0;
    write(dir, 'a.md', 'one, edited');
    await sleep(SETTLE);
    eq(library.notes.get('a').text, 'one, edited');
    ok(events.some(([kind, change]) => kind === 'changed' && change.names.includes('a')));

    events.length = 0;
    dir.get_child('a.md').set_display_name('b.md', null);
    await sleep(SETTLE);
    ok(events.some(([kind, from, to]) => kind === 'renamed' && from === 'a' && to === 'b'),
        JSON.stringify(events));
    eq(library.notes.get('b')?.text, 'one, edited');
    ok(!library.notes.has('a'));

    events.length = 0;
    dir.get_child('new.md').delete(null);
    await sleep(SETTLE);
    ok(!library.notes.has('new'));
    ok(events.some(([kind, name]) => kind === 'removed' && name === 'new'), JSON.stringify(events));
    library.stop();
});

test('library: re-reads only notes whose etag changed', async () => {
    const dir = folder();
    for (const name of ['a', 'b', 'c', 'd'])
        write(dir, `${name}.md`, name);
    const reads = [];
    const spy = f => {
        const store = new NotesStore(f);
        const readTagged = store.readTagged.bind(store);
        store.readTagged = (name, c) => {
            reads.push(name);
            return readTagged(name, c);
        };
        return store;
    };
    const {library} = await startLibrary(dir, spy);
    eq(reads.sort(), ['a', 'b', 'c', 'd']);
    reads.length = 0;
    await sleep(30);
    write(dir, 'c.md', 'c, edited');
    await sleep(SETTLE);
    eq(reads, ['c']);
    reads.length = 0;
    await library.refresh();
    eq(reads, [], 'nothing changed: nothing read');
    library.stop();
});

test('library: labels by read-modify-write; .froonty.json never written', async () => {
    const dir = folder();
    write(dir, 'a.md', 'one');
    write(dir, 'b.md', 'two');
    const meta = JSON.stringify({version: 1, order: ['a', 'b'], colors: {b: 'pink'}});
    write(dir, '.froonty.json', meta);
    const metaEtag = dir.get_child('.froonty.json').query_info('etag::value', 0, null).get_etag();
    const {library} = await startLibrary(dir);
    await library.setLabel('a', 'work', true);
    await sleep(30);
    // Someone else adds a label in between.
    write(dir, '.froonty-labels.json', JSON.stringify({version: 1, labels: {a: ['work'], b: ['theirs']}}));
    await sleep(30);
    await library.setLabel('a', 'home', true);
    const [, bytes] = dir.get_child('.froonty-labels.json').load_contents(null);
    eq(JSON.parse(new TextDecoder().decode(bytes)).labels, {a: ['home', 'work'], b: ['theirs']});
    eq(library.labelsOf('b'), ['theirs']);

    write(dir, 'a.md', 'edited');
    await sleep(SETTLE);
    const [, metaBytes] = dir.get_child('.froonty.json').load_contents(null);
    eq(new TextDecoder().decode(metaBytes), meta, 'byte for byte');
    eq(dir.get_child('.froonty.json').query_info('etag::value', 0, null).get_etag(), metaEtag);
    library.stop();
});

test('library: no events after stop()', async () => {
    const dir = folder();
    write(dir, 'a.md', 'one');
    const {library, events} = await startLibrary(dir);
    library.stop();
    events.length = 0;
    write(dir, 'a.md', 'edited');
    write(dir, 'b.md', 'new');
    dir.get_child('a.md').set_display_name('c.md', null);
    await sleep(SETTLE);
    eq(events, []);
    ok(!library.running);
});

test('library: a rename while the folder is being listed is no removal', async () => {
    const dir = folder();
    write(dir, 'Plan.md', 'plan');
    write(dir, 'Other.md', 'other');
    let slow = false;
    const delayed = f => {
        const store = new NotesStore(f);
        const listInfo = store.listInfo.bind(store);
        // A large or network folder: the listing comes back late.
        store.listInfo = async c => {
            const infos = await listInfo(c);
            if (slow)
                await sleep(300);
            return infos;
        };
        return store;
    };
    const {library, events} = await startLibrary(dir, delayed);
    events.length = 0;
    slow = true;
    write(dir, 'Other.md', 'other, edited'); // a refresh starts listing
    await sleep(100);
    dir.get_child('Plan.md').set_display_name('Q4.md', null); // during it
    await sleep(SETTLE + 600);
    slow = false;
    ok(events.some(([kind, from, to]) => kind === 'renamed' && from === 'Plan' && to === 'Q4'),
        JSON.stringify(events));
    ok(!events.some(([kind, name]) => kind === 'removed' && name === 'Q4'), JSON.stringify(events));
    eq([...library.notes.keys()].sort(), ['Other', 'Q4']);
    eq(library.notes.get('Q4').text, 'plan');
    library.stop();
});

test('library: the same folder keeps its store and notes; another folder starts over', async () => {
    const one = folder();
    write(one, 'Plan.md', 'one');
    const two = folder();
    write(two, 'Plan.md', 'two');
    write(two, 'Other.md', 'other');
    const {library} = await startLibrary(one);
    const store = library.store;
    library.stop();
    await library.start();
    ok(library.store === store, 'same folder: same store');
    library.stop();
    library._settings.set_string('notes-folder', two.get_path());
    eq([...library.notes.keys()], ['Plan'], 'stopped: nothing changes yet');
    const starting = library.start();
    ok(library.store !== store && library.store.folder.equal(two), 'a new store, at once');
    eq(library.notes.size, 0, 'nothing of the old folder is kept');
    await starting;
    eq([...library.notes.keys()].sort(), ['Other', 'Plan']);
    eq(library.notes.get('Plan').text, 'two');
    library.stop();
});

test('library: with a folder monitor no timer runs; a marker change is a refresh', async () => {
    const dir = folder();
    write(dir, 'a.md', 'one');
    const {library, events, refreshes} = await startLibrary(dir);
    ok(!library.polling, 'no 2 s refresh while the monitor works');
    const before = refreshes();
    events.length = 0;
    // The island picks a note (store.writeCurrentNote): nothing to report,
    // but the page hears of it and reads the marker.
    write(dir, '.froonty-current-note', 'a');
    ok(await waitFor(() => refreshes() > before, 3000), 'refreshed');
    eq(events, []);
    library.stop();
});

// The per-user inotify limit used up: Gio cannot make a folder monitor.
const unwatchable = how => f => {
    const store = new NotesStore(f);
    store.monitor = () => {
        if (how === 'throws')
            throw new Error('Unable to find default local file monitor type');
        return null;
    };
    return store;
};

test('library: without a folder monitor it looks every 2 s and follows changes', async () => {
    const dir = folder();
    write(dir, 'a.md', 'one');
    write(dir, 'b.md', 'two');
    const {library, events, refreshes} = await startLibrary(dir, unwatchable('throws'));
    ok(library.polling, 'the fallback refresh runs');
    eq(library.error, null, 'the folder is read all the same');
    events.length = 0;

    write(dir, 'a.md', 'one, edited');
    write(dir, 'new.md', 'fresh');
    dir.get_child('b.md').delete(null);
    write(dir, '.froonty-labels.json', JSON.stringify({version: 1, labels: {a: ['work']}}));
    write(dir, '.froonty.json', JSON.stringify({version: 1, order: ['a'], colors: {a: 'green'}}));
    const seen = () => [[...library.notes.keys()].sort(), library.notes.get('a').text,
        library.labelsOf('a'), library.colorOf('a')];
    ok(await waitFor(() => JSON.stringify(seen()) ===
        JSON.stringify([['a', 'new'], 'one, edited', ['work'], 'green']), 5000),
    JSON.stringify(seen()));
    ok(events.some(([kind, name]) => kind === 'removed' && name === 'b'), JSON.stringify(events));

    const before = refreshes();
    write(dir, '.froonty-current-note', 'a');
    ok(await waitFor(() => refreshes() > before, 3000), 'the marker is looked at too');
    library.stop();
    ok(!library.polling, 'stopped with the page');
});

test('library: a monitor that is null polls too; start() tries the monitor again', async () => {
    const dir = folder();
    write(dir, 'a.md', 'one');
    let broken = true;
    const {library} = await startLibrary(dir, f => (broken ? unwatchable('null')(f) : new NotesStore(f)));
    ok(library.polling);
    write(dir, 'new.md', 'fresh');
    ok(await waitFor(() => library.notes.has('new'), 5000), JSON.stringify([...library.notes.keys()]));
    library.stop();
    ok(!library.polling);
    broken = false;
    await library.restart();
    ok(!library.polling, 'watched once a monitor can be made');
    library.stop();
});

await done();
