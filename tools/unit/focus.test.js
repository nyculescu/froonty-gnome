// SPDX-License-Identifier: GPL-3.0-or-later
// Focus's mode file (features/focus/mode.js): what llano's noise.py reads.
//
// Run: gjs -m tools/unit/focus.test.js

import GLib from 'gi://GLib';

import {MODES, modePath, parseMode, readMode, writeMode} from '../../froonty@catalin/features/focus/mode.js';
import {done, eq, ok, test} from './test.js';

const tmp = GLib.dir_make_tmp('froonty-focus-XXXXXX');
const file = name => GLib.build_filenamev([tmp, name, 'focus', 'mode.json']);

test('modes: Working, Sleeping, Away, Auto, in menu order', () => {
    eq(MODES, ['working', 'sleeping', 'away', 'auto']);
});

test('the file is in the user state folder, as noise.py looks for it', () => {
    eq(modePath(), GLib.build_filenamev([GLib.get_user_state_dir(), 'focus', 'mode.json']));
});

test('write then read each mode; the folder is made; since and by are written', () => {
    for (const mode of MODES) {
        const path = file(`w-${mode}`);
        writeMode(mode, path, 1791650000.4);
        eq(readMode(path), mode);
        const [, bytes] = GLib.file_get_contents(path);
        eq(JSON.parse(new TextDecoder().decode(bytes)), {mode, since: 1791650000, by: 'Froonty'});
    }
});

test('no file, or a file that is not a mode, is Auto', () => {
    eq(readMode(file('missing')), 'auto');
    for (const text of ['', 'not json', '[1]', 'null', '{"mode": "bogus"}', '{"mode": 3}', '{}'])
        eq(parseMode(text), 'auto', text);
});

test('an unknown mode is refused and nothing is written', () => {
    const path = file('refused');
    let threw = false;
    try {
        writeMode('holiday', path);
    } catch {
        threw = true;
    }
    ok(threw, 'threw');
    ok(!GLib.file_test(path, GLib.FileTest.EXISTS), 'no file');
});

await done();
