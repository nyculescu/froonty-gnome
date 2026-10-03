// SPDX-License-Identifier: GPL-3.0-or-later
// Notes on disk: one Markdown file per note in a folder. Gio async only,
// never blocking the compositor. No St, no GTK: used by the island and by
// the settings window's "All notes" page; unit-tested with plain gjs.
//
// Writes can be checked against an entity tag (etag), the file's
// modification time as Gio reports it. A write that names the etag it last
// saw fails with WRONG_ETAG when the file changed since (noteWriter.js then
// keeps both versions).
//
// A note that is not plain UTF-8 text (another encoding, or NUL bytes, as
// in a UTF-16 file) is read for display only, `readOnly`: the editors
// would turn its bytes into U+FFFD or cut it at the first NUL, and saving
// that would damage it for good.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Labels from './labels.js';
import * as Meta from './meta.js';
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
// Attempts at a free name for a conflict copy, and at a labels update
// that other writers keep overtaking.
const COPY_ATTEMPTS = 10;
const LABELS_ATTEMPTS = 3;

const encode = text => new GLib.Bytes(new TextEncoder().encode(text));
const isError = (e, code) => e?.matches?.(Gio.IOErrorEnum, code) ?? false;

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
        const notes = await this._enumerate('standard::name,standard::type', cancellable);
        return notes.map(({name}) => name);
    }

    /**
     * @returns {Promise<{name: string, etag: ?string, modified: number}[]>}
     *   notes sorted by name; `modified` in milliseconds since the epoch
     */
    listInfo(cancellable = null) {
        return this._enumerate('standard::name,standard::type,etag::value,' +
            'time::modified,time::modified-usec', cancellable);
    }

    async _enumerate(attributes, cancellable) {
        const enumerator = await this.folder.enumerate_children_async(
            attributes, Gio.FileQueryInfoFlags.NONE, PRIORITY, cancellable);
        const notes = [];
        for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const infos = await enumerator.next_files_async(ENUMERATE_BATCH,
                PRIORITY, cancellable);
            if (infos.length === 0)
                break;
            for (const info of infos) {
                const name = Names.noteName(info.get_name());
                if (!name || info.get_file_type() !== Gio.FileType.REGULAR)
                    continue;
                // Only what was asked for: Gio warns about the rest.
                const time = info.has_attribute('time::modified')
                    ? info.get_modification_date_time() : null;
                notes.push({
                    name,
                    etag: info.has_attribute('etag::value') ? info.get_etag() || null : null,
                    modified: time
                        ? time.to_unix() * 1000 + Math.floor(time.get_microsecond() / 1000)
                        : 0,
                });
            }
        }
        await enumerator.close_async(PRIORITY, null);
        return notes.sort((a, b) => Names.compareNames(a.name, b.name));
    }

    async read(name, cancellable = null) {
        return (await this.readTagged(name, cancellable)).text;
    }

    /**
     * @returns {Promise<{text: string, etag: ?string, readOnly: ?string}>}
     *   `readOnly` ('not-utf8' or 'nul') for a note that must not be
     *   written back; its `text` is then for display (see decodeNote)
     */
    async readTagged(name, cancellable = null) {
        const [bytes, etag] = await this._file(name).load_contents_async(cancellable);
        return {...decodeNote(bytes), etag: etag || null};
    }

    /**
     * Writes a note. g_file_replace writes a temporary file and renames it
     * over the note, so a crash never leaves half a note behind.
     *
     * @param {string} name
     * @param {string} text
     * @param {?string} etag fail with WRONG_ETAG unless the note is still
     *   at this version; null writes unchecked (as where a folder has no
     *   etags)
     * @returns {Promise<?string>} the note's new etag
     */
    async write(name, text, etag = null) {
        const [newEtag] = await this._file(name).replace_contents_bytes_async(
            encode(text), etag, false, Gio.FileCreateFlags.NONE, null);
        return newEtag || null;
    }

    /** The etag of a note as it is on disk now. */
    async etagOf(name) {
        const info = await this._file(name).query_info_async('etag::value',
            Gio.FileQueryInfoFlags.NONE, PRIORITY, null);
        return info.get_etag() || null;
    }

    /**
     * Creates an empty note; fails if it already exists.
     *
     * @returns {Promise<?string>} its etag
     */
    create(name) {
        return createEmpty(this._file(name));
    }

    /**
     * Keeps `text` as a new note next to `name`: "<name> (conflict)", or
     * "<name> (conflict) (2)" and so on. Never overwrites anything. The
     * copy starts without labels, whatever an earlier note of its name had
     * (shared by the island and the window).
     *
     * @returns {Promise<{name: string, etag: ?string}>}
     */
    async saveCopy(name, text) {
        for (let attempt = 0; attempt < COPY_ATTEMPTS; attempt++) {
            // eslint-disable-next-line no-await-in-loop
            const copy = Names.uniqueName(`${name} (conflict)`, await this.list());
            let etag;
            try {
                // eslint-disable-next-line no-await-in-loop
                etag = await this.create(copy);
            } catch (e) {
                if (isError(e, Gio.IOErrorEnum.EXISTS))
                    continue; // taken meanwhile: try the next name
                throw e;
            }
            // eslint-disable-next-line no-await-in-loop
            etag = await this.write(copy, text, etag);
            try {
                // eslint-disable-next-line no-await-in-loop
                await this.forgetLabels(copy);
            } catch {
                // The text is safe; a labels file that cannot be read or
                // written keeps its entries (it is never repaired).
            }
            return {name: copy, etag};
        }
        throw new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS,
            `No free name for a copy of "${name}"`);
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

    /**
     * Order and colours (meta.js). 'unreadable' when the file cannot be
     * read or understood: then it must not be written (the defaults in
     * `meta` are for display only).
     *
     * @returns {Promise<{state: 'ok'|'missing'|'unreadable', meta: object,
     *   error: ?string}>}
     */
    async readMeta(cancellable = null) {
        const unreadableMeta = error => ({state: 'unreadable', meta: Meta.emptyMeta(), error});
        let bytes;
        try {
            [bytes] = await this.folder.get_child(Meta.META_FILE)
                .load_contents_async(cancellable);
        } catch (e) {
            if (isError(e, Gio.IOErrorEnum.CANCELLED))
                throw e;
            if (isError(e, Gio.IOErrorEnum.NOT_FOUND))
                return {state: 'missing', meta: Meta.emptyMeta(), error: null};
            return unreadableMeta(e.message);
        }
        let text;
        try {
            text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
        } catch {
            return unreadableMeta('not UTF-8');
        }
        const parsed = Meta.parseMeta(text);
        return parsed.ok
            ? {state: 'ok', meta: parsed.meta, error: null}
            : unreadableMeta(parsed.reason);
    }

    async writeMeta(meta) {
        await this.folder.get_child(Meta.META_FILE).replace_contents_bytes_async(
            encode(Meta.serializeMeta(meta)), null, false, Gio.FileCreateFlags.NONE, null);
    }

    /**
     * Labels (labels.js). 'unreadable' when the file cannot be understood:
     * then it is never written.
     *
     * @returns {Promise<{state: 'ok'|'missing'|'unreadable', data: object,
     *   etag: ?string, error: ?string}>}
     */
    async readLabels(cancellable = null) {
        let bytes, etag;
        try {
            [bytes, etag] = await this.folder.get_child(Labels.LABELS_FILE)
                .load_contents_async(cancellable);
        } catch (e) {
            if (isError(e, Gio.IOErrorEnum.CANCELLED))
                throw e;
            if (isError(e, Gio.IOErrorEnum.NOT_FOUND))
                return {state: 'missing', data: Labels.emptyLabels(), etag: null, error: null};
            return unreadable(e.message, null);
        }
        let text;
        try {
            text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
        } catch {
            return unreadable('not UTF-8', etag);
        }
        const parsed = Labels.parseLabels(text);
        return parsed.ok
            ? {state: 'ok', data: parsed.data, etag: etag || null, error: null}
            : unreadable(parsed.reason, etag);
    }

    /**
     * Changes the labels: read, `change`, write back with the etag read;
     * if someone wrote in between, all over again (a few times). The
     * previous file is kept as ".froonty-labels.json~". A file that cannot
     * be understood is never written: this throws an Error whose `code` is
     * 'labels-unreadable'.
     *
     * @param {Function} change (data) → new data (labels.js)
     * @returns {Promise<object>} the labels as written
     */
    async updateLabels(change, cancellable = null) {
        const file = this.folder.get_child(Labels.LABELS_FILE);
        for (let attempt = 0; attempt < LABELS_ATTEMPTS; attempt++) {
            // eslint-disable-next-line no-await-in-loop
            const read = await this.readLabels(cancellable);
            if (read.state === 'unreadable') {
                const error = new Error(`Labels could not be read (${Labels.LABELS_FILE}): ${read.error}`);
                error.code = 'labels-unreadable';
                throw error;
            }
            const data = change(read.data);
            const text = Labels.serializeLabels(data);
            if (text === Labels.serializeLabels(read.data))
                return data; // nothing to change
            let etag = read.etag;
            if (read.state === 'missing') {
                try {
                    // eslint-disable-next-line no-await-in-loop
                    etag = await createEmpty(file);
                } catch (e) {
                    if (isError(e, Gio.IOErrorEnum.EXISTS))
                        continue; // someone else made it: read theirs
                    throw e;
                }
            }
            try {
                // eslint-disable-next-line no-await-in-loop
                await file.replace_contents_bytes_async(encode(text), etag, true,
                    Gio.FileCreateFlags.NONE, cancellable);
                return data;
            } catch (e) {
                if (!isError(e, Gio.IOErrorEnum.WRONG_ETAG))
                    throw e;
            }
        }
        throw new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.WRONG_ETAG,
            `${Labels.LABELS_FILE} kept changing; the label was not saved`);
    }

    /**
     * Drops the labels entry of `name`, if there is one: a new note that
     * takes the name of an earlier one starts without its labels. Writes
     * nothing when there is no entry.
     */
    forgetLabels(name, cancellable = null) {
        return this.updateLabels(data => Labels.withoutNote(data, name), cancellable);
    }

    /** Moves a note to the Trash (recoverable), not a hard delete. */
    async trash(name) {
        await this._file(name).trash_async(PRIORITY, null);
    }

    /**
     * Watches the folder (inotify; no polling). `callback(file, otherFile,
     * eventType)` runs on any change, including our own writes; a rename
     * within the folder is one RENAMED event whose otherFile is the new
     * name.
     *
     * @returns {Gio.FileMonitor} call cancel() to stop
     */
    monitor(callback) {
        const monitor = this.folder.monitor_directory(
            Gio.FileMonitorFlags.WATCH_MOVES, null);
        monitor.connect('changed', (_monitor, file, otherFile, eventType) =>
            callback(file, otherFile, eventType));
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

/**
 * A note's bytes → its text. Not UTF-8 (Latin-1, UTF-16…) or with NUL
 * bytes: shown, but `readOnly`. Invalid bytes show as U+FFFD and NULs as
 * "␀" (U+2400), which GTK and Clutter would otherwise cut the text at.
 *
 * @returns {{text: string, readOnly: ?string}} readOnly: null,
 *   'not-utf8' or 'nul'
 */
export function decodeNote(bytes) {
    let text;
    let readOnly = null;
    try {
        text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    } catch {
        text = new TextDecoder().decode(bytes);
        readOnly = 'not-utf8';
    }
    if (text.includes('\0')) {
        text = text.replaceAll('\0', '\u2400');
        readOnly ??= 'nul';
    }
    return {text, readOnly};
}

function unreadable(error, etag) {
    return {state: 'unreadable', data: Labels.emptyLabels(), etag: etag || null, error};
}

// An empty file; fails with EXISTS rather than touch one that is there.
// Returns its etag.
async function createEmpty(file) {
    const stream = await file.create_async(Gio.FileCreateFlags.NONE, PRIORITY, null);
    await stream.close_async(PRIORITY, null);
    return stream.get_etag() || null;
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
