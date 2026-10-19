// SPDX-License-Identifier: GPL-3.0-or-later
// Runs the native GTK image chooser outside GNOME Shell's Clutter process,
// copies the chosen image into the note folder and saves pasted ones there.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {pastedImageName} from './imageFile.js';

Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');
Gio._promisify(Gio.File.prototype, 'copy_async');
Gio._promisify(Gio.File.prototype, 'create_async');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.OutputStream.prototype, 'splice_async');

const HELPER = GLib.build_filenamev([
    GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), 'image-picker-helper.js']);

/**
 * Opens an image chooser and returns the picked file's path, or null.
 * Cancelling `cancellable` closes the chooser and rejects with
 * Gio.IOErrorEnum.CANCELLED.
 */
export async function chooseImage(cancellable = null) {
    let proc = null;
    for (const executable of ['/usr/bin/gjs', 'gjs']) {
        try {
            proc = Gio.Subprocess.new([executable, '-m', HELPER],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            break;
        } catch {}
    }
    if (!proc)
        throw new Error('Could not start the image chooser');
    const cancelId = cancellable?.connect(() => proc.force_exit()) ?? 0;
    try {
        const input = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
        const [line] = await input.read_line_async(GLib.PRIORITY_DEFAULT, cancellable);
        return line ? JSON.parse(new TextDecoder().decode(line)) : null;
    } finally {
        if (cancelId)
            cancellable.disconnect(cancelId);
    }
}

/** Copies the image at `path` into `folder` under a new name; returns it. */
export async function copyImage(path, folder, cancellable = null) {
    const source = Gio.File.new_for_path(path);
    const extension = /\.[a-zA-Z0-9]{1,8}$/.exec(source.get_basename())?.[0]?.toLowerCase() ?? '.img';
    for (;;) {
        const name = `image-${Date.now()}-${Math.floor(Math.random() * 10000)}${extension}`;
        try {
            // eslint-disable-next-line no-await-in-loop
            await source.copy_async(folder.get_child(name), Gio.FileCopyFlags.NONE,
                GLib.PRIORITY_DEFAULT, cancellable, null);
            return name;
        } catch (error) {
            if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                throw error;
        }
    }
}

/**
 * Writes pasted image bytes (Uint8Array or GLib.Bytes) of type `mime`
 * (image/png, image/jpeg, image/gif or image/webp) into `folder` as
 * "pasted-2026-10-16-1405.png" ("-2" and on when taken); returns the
 * file name. markdownImagePath() (imageFile.js) makes it a Markdown path.
 */
export async function saveImageBytes(bytes, mime, folder, cancellable = null) {
    const date = new Date();
    for (let attempt = 1; ; attempt++) {
        const name = pastedImageName(date, mime, attempt);
        const file = folder.get_child(name);
        let stream;
        try {
            // eslint-disable-next-line no-await-in-loop
            stream = await file.create_async(Gio.FileCreateFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
        } catch (error) {
            if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                continue;
            throw error;
        }
        const input = Gio.MemoryInputStream.new_from_bytes(
            bytes instanceof GLib.Bytes ? bytes : new GLib.Bytes(bytes));
        try {
            // eslint-disable-next-line no-await-in-loop
            await stream.splice_async(input, Gio.OutputStreamSpliceFlags.CLOSE_SOURCE |
                Gio.OutputStreamSpliceFlags.CLOSE_TARGET, GLib.PRIORITY_DEFAULT, cancellable);
        } catch (error) {
            // No half-written image is left behind.
            // eslint-disable-next-line no-await-in-loop
            await file.delete_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
            throw error;
        }
        return name;
    }
}
