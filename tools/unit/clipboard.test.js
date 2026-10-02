// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    addEntry, classify, copiedFilesText, excerpt, imageExtension, isFormatted, isIgnoredApp,
    looksLikePassword,
    parseFiles,
    trim, uriName, uriPath, validEntries,
} from '../../froonty@catalin/features/clipboard/entries.js';
import {ClipboardRecorder} from '../../froonty@catalin/features/clipboard/recorder.js';
import {ClipboardStore} from '../../froonty@catalin/features/clipboard/store.js';
import {done, eq, ok, test} from './test.js';

const TEXT = ['text/plain;charset=utf-8', 'UTF8_STRING'];
const IGNORED = ['keepass', '1password', 'world.secrets', 'authenticator'];

test('a copy marked secret by a password manager is a password', () => {
    eq(classify([...TEXT, 'x-kde-passwordManagerHint']), {action: 'password', reason: 'secret'});
    eq(classify([...TEXT, 'org.nspasteboard.ConcealedType']), {action: 'password', reason: 'secret'});
    // Without text there is nothing to show: not kept at all.
    eq(classify(['image/png', 'x-kde-passwordManagerHint']), {action: 'skip', reason: 'secret'});
});

test('text copied while a password manager has the focus is a password', () => {
    const from = names => classify(TEXT, {names, ignored: IGNORED});
    eq(from(['org.keepassxc.KeePassXC.desktop', 'keepassxc']).action, 'password');
    eq(from(['1password.desktop']).reason, 'ignored-app');
    eq(from(['org.gnome.World.Secrets.desktop']).action, 'password');
    eq(from(['com.belmoussaoui.Authenticator']).action, 'password');
    eq(from(['org.gnome.TextEditor.desktop', 'gnome-text-editor']), {action: 'text'});
    eq(isIgnoredApp(['Firefox'], ['', '  ']), false);
});

test('files win, then text, then images', () => {
    eq(classify(['x-special/gnome-copied-files', 'text/uri-list', ...TEXT]),
        {action: 'files', mime: 'x-special/gnome-copied-files'});
    eq(classify(['text/uri-list']), {action: 'files', mime: 'text/uri-list'});
    // A browser's link copy offers a URI list and text: it is text.
    eq(classify(['text/uri-list', ...TEXT]), {action: 'text'});
    // Office suites offer a picture of copied text, too.
    eq(classify(['image/png', ...TEXT]), {action: 'text'});
    eq(classify(['image/jpeg', 'image/png']), {action: 'image', mime: 'image/png'});
    eq(classify(['image/bmp']), {action: 'image', mime: 'image/bmp'});
    eq(classify(['application/x-thing']), {action: 'skip', reason: 'unsupported'});
    eq(classify([]), {action: 'skip', reason: 'empty'});
});

test('text that looks like a password', () => {
    for (const yes of ['Kx9vR2mQpL4wTz8', 'Summer2024!', 'ghp_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z', 'Kx9vR2mQ\n'])
        ok(looksLikePassword(yes), yes);
    for (const no of ['hunter2', 'correct horse battery', 'https://Example.com/A1', 'user@Mail1.com',
        '/home/a/B1.txt', 'src/Foo/Bar1.js', 'org.gnome.Shell', 'getUserName', 'HelloWorld2',
        '2026-10-01T16:42', 'a3f9c2e1d4b5a6c7', 'snake_case_1', 'CONST_VALUE_2', 'foo(bar)=1;',
        'abcdefgh', 'ABCD1234'])
        ok(!looksLikePassword(no), no);
});

test('formatted text is recognised by its extra formats', () => {
    ok(isFormatted([...TEXT, 'text/html']));
    ok(isFormatted([...TEXT, 'text/html;charset=utf-8']));
    ok(isFormatted([...TEXT, 'text/rtf']));
    ok(isFormatted([...TEXT, 'application/x-openoffice-embed-source-xml;windows_formatname="Star Embed Source (XML)"']));
    ok(!isFormatted(TEXT));
    ok(!isFormatted(['image/png']));
});

