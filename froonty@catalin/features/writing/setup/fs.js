// SPDX-License-Identifier: GPL-3.0-or-later
// File helpers for the Writing tab's own folders (docs/features/writing.md
// §5.1): private folders, atomic writes, and a delete that never leaves the
// folder it was given and never follows a link. Gio async only. No St or
// Gtk.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

for (const method of ['make_directory_async', 'delete_async', 'enumerate_children_async',
    'query_info_async', 'load_contents_async'])
    Gio._promisify(Gio.File.prototype, method);
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'set_attributes_async', 'set_attributes_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');

const PRIORITY = GLib.PRIORITY_DEFAULT;
const NOFOLLOW = Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS;

/** This process's user id. */
export function currentUid() {
    return new Gio.Credentials().get_unix_user();
}

async function makeDirectory(dir) {
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

async function setMode(file, mode) {
    const info = new Gio.FileInfo();
    info.set_attribute_uint32('unix::mode', mode);
    await file.set_attributes_async(info, NOFOLLOW, PRIORITY, null);
}

/**
 * Whether `path` is a real folder (not a link), owned by this user, and
 * readable by this user only (mode 0700).
 */
export async function isPrivateDir(path) {
    try {
        const info = await Gio.File.new_for_path(path).query_info_async(
            'standard::type,unix::uid,unix::mode', NOFOLLOW, PRIORITY, null);
        return info.get_file_type() === Gio.FileType.DIRECTORY &&
            info.get_attribute_uint32('unix::uid') === currentUid() &&
            (info.get_attribute_uint32('unix::mode') & 0o7777) === 0o700;
    } catch (e) {
        return false;
    }
}

/**
 * Creates `path` (and missing parents) and makes it 0700. A link or a
 * folder of someone else's at `path` is refused.
 *
 * @returns {Promise<string>} path
 */
export async function ensurePrivateDir(path) {
    const dir = Gio.File.new_for_path(path);
    await makeDirectory(dir);
    const info = await dir.query_info_async('standard::type,unix::uid', NOFOLLOW, PRIORITY, null);
    if (info.get_file_type() !== Gio.FileType.DIRECTORY ||
        info.get_attribute_uint32('unix::uid') !== currentUid())
        throw new Error(`${path} is not a folder of yours`);
    await setMode(dir, 0o700);
    return path;
}

/**
 * Writes `text` to `path` through a temporary file renamed into place.
 * The file gets `mode` (0600 unless said otherwise).
 */
export async function writeAtomic(path, text, mode = 0o600) {
    const file = Gio.File.new_for_path(path);
    await makeDirectory(file.get_parent());
    const flags = Gio.FileCreateFlags.REPLACE_DESTINATION |
        (mode === 0o600 ? Gio.FileCreateFlags.PRIVATE : Gio.FileCreateFlags.NONE);
    await file.replace_contents_bytes_async(new GLib.Bytes(new TextEncoder().encode(text)),
        null, false, flags, null);
    await setMode(file, mode);
}

/** A file's text, or null when it cannot be read. */
export async function readText(path, maxBytes = 1024 * 1024) {
    try {
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(null);
        if (bytes.length > maxBytes)
            return null;
        return new TextDecoder().decode(bytes);
    } catch (e) {
        return null;
    }
}

/** The file type at `path` without following a link, or null if none. */
export async function fileType(path) {
    try {
        const info = await Gio.File.new_for_path(path).query_info_async('standard::type',
            NOFOLLOW, PRIORITY, null);
        return info.get_file_type();
    } catch (e) {
        return null;
    }
}

export async function exists(path) {
    return await fileType(path) !== null;
}

/**
 * Whether `path` lies strictly inside `root`: absolute, no "." or ".."
 * segments, and not `root` itself.
 */
export function isInside(path, root) {
    if (!path || !root || !GLib.path_is_absolute(path) || !GLib.path_is_absolute(root))
        return false;
    const segments = p => p.split('/').filter(Boolean);
    const inner = segments(path);
    const outer = segments(root);
    if (inner.some(s => s === '..' || s === '.') || outer.some(s => s === '..' || s === '.'))
        return false;
    return inner.length > outer.length && outer.every((s, i) => inner[i] === s);
}

async function deleteChildren(dir) {
    const enumerator = await dir.enumerate_children_async('standard::name,standard::type',
        NOFOLLOW, PRIORITY, null);
    try {
        for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const infos = await enumerator.next_files_async(64, PRIORITY, null);
            if (!infos.length)
                break;
            for (const info of infos) {
                const child = dir.get_child(info.get_name());
                // A link is deleted itself, never followed.
                if (info.get_file_type() === Gio.FileType.DIRECTORY)
                    // eslint-disable-next-line no-await-in-loop
                    await deleteChildren(child);
                // eslint-disable-next-line no-await-in-loop
                await child.delete_async(PRIORITY, null);
            }
        }
    } finally {
        await enumerator.close_async(PRIORITY, null).catch(() => {});
    }
}

/**
 * Deletes `path` and everything in it. Refused unless `path` is strictly
 * inside `root` (isInside). Links inside are deleted, never followed; a
 * link at `path` itself is deleted as a link. A missing `path` is fine.
 *
 * @returns {Promise<boolean>} whether something was deleted
 */
export async function deleteTree(path, root) {
    if (!isInside(path, root))
        throw new Error(`Refusing to delete ${path}: not inside ${root}`);
    const type = await fileType(path);
    if (type === null)
        return false;
    const file = Gio.File.new_for_path(path);
    if (type === Gio.FileType.DIRECTORY)
        await deleteChildren(file);
    await file.delete_async(PRIORITY, null);
    return true;
}

/** Deletes one file (or link, or empty folder); a missing one is fine. */
export async function deleteFile(path) {
    try {
        await Gio.File.new_for_path(path).delete_async(PRIORITY, null);
        return true;
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return false;
        throw e;
    }
}
