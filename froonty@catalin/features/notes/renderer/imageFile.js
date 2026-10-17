// SPDX-License-Identifier: GPL-3.0-or-later
// The files behind a note's image references, for both the island (Shell)
// and All notes (GTK 4): where an image block's file is, showing it in the
// file manager, its bytes for "Copy original", and the Markdown path and
// name of a pasted image.
//
// Pure (unit-tested): imagePath, markdownImagePath, imageExtension,
// pastedImageName, copiedFilesText.
// Gio: imageFile, showInFileManager, readImage.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Gio.AppInfo, 'launch_default_for_uri_async');

const EXTENSIONS = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp'};

/**
 * The note-relative path of an image reference (a block's `source`), its
 * %XX escapes decoded as in a URL; null for a URL or absolute path, which
 * notes do not load.
 */
export function imagePath(source) {
    if (!source || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(source))
        return null;
    try {
        return decodeURIComponent(source);
    } catch {
        return source; // a lone % is the file's own name
    }
}

/** `name` as a path in `![…](…)`: what would end it or be decoded, escaped. */
export function markdownImagePath(name) {
    return name.replace(/[%\s()<>[\]]/g,
        c => `%${c.codePointAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/** The file extension for an image MIME type, null for another type. */
export function imageExtension(mime) {
    return EXTENSIONS[String(mime).toLowerCase()] ?? null;
}

/**
 * The file name of an image pasted at `date` (local time), the
 * `attempt`-th try (from 1) if earlier names were taken:
 * "pasted-2026-10-16-1405.png", "pasted-2026-10-16-1405-2.png".
 */
export function pastedImageName(date, mime, attempt = 1) {
    const extension = imageExtension(mime);
    if (!extension)
        throw new Error(`Cannot paste images of type ${mime}`);
    const two = n => String(n).padStart(2, '0');
    // No spaces: the Markdown reference reads as the file is named.
    const stamp = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}-` +
        `${two(date.getHours())}${two(date.getMinutes())}`;
    return `pasted-${stamp}${attempt > 1 ? `-${attempt}` : ''}.${extension}`;
}

/**
 * The clipboard text that pastes `uri` as a file in Files
 * (x-special/gnome-copied-files) and as a file list (text/uri-list).
 */
export function copiedFilesText(uri) {
    return {'x-special/gnome-copied-files': `copy\n${uri}`, 'text/uri-list': `${uri}\r\n`};
}

/** The file of an image block (`block.source`) in note folder `folder`; null if none. */
export function imageFile(block, folder) {
    const path = imagePath(block?.source);
    return path && folder ? folder.resolve_relative_path(path) : null;
}

/**
 * Shows `file` selected in the file manager (FileManager1.ShowItems), or
 * opens its folder when no file manager offers that. `context`: a
 * Gio.AppLaunchContext for that (the Shell's global.create_app_launch_context()).
 */
export async function showInFileManager(file, context = null) {
    try {
        await Gio.DBus.session.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
            'org.freedesktop.FileManager1', 'ShowItems', new GLib.Variant('(ass)', [[file.get_uri()], '']),
            null, Gio.DBusCallFlags.NONE, -1, null);
    } catch {
        await Gio.AppInfo.launch_default_for_uri_async(file.get_parent().get_uri(), context, null);
    }
}

/** The bytes (Uint8Array) and MIME type of an image file, read asynchronously. */
export async function readImage(file, cancellable = null) {
    const info = await file.query_info_async('standard::content-type', Gio.FileQueryInfoFlags.NONE,
        GLib.PRIORITY_DEFAULT, cancellable);
    const [bytes] = await file.load_contents_async(cancellable);
    return {bytes, mime: Gio.content_type_get_mime_type(info.get_content_type()) ?? 'application/octet-stream'};
}