test('copied and cut files round-trip', () => {
    const cut = parseFiles('cut\nfile:///home/a/Doc%201.pdf\nfile:///home/a/pics\n');
    eq(cut, {operation: 'cut', uris: ['file:///home/a/Doc%201.pdf', 'file:///home/a/pics']});
    eq(parseFiles(copiedFilesText({operation: 'copy', uris: cut.uris})),
        {operation: 'copy', uris: cut.uris});
    eq(parseFiles('# comment\r\nfile:///x\r\n', 'text/uri-list'),
        {operation: 'copy', uris: ['file:///x']});
    eq(parseFiles('move\nfile:///x'), null);
    eq(parseFiles('copy\n'), null);
    eq(uriName('file:///home/a/Doc%201.pdf'), 'Doc 1.pdf');
    eq(uriName('file:///home/a/pics/'), 'pics');
    eq(uriPath('file:///home/a/Doc%201.pdf'), '/home/a/Doc 1.pdf');
    eq(uriPath('sftp://host/x'), 'sftp://host/x');
});

test('a repeated copy moves its entry to the top; the oldest go past the limit', () => {
    const e = (id, hash) => ({id, hash, time: 1});
    const entries = [e('a', 'h1'), e('b', 'h2'), e('c', 'h3')];
    const again = addEntry(entries, {...e('new', 'h2'), time: 9}, 3);
    eq(again.entries.map(x => x.id), ['b', 'a', 'c']);
    eq(again.top.time, 9);
    const fresh = addEntry(entries, e('d', 'h4'), 3);
    eq(fresh.entries.map(x => x.id), ['d', 'a', 'b']);
    eq(fresh.dropped.map(x => x.id), ['c']);
    eq(trim(entries, 1).dropped.length, 2);
});

test('a damaged history keeps only well-formed entries', () => {
    eq(validEntries(null), []);
    eq(validEntries({entries: [
        {id: 'a-1', hash: 'h', time: 1, kind: 'text', text: 'hi'},
        {id: '../x', hash: 'h', time: 1, kind: 'text', text: 'hi'},
        {id: 'b-1', hash: 'h', time: 1, kind: 'image', mime: 'image/png', file: '../../etc/x'},
        {id: 'c-1', hash: 'h', time: 1, kind: 'files', operation: 'move', uris: []},
    ]}).map(x => x.id), ['a-1']);
});

test('previews', () => {
    eq(excerpt('\n\n one\ntwo\nthree\nfour', 3, 80), ' one\ntwo\nthree\n…');
    eq(excerpt('abcdef', 3, 4), 'abc…');
    eq(imageExtension('image/png'), 'png');
    eq(imageExtension('image/svg+xml'), 'svg');
});

function tempFolder() {
    return Gio.File.new_for_path(GLib.build_filenamev(
        [GLib.dir_make_tmp('froonty-clipboard-XXXXXX'), 'clipboard']));
}

function mode(file) {
    return file.query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null)
        .get_attribute_uint32('unix::mode') & 0o777;
}

test('the history is on disk, readable by the user only', async () => {
    const store = new ClipboardStore(tempFolder());
    const entries = [{id: 'a-1', hash: 'h', time: 1, kind: 'text', text: 'hello'}];
    await store.save(entries);
    await store.writeImage('b-1.png', new GLib.Bytes(new Uint8Array([1, 2, 3])));
    eq(await store.load(), entries);
    eq(mode(store.folder).toString(8), '700');
    eq(mode(store.folder.get_child('history.json')).toString(8), '600');
    eq(mode(store.imageFile('b-1.png')).toString(8), '600');
    eq((await store.readImage('b-1.png')).get_size(), 3);
    await store.clear();
    eq(await store.load(), []);
    ok(!store.imageFile('b-1.png').query_exists(null), 'images are deleted');
});

