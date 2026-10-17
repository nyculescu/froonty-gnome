// SPDX-License-Identifier: GPL-3.0-or-later
// Clipboard history on disk (docs/features/clipboard.md), so it survives
// screen locks (which disable extensions) and logins:
//
//   ~/.local/share/froonty/clipboard/          mode 0700
//   ├── history.json                           mode 0600, newest first
//   └── images/<id>.<ext>                      mode 0600
//
// Gio async only, never blocking the compositor. No St; unit-tested with
// plain gjs.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {deleteQuietly, makeDirectory, makePrivateDirectory, writePrivate} from '../../core/privateFile.js';
import {validEntries} from './entries.js';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');

const PRIORITY = GLib.PRIORITY_DEFAULT;
const HISTORY = 'history.json';
const IMAGES = 'images';
const FORMAT = 1;

/** The default folder: $XDG_DATA_HOME/froonty/clipboard. */
export function defaultFolder() {
    return Gio.File.new_for_path(GLib.build_filenamev(
        [GLib.get_user_data_dir(), 'froonty', 'clipboard']));
}

export class ClipboardStore {
    /** @param {Gio.File} folder */
    constructor(folder) {
        this.folder = folder;
        // Writes run one after another, so an older history never lands
        // after a newer one.
        this._queue = Promise.resolve();
    }

    /** The history, newest first; [] when there is none or it is unreadable. */
    async load() {
        try {
            const [bytes] = await this.folder.get_child(HISTORY).load_contents_async(null);
            return validEntries(JSON.parse(new TextDecoder().decode(bytes)));
        } catch (e) {
            return [];
        }
    }

    save(entries) {
        const text = JSON.stringify({format: FORMAT, entries});
        return this._enqueue(async () => {
            await makePrivateDirectory(this.folder);
            await writePrivate(this.folder.get_child(HISTORY), new TextEncoder().encode(text));
        });
    }

    /** The file holding image `name` (for previews). */
    imageFile(name) {
        return this.folder.get_child(IMAGES).get_child(name);
    }

    writeImage(name, bytes) {
        return this._enqueue(async () => {
            await makePrivateDirectory(this.folder);
            await makeDirectory(this.folder.get_child(IMAGES));
            await writePrivate(this.imageFile(name), bytes);
        });
    }

    /** @returns {Promise<GLib.Bytes>} */
    async readImage(name) {
        const [bytes] = await this.imageFile(name).load_contents_async(null);
        return new GLib.Bytes(bytes);
    }

    /** Deletes the image files of `entries`; missing ones are fine. */
    removeImagesOf(entries) {
        const names = entries.filter(e => e.kind === 'image').map(e => e.file);
        if (!names.length)
            return this._queue;
        return this._enqueue(() => Promise.all(names.map(name => deleteQuietly(this.imageFile(name)))));
    }

    /** Deletes the history and every image, including ones it no longer lists. */
    clear() {
        return this._enqueue(async () => {
            const images = this.folder.get_child(IMAGES);
            for (const name of await listNames(images))
                // eslint-disable-next-line no-await-in-loop
                await deleteQuietly(images.get_child(name));
            await deleteQuietly(images);
            await deleteQuietly(this.folder.get_child(HISTORY));
        });
    }

    _enqueue(task) {
        const run = this._queue.then(task);
        this._queue = run.catch(() => {});
        return run;
    }
}

async function listNames(dir) {
    try {
        const enumerator = await dir.enumerate_children_async('standard::name',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, PRIORITY, null);
        const names = [];
        for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const infos = await enumerator.next_files_async(64, PRIORITY, null);
            if (!infos.length)
                break;
            names.push(...infos.map(info => info.get_name()));
        }
        await enumerator.close_async(PRIORITY, null);
        return names;
    } catch (e) {
        return [];
    }
}
