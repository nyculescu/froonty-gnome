// SPDX-License-Identifier: GPL-3.0-or-later
// Runs the native GTK image chooser outside GNOME Shell's Clutter process.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');

const HELPER = GLib.build_filenamev([
    GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), 'image-picker-helper.js']);

/** Opens an image chooser, copies the picked file into `folder`, and returns its local name. */
export async function chooseImage(folder) {
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

    const input = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
    const [line] = await input.read_line_async(GLib.PRIORITY_DEFAULT, null);
    if (!line)
        return null;
    const path = JSON.parse(new TextDecoder().decode(line));
    if (!path)
        return null;

    if (!folder.query_exists(null))
        folder.make_directory_with_parents(null);
    const source = Gio.File.new_for_path(path);
    const extension = /\.[a-zA-Z0-9]{1,8}$/.exec(source.get_basename())?.[0]?.toLowerCase() ?? '.img';
    let name;
    let destination;
    do {
        name = `image-${Date.now()}-${Math.floor(Math.random() * 10000)}${extension}`;
        destination = folder.get_child(name);
    } while (destination.query_exists(null));
    source.copy(destination, Gio.FileCopyFlags.NONE, null, null);
    return name;
}
