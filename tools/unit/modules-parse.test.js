// SPDX-License-Identifier: GPL-3.0-or-later
// Every module of the extension parses: a syntax error (a merge gone
// wrong, a stray line) fails here instead of as an "Extension Error"
// window in the Shell. Imports that only resolve inside the Shell or the
// settings process (resource:///…) are expected to fail to link here;
// only a SyntaxError counts. FROONTY_PARSE_ROOT names another copy (the
// public package, unzipped, in tools/pack-public/test_pack_public.py).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {test, eq, done} from './test.js';

const ROOT = GLib.getenv('FROONTY_PARSE_ROOT') ?? GLib.build_filenamev([
    GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), '..', '..', 'froonty@catalin']);

function modules(dir, out = []) {
    const children = dir.enumerate_children('standard::name,standard::type',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    for (let info; (info = children.next_file(null));) {
        const child = dir.get_child(info.get_name());
        if (info.get_file_type() === Gio.FileType.DIRECTORY)
            modules(child, out);
        else if (info.get_name().endsWith('.js'))
            out.push(child);
    }
    return out;
}

test('every module of the extension parses', async () => {
    const files = modules(Gio.File.new_for_path(ROOT));
    const errors = [];
    for (const file of files) {
        try {
            // eslint-disable-next-line no-await-in-loop
            await import(file.get_uri());
        } catch (e) {
            if (e instanceof SyntaxError)
                errors.push(`${file.get_path()}:${e.lineNumber}: ${e.message}`);
        }
    }
    eq(errors, [], `${files.length} modules`);
});

await done();