// A clipboard and selection as St.Clipboard and Meta.Selection behave: a
// write replaces what is offered and announces a copy.
function fakeClipboard() {
    const listeners = new Map();
    let next = 1;
    const state = {offer: new Map(), focus: []};
    const announce = (cleared = false) => [...listeners.values()].forEach(fn => fn(cleared));
    return {
        state,
        copy(offer, focus = []) {
            state.offer = new Map(Object.entries(offer));
            state.focus = focus;
            announce();
        },
        // A password manager clearing the clipboard.
        empty() {
            state.offer = new Map();
            announce(true);
        },
        clipboard: {
            mimetypes: () => [...state.offer.keys()],
            text: async () => state.offer.get('text/plain;charset=utf-8') ?? null,
            content: async mime => {
                const value = state.offer.get(mime);
                return value === undefined ? null
                    : new GLib.Bytes(typeof value === 'string' ? new TextEncoder().encode(value) : value);
            },
            setText: text => {
                state.offer = new Map([['text/plain;charset=utf-8', text]]);
                announce();
            },
            setContent: (mime, bytes) => {
                state.offer = new Map([[mime, bytes.toArray()]]);
                announce();
            },
        },
        selection: {
            connect: fn => {
                listeners.set(next, fn);
                return next++;
            },
            disconnect: id => listeners.delete(id),
        },
        focusedApp: () => state.focus,
    };
}

function fakeSettings(values = {}) {
    const all = {
        'clipboard-history-size': 3, 'clipboard-ignored-apps': IGNORED,
        'clipboard-password-minutes': 5, 'clipboard-detect-passwords': true, ...values,
    };
    const handlers = new Map();
    let next = 1;
    return {
        get_int: key => all[key],
        get_strv: key => all[key],
        get_boolean: key => all[key],
        set_int: (key, value) => {
            all[key] = value;
            for (const {signal, fn} of handlers.values()) {
                if (signal === `changed::${key}`)
                    fn();
            }
        },
        connect: (signal, fn) => {
            handlers.set(next, {signal, fn});
            return next++;
        },
        disconnect: id => handlers.delete(id),
        handlers,
    };
}

// Lets the recorder's promise chains (reads, writes) finish.
const settle = () => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

// A timer the test fires by hand.
function fakeTimer() {
    const timers = new Map();
    let next = 1;
    return {
        timers,
        add: (ms, callback) => {
            timers.set(next, {ms, callback});
            return next++;
        },
        remove: id => timers.delete(id),
        fire() {
            for (const [id, {callback}] of [...timers]) {
                timers.delete(id);
                callback();
            }
        },
    };
}

async function recorderWith(settings = fakeSettings()) {
    const fake = fakeClipboard();
    const store = new ClipboardStore(tempFolder());
    const timer = fakeTimer();
    const clock = {time: 1000};
    const recorder = new ClipboardRecorder({
        settings, store, ...fake, timer, now: () => clock.time++,
    });
    await recorder.start();
    return {recorder, fake, store, settings, timer, clock};
}

const onDisk = async store => JSON.stringify(await store.load()) +
    (store.folder.get_child('history.json').query_exists(null)
        ? new TextDecoder().decode(store.folder.get_child('history.json').load_contents(null)[1]) : '');

const PLAIN = 'text/plain;charset=utf-8';

test('copies are recorded, newest first, and saved', async () => {
    const {recorder, fake, store} = await recorderWith();
    fake.copy({[PLAIN]: 'first'});
    await settle();
    fake.copy({'x-special/gnome-copied-files': 'cut\nfile:///home/a/x.txt'});
    await settle();
    fake.copy({'image/png': new Uint8Array([137, 80, 78, 71])});
    await settle();
    eq(recorder.entries.map(e => e.kind), ['image', 'files', 'text']);
    eq(recorder.currentId, recorder.entries[0].id);
    eq(recorder.entries[1].operation, 'cut');
    eq((await store.load()).length, 3);
    ok(store.imageFile(recorder.entries[0].file).query_exists(null), 'the image is on disk');
    recorder.destroy();
});

test('a password is shown hidden, never saved; only the latest one', async () => {
    const {recorder, fake, store, timer} = await recorderWith();
    fake.copy({[PLAIN]: 'kept'});
    await settle();
    fake.copy({[PLAIN]: 'hunter2', 'x-kde-passwordManagerHint': 'secret'});
    await settle();
    eq(recorder.password?.text, 'hunter2');
    eq(recorder.password.reason, 'secret');
    eq(recorder.currentId, recorder.password.id);
    eq(recorder.shown.map(e => e.kind), ['password', 'text']);
    eq(timer.timers.size, 1);
    ok(Math.abs([...timer.timers.values()][0].ms - 5 * 60 * 1000) < 1000, 'expires in 5 minutes');

    fake.copy({[PLAIN]: 's3cret'}, ['org.keepassxc.KeePassXC.desktop']);
    await settle();
    eq(recorder.password.text, 's3cret');
    eq(recorder.password.reason, 'ignored-app');
    eq(timer.timers.size, 1, 'one expiry timer, for the latest password');

    eq(recorder.entries.map(e => e.text), ['kept']);
    const saved = await onDisk(store);
    ok(!saved.includes('hunter2') && !saved.includes('s3cret'), 'no password on disk');
    recorder.destroy();
    eq(timer.timers.size, 0, 'destroy removes the timer');
});

