// SPDX-License-Identifier: GPL-3.0-or-later
// Every note in the folder, for the settings window's "All notes" page:
// text, modification time, colour (read-only) and labels. No St, no GTK;
// unit-tested with plain gjs.
//
// It runs only while the page is shown: start() lists and reads the notes
// (at most 8 reads at a time), then follows the folder monitor, re-reading
// only notes whose etag changed. It never writes .froonty.json (the island
// owns it); labels are written through store.updateLabels().
//
// `store` stays the same object while the folder does (across stop() and
// start()); a start() in another folder (the setting changed while the
// page was hidden) forgets everything of the old one and makes a new
// store, by which an editor of an old folder's note can tell.
//
// Emits 'changed' ({names, structure}) after a refresh that changed
// something: `names` whose text changed, `structure` when notes came or
// went, or labels, colours or errors changed. Also 'renamed' (from, to)
// for a rename in the folder, and 'removed' (name) for a note that is gone.

import Gio from 'gi://Gio';

import {Emitter} from '../../core/emitter.js';
import * as Labels from './labels.js';
import * as Meta from './meta.js';
import * as Names from './names.js';
import {NotesStore} from './store.js';

const FOLDER_KEY = 'notes-folder';
const READS_IN_FLIGHT = 8;

const isError = (e, code) => e?.matches?.(Gio.IOErrorEnum, code) ?? false;

export class NotesLibrary extends Emitter {
    /**
     * @param {object} params
     * @param {Gio.Settings} params.settings
     * @param {Gio.File} params.dataDir Froonty's data folder
     * @param {Function} [params.createStore] (folder) → store, for tests
     */
    constructor({settings, dataDir, createStore = folder => new NotesStore(folder)}) {
        super();
        this._settings = settings;
        this._dataDir = dataDir;
        this._createStore = createStore;
        /** name → {name, text, etag, modified} */
        this.notes = new Map();
        this.meta = Meta.emptyMeta();
        /** 'ok', 'missing' or 'unreadable' (.froonty.json; colours default). */
        this.metaState = 'missing';
        this.labels = Labels.emptyLabels();
        /** 'ok', 'missing' or 'unreadable' (labels read-only). */
        this.labelsState = 'missing';
        /** The folder could not be read (message), or null. */
        this.error = null;
        this.store = null;
        this._running = false;
        this._monitor = null;
        this._refreshing = null;
        this._again = false;
        this._listChanged = false;
        // Renames seen (folder events); a refresh leaves notes renamed
        // after its listing started to the next one.
        this._renames = 0;
    }

    /** The folder notes live in (setting, or <data dir>/notes). */
    get folder() {
        const path = this._settings.get_string(FOLDER_KEY);
        return path ? Gio.File.new_for_path(path) : this._dataDir.get_child('notes');
    }

    get running() {
        return this._running;
    }

    start() {
        if (this._running)
            return this.whenIdle();
        const folder = this.folder;
        if (!this.store?.folder.equal(folder)) {
            this._forget();
            this.store = this._createStore(folder);
        }
        this._running = true;
        this._cancellable = new Gio.Cancellable();
        this._listChanged = true; // the first refresh always reports
        try {
            this._monitor = this.store.monitor((file, other, type) => this._onEvent(file, other, type));
        } catch (e) {
            this._monitor = null;
            this.error = e.message;
        }
        return this.refresh();
    }

    stop() {
        if (!this._running)
            return;
        this._running = false;
        this._cancellable.cancel();
        this._monitor?.cancel();
        this._monitor = null;
    }

    /** Another folder (setting changed): everything is read again. */
    restart() {
        this.stop();
        this.store = null;
        return this.start();
    }

    _forget() {
        this.notes = new Map();
        this.meta = Meta.emptyMeta();
        this.metaState = 'missing';
        this.labels = Labels.emptyLabels();
        this.labelsState = 'missing';
        this.error = null;
    }

    /** Resolves when no refresh is running. */
    async whenIdle() {
        while (this._refreshing)
            // eslint-disable-next-line no-await-in-loop
            await this._refreshing;
    }

    /** A note's labels (labels.js). */
    labelsOf(name) {
        return Labels.labelsOf(this.labels, name);
    }

    /** Every label of the notes there are, with counts. */
    allLabels() {
        return Labels.allLabels(this.labels, [...this.notes.keys()]);
    }

