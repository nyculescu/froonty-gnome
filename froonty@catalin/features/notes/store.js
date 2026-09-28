// SPDX-License-Identifier: GPL-3.0-or-later
// Notes on disk: one Markdown file per note in a folder. Gio async only,
// never blocking the compositor. No St; unit-tested with plain gjs.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Names from './names.js';

for (const method of ['make_directory_async', 'enumerate_children_async',
    'load_contents_async', 'create_async', 'set_display_name_async',
    'trash_async', 'query_info_async'])
    Gio._promisify(Gio.File.prototype, method);
// Its finish function is not named after it.
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async',
    'replace_contents_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');
Gio._promisify(Gio.OutputStream.prototype, 'close_async');

const PRIORITY = GLib.PRIORITY_DEFAULT;
const ENUMERATE_BATCH = 64;

export class NotesStore {
    /** @param {Gio.File} folder */
    constructor(folder) {
        this.folder = folder;
    }

    /** Creates the folder and missing parents. */
    async ensureFolder(cancellable = null) {
        await makeDirectoryWithParents(this.folder, cancellable);
    }

    /** @returns {Promise<string[]>} note names, sorted */
    async list(cancellable = null) {
        const enumerator = await this.folder.enumerate_children_async(
            'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE,
            PRIORITY, cancellable);
        const names = [];
        for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const infos = await enumerator.next_files_async(ENUMERATE_BATCH,
                PRIORITY, cancellable);
            if (infos.length === 0)
                break;
            for (const info of infos) {
                const name = Names.noteName(info.get_name());
                if (name && info.get_file_type() === Gio.FileType.REGULAR)
                    names.push(name);
            }
        }
        await enumerator.close_async(PRIORITY, null);
        return names.sort(Names.compareNames);
    }

    async read(name, cancellable = null) {
        const [bytes] = await this._file(name).load_contents_async(cancellable);
        return new TextDecoder().decode(bytes);
    }

    // g_file_replace writes a temporary file and renames it over the note,
    // so a crash never leaves half a note behind.
    async write(name, text) {
        const bytes = new GLib.Bytes(new TextEncoder().encode(text));
        await this._file(name).replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.NONE, null);
    }

    /** Creates an empty note; fails if it already exists. */
    async create(name) {
        const stream = await this._file(name).create_async(Gio.FileCreateFlags.NONE,
            PRIORITY, null);
        await stream.close_async(PRIORITY, null);
    }

    /** Renames a note; refuses to overwrite another one. */
    async rename(from, to) {
        // rename(2) silently replaces an existing target; check first.
        // (A different case of the same name is allowed: "plan" → "Plan".)
        if (from.toLowerCase() !== to.toLowerCase() && await this._exists(to)) {
            throw new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS,
                `A note named "${to}" already exists`);
        }
        await this._file(from).set_display_name_async(Names.fileName(to), PRIORITY, null);
    }

    /** Moves a note to the Trash (recoverable), not a hard delete. */
    async trash(name) {
        await this._file(name).trash_async(PRIORITY, null);
    }

    /**
     * Watches the folder (inotify; no polling). `callback` runs on any
     * change, including our own writes.
     *
     * @returns {Gio.FileMonitor} call cancel() to stop
     */
    monitor(callback) {
        const monitor = this.folder.monitor_directory(
            Gio.FileMonitorFlags.WATCH_MOVES, null);
        monitor.connect('changed', () => callback());
        return monitor;
    }

    async _exists(name) {
        try {
            await this._file(name).query_info_async('standard::type',
                Gio.FileQueryInfoFlags.NONE, PRIORITY, null);
            return true;
        } catch (e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                return false;
            throw e;
        }
    }

    _file(name) {
        return this.folder.get_child(Names.fileName(name));
    }
}

// Gio has no async make_directory_with_parents.
async function makeDirectoryWithParents(dir, cancellable) {
    try {
        await dir.make_directory_async(PRIORITY, cancellable);
    } catch (e) {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            return;
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) || !dir.get_parent())
            throw e;
        await makeDirectoryWithParents(dir.get_parent(), cancellable);
        await dir.make_directory_async(PRIORITY, cancellable);
    }
}
