// SPDX-License-Identifier: GPL-3.0-or-later
// Private files for feature stores: written atomically and readable by the
// user only. Gio async only, never blocking the compositor; no St, so it
// loads in plain gjs unit tests. (The same helpers as clipboard/store.js,
// which keeps its own copy for now.)

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'make_directory_async');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'set_attributes_async', 'set_attributes_finish');

const PRIORITY = GLib.PRIORITY_DEFAULT;

// g_file_replace writes a temporary file and renames it into place, so a
// crash never leaves half a file; PRIVATE makes it 0600.
export async function writePrivate(file, data) {
    const bytes = data instanceof GLib.Bytes ? data : new GLib.Bytes(data);
    await file.replace_contents_bytes_async(bytes, null, false,
        Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}

/** Makes `dir` and its missing parents; an existing one is fine. */
export async function makeDirectory(dir) {
    try {
        await dir.make_directory_async(PRIORITY, null);
    } catch (e) {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            return;
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) || !dir.get_parent())
            throw e;
        await makeDirectory(dir.get_parent());
        await dir.make_directory_async(PRIORITY, null);
    }
}

/** Makes `dir` (and parents) readable by the user only: 0700. */
export async function makePrivateDirectory(dir) {
    await makeDirectory(dir);
    const info = new Gio.FileInfo();
    info.set_attribute_uint32('unix::mode', 0o700);
    await dir.set_attributes_async(info, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, PRIORITY, null);
}

export async function deleteQuietly(file) {
    try {
        await file.delete_async(PRIORITY, null);
    } catch (e) {
        // Already gone.
    }
}

/** The file's text, or null when it is missing or unreadable. */
export async function readText(file) {
    try {
        const [bytes] = await file.load_contents_async(null);
        return new TextDecoder().decode(bytes);
    } catch (e) {
        return null;
    }
}