test('a hidden password goes when its minutes pass', async () => {
    const {recorder, fake, timer} = await recorderWith();
    fake.copy({[PLAIN]: 'Kx9vR2mQpL4wTz8'});
    await settle();
    eq(recorder.password?.reason, 'looks');
    timer.fire();
    eq(recorder.password, null);
    eq(recorder.currentId, null);
    eq(recorder.shown, []);
    recorder.destroy();
});

test('a hidden password goes when the clipboard is cleared or something else is copied', async () => {
    const {recorder, fake, timer} = await recorderWith();
    fake.copy({[PLAIN]: 'Kx9vR2mQpL4wTz8'});
    await settle();
    fake.empty();
    eq(recorder.password, null);
    eq(timer.timers.size, 0);

    fake.copy({[PLAIN]: 'Kx9vR2mQpL4wTz8'});
    await settle();
    fake.copy({[PLAIN]: 'ordinary words'});
    await settle();
    eq(recorder.password, null);
    eq(recorder.shown.map(e => e.text), ['ordinary words']);
    recorder.destroy();
});

test('copying a hidden password again keeps it hidden and unsaved', async () => {
    const {recorder, fake, store, timer} = await recorderWith();
    fake.copy({[PLAIN]: 'pw-from-manager', 'x-kde-passwordManagerHint': 'secret'});
    await settle();
    const {id, expiresAt} = recorder.password;
    fake.copy({[PLAIN]: 'other'});
    await settle();
    eq(recorder.password, null, 'replaced');

    fake.copy({[PLAIN]: 'pw-from-manager', 'x-kde-passwordManagerHint': 'secret'});
    await settle();
    const again = recorder.password;
    fake.state.focus = ['org.keepassxc.KeePassXC.desktop'];
    await recorder.copy(again.id);
    await settle();
    eq(fake.state.offer.get(PLAIN), 'pw-from-manager');
    eq(recorder.password?.id, again.id, 'the same hidden entry');
    eq(recorder.currentId, again.id);
    eq(timer.timers.size, 1);
    ok(!(await onDisk(store)).includes('pw-from-manager'));
    ok(id !== again.id && expiresAt > 0);
    recorder.destroy();
});

test('with 0 minutes, passwords are not listed at all', async () => {
    const {recorder, fake, timer} = await recorderWith(fakeSettings({'clipboard-password-minutes': 0}));
    fake.copy({[PLAIN]: 'kept'});
    await settle();
    fake.copy({[PLAIN]: 'hunter2', 'x-kde-passwordManagerHint': 'secret'});
    await settle();
    eq(recorder.password, null);
    eq(recorder.currentId, null);
    eq(recorder.lastSkip, 'secret');
    eq(recorder.shown.map(e => e.text), ['kept']);
    eq(timer.timers.size, 0);
    recorder.destroy();
});

test('changing the minutes moves the expiry; 0 drops the password', async () => {
    const settings = fakeSettings();
    const {recorder, fake, timer} = await recorderWith(settings);
    fake.copy({[PLAIN]: 'Kx9vR2mQpL4wTz8'});
    await settle();
    settings.set_int('clipboard-password-minutes', 10);
    ok([...timer.timers.values()][0].ms > 9 * 60 * 1000, 'rescheduled');
    settings.set_int('clipboard-password-minutes', 0);
    eq(recorder.password, null);
    eq(timer.timers.size, 0);
    recorder.destroy();
});

test('without recognition, password-like text is ordinary history', async () => {
    const {recorder, fake} = await recorderWith(fakeSettings({'clipboard-detect-passwords': false}));
    fake.copy({[PLAIN]: 'Kx9vR2mQpL4wTz8'});
    await settle();
    eq(recorder.password, null);
    eq(recorder.entries.map(e => e.text), ['Kx9vR2mQpL4wTz8']);
    // Picking it from the history keeps it history, also with recognition on.
    recorder._settings.get_boolean = () => true;
    await recorder.copy(recorder.entries[0].id);
    await settle();
    eq(recorder.password, null);
    eq(recorder.currentId, recorder.entries[0].id);
    recorder.destroy();
});