    colorOf(name) {
        return Meta.colorOf(this.meta, name);
    }

    /** Turns a label on or off for a note; read-modify-write (store.js). */
    async setLabel(name, label, on) {
        this.labels = await this.store.updateLabels(
            data => Labels.withLabel(data, name, label, on));
        this.labelsState = 'ok';
        this._emit({names: [], structure: true});
    }

    /**
     * Re-lists the folder; reads notes that are new or whose etag changed.
     * One at a time: a refresh asked for meanwhile runs once afterwards.
     */
    refresh() {
        if (this._refreshing) {
            this._again = true;
            return this._refreshing;
        }
        this._refreshing = (async () => {
            do {
                this._again = false;
                const cancellable = this._cancellable;
                try {
                    // eslint-disable-next-line no-await-in-loop
                    await this._refresh();
                } catch (e) {
                    if (!isError(e, Gio.IOErrorEnum.CANCELLED) && this._running &&
                        !cancellable.is_cancelled()) {
                        this.error = e.message;
                        this._emit({names: [], structure: true});
                    }
                }
            } while (this._again && this._running);
            this._refreshing = null;
        })();
        return this._refreshing;
    }

    _onEvent(file, other, type) {
        if (!this._running)
            return;
        // A rename inside the folder: the note keeps its text under its new
        // name, and an editor showing it follows.
        if (type === Gio.FileMonitorEvent.RENAMED && other) {
            const from = Names.noteName(file.get_basename());
            const to = Names.noteName(other.get_basename());
            const note = from && this.notes.get(from);
            if (note && to) {
                this.notes.delete(from);
                this.notes.set(to, {...note, name: to, renamedAt: ++this._renames});
                this._listChanged = true;
                this.emit('renamed', from, to);
            }
        }
        this.refresh();
    }

    async _refresh() {
        // A stop() (or a start in another folder) ends this refresh.
        const cancellable = this._cancellable;
        const store = this.store;
        const live = () => this._running && !cancellable.is_cancelled();
        const renames = this._renames;
        const infos = await store.listInfo(cancellable);
        if (!live())
            return;
        const changed = [];
        let structure = this.error !== null || this._listChanged;
        this._listChanged = false;
        this.error = null;

        // Gone from the listing. Not a note renamed while the folder was
        // being listed: the listing is older than its new name, and the
        // refresh that rename asked for looks again.
        const listed = new Set(infos.map(info => info.name));
        for (const [name, note] of [...this.notes]) {
            if (!listed.has(name) && !(note.renamedAt > renames)) {
                this.notes.delete(name);
                structure = true;
                this.emit('removed', name);
            }
        }

        const stale = infos.filter(info => this.notes.get(info.name)?.etag !== info.etag ||
            info.etag === null);
        let next = 0;
        const worker = async () => {
            while (next < stale.length && live()) {
                const info = stale[next++];
                let read;
                try {
                    // eslint-disable-next-line no-await-in-loop
                    read = await store.readTagged(info.name, cancellable);
                } catch (e) {
                    if (isError(e, Gio.IOErrorEnum.NOT_FOUND))
                        continue; // gone meanwhile; the next refresh says so
                    throw e;
                }
                const old = this.notes.get(info.name);
                if (!old)
                    structure = true;
                if (!old || old.text !== read.text || old.modified !== info.modified)
                    changed.push(info.name);
                this.notes.set(info.name, {
                    name: info.name,
                    text: read.text,
                    etag: read.etag,
                    modified: info.modified,
                });
            }
        };
        await Promise.all(Array.from({length: Math.min(READS_IN_FLIGHT, stale.length)}, worker));
        if (!live())
            return;

        const meta = await store.readMeta(cancellable);
        const labels = await store.readLabels(cancellable);
        if (!live())
            return;
        if (meta.state !== this.metaState ||
            JSON.stringify(meta.meta.colors) !== JSON.stringify(this.meta.colors))
            structure = true;
        this.meta = meta.meta;
        this.metaState = meta.state;
        if (labels.state !== this.labelsState ||
            Labels.serializeLabels(labels.data) !== Labels.serializeLabels(this.labels))
            structure = true;
        this.labels = labels.data;
        this.labelsState = labels.state;

        if (changed.length || structure)
            this._emit({names: changed, structure});
    }

    _emit(change) {
        if (this._running)
            this.emit('changed', change);
    }
}