test('picking an entry copies it back, also with a password manager focused', async () => {
    const {recorder, fake} = await recorderWith();
    fake.copy({[PLAIN]: 'one'});
    await settle();
    fake.copy({'x-special/gnome-copied-files': 'copy\nfile:///home/a/y'});
    await settle();
    fake.state.focus = ['org.keepassxc.KeePassXC.desktop'];
    const one = recorder.entries.find(e => e.text === 'one');
    await recorder.copy(one.id);
    await settle();
    eq(fake.state.offer.get(PLAIN), 'one');
    eq(recorder.entries.map(e => e.id)[0], one.id, 'moved to the top, same entry');
    eq(recorder.entries.length, 2);
    eq(recorder.currentId, one.id);

    const files = recorder.entries.find(e => e.kind === 'files');
    await recorder.copy(files.id);
    await settle();
    eq(new TextDecoder().decode(fake.state.offer.get('x-special/gnome-copied-files')),
        'copy\nfile:///home/a/y');
    eq(recorder.currentId, files.id);
    recorder.destroy();
});

test('the limit drops the oldest entries and their images', async () => {
    const settings = fakeSettings();
    const {recorder, fake, store} = await recorderWith(settings);
    fake.copy({'image/png': new Uint8Array([1])});
    await settle();
    const image = recorder.entries[0];
    for (const text of ['a', 'b', 'c']) {
        fake.copy({[PLAIN]: text});
        // eslint-disable-next-line no-await-in-loop
        await settle();
    }
    eq(recorder.entries.map(e => e.text), ['c', 'b', 'a']);
    ok(!store.imageFile(image.file).query_exists(null), 'the dropped image is deleted');
    settings.set_int('clipboard-history-size', 1);
    await settle();
    eq(recorder.entries.map(e => e.text), ['c']);
    recorder.destroy();
    eq(settings.handlers.size, 0);
});

test('paste as plain text keeps only the text of a formatted copy', async () => {
    const {recorder, fake} = await recorderWith();
    fake.copy({[PLAIN]: 'Hello world', 'text/html': '<b>Hello</b> world'});
    await settle();
    eq(recorder.currentFormatted, true);
    eq(recorder.entries.map(e => e.text), ['Hello world']);
    ok(recorder.copyAsPlainText());
    await settle();
    eq([...fake.state.offer.keys()], [PLAIN]);
    eq(fake.state.offer.get(PLAIN), 'Hello world');
    eq(recorder.currentFormatted, false);
    eq(recorder.entries.length, 1, 'the same entry, not a new one');
    eq(recorder.currentId, recorder.entries[0].id);
    ok(!recorder.copyAsPlainText(), 'nothing to do for plain text');

    fake.copy({[PLAIN]: 'plain only'});
    await settle();
    eq(recorder.currentFormatted, false);
    fake.copy({[PLAIN]: 'again', 'text/html': '<i>again</i>'});
    await settle();
    fake.empty();
    eq(recorder.currentFormatted, false, 'cleared');
    recorder.destroy();
});

test('remove and clear', async () => {
    const {recorder, fake, store} = await recorderWith();
    fake.copy({[PLAIN]: 'a'});
    await settle();
    fake.copy({[PLAIN]: 'b'});
    await settle();
    await recorder.remove(recorder.entries[0].id);
    eq(recorder.entries.map(e => e.text), ['a']);
    eq(recorder.currentId, null);
    await recorder.clear();
    eq(recorder.entries, []);
    eq(await store.load(), []);
    recorder.destroy();
});

test('empty and huge copies are not kept', async () => {
    const {recorder, fake} = await recorderWith();
    fake.copy({[PLAIN]: '   '});
    await settle();
    fake.copy({[PLAIN]: 'x'.repeat(1024 * 1024 + 1)});
    await settle();
    eq(recorder.entries, []);
    eq(recorder.lastSkip, 'too-large');
    recorder.destroy();
});

await done();
