// SPDX-License-Identifier: GPL-3.0-or-later
// Notes service: the list of notes, the selected note's text, labels,
// autosave and folder watching. No St; unit-tested with plain gjs.
//
// Emits 'changed' when the list, the selection, the loaded text, the error
// or the notice changes, and 'labels-changed' when the labels do (without
// 'changed', so the tabs are not rebuilt under an open label menu). Text
// typed by the user is pushed in with setText() and is not echoed back, so
// the editor is never re-rendered under the cursor.
//
// Every operation that reads or changes the folder (open, refresh, select,
// create, rename, trash, labels) runs through one queue, strictly one after
// the other. The folder monitor fires for our own writes too; without the
// queue its refresh would race the operation that caused it.
//
// The selected note is saved by a NoteWriter (noteWriter.js): it never
// writes over a version changed elsewhere since it was loaded, and keeps
// ours as "<name> (conflict)" instead, which then becomes the selected note
// (`notice` says so). A note whose save failed stays selected, with its
// error, until it can be saved: another note is not opened over its text,
// and when the folder changes, the text is kept as a copy in the new one.
//
// .froonty.json (order, colours) is written only when it could be read
// (`metaState`): a file mangled by hand or by a sync is left as it is.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Emitter} from '../../core/emitter.js';
import {isColor} from './colors.js';
import * as Labels from './labels.js';
import * as Meta from './meta.js';
import * as Names from './names.js';
import {NoteWriter} from './noteWriter.js';
import {NotesStore} from './store.js';

const FOLDER_KEY = 'notes-folder';
const LAST_KEY = 'notes-last';

export class NotesService extends Emitter {
    /**
     * @param {object} ctx
     * @param {Gio.Settings} ctx.settings
     * @param {Gio.File} ctx.dataDir Froonty's data folder
     */
    constructor({settings, dataDir}) {
        super();
        this._settings = settings;
        this._dataDir = dataDir;

        this.notes = [];
        this._meta = Meta.emptyMeta();
        /** 'ok', 'missing' or 'unreadable' (then .froonty.json is not written). */
        this.metaState = 'missing';
        this._labels = Labels.emptyLabels();
        /** 'ok', 'missing' or 'unreadable' (then labels are read-only). */
        this.labelsState = 'missing';
        this.selected = null;
        this.text = '';
        /** null, or why the selected note is read-only ('not-utf8', 'nul'). */
        this.readOnly = null;
        this.error = null;
        /**
         * null, or {kind: 'conflict'|'rescued', name, copy}: shown under the
         * note. 'rescued': text that could not be saved in the previous
         * folder was kept as `copy` in this one.
         */
        this.notice = null;

        this._store = null;
        this._writer = null;
        this._monitor = null;
        this._queue = Promise.resolve();
        this._refreshQueued = false;
        this._running = false;
    }

    start() {
        this._running = true;
        this._cancellable = new Gio.Cancellable();
        this._settingsId = this._settings.connect(`changed::${FOLDER_KEY}`,
            () => this._enqueue(() => this._openFolder()));
        this._opened = this._enqueue(() => this._openFolder());
    }

    /** Resolves when the folder has been opened (for tests). */
    whenReady() {
        return this._opened;
    }

    stop() {
        // The last write is started, not awaited: it completes on its own
        // (a conflict copy included) and touches nothing but files.
        this._writer?.stop();
        this._running = false;
        this._cancellable.cancel();
        this._settings.disconnect(this._settingsId);
        this._monitor?.cancel();
        this._monitor = null;
    }

    /** The view is hidden: save now rather than in 0.8 s. */
    setActive(active) {
        if (!active)
            this.flush();
    }

    /** The folder notes live in (setting, or <data dir>/notes). */
    get folder() {
        const path = this._settings.get_string(FOLDER_KEY);
        return path ? Gio.File.new_for_path(path) : this._dataDir.get_child('notes');
    }

    setText(text) {
        if (this.selected === null || this.readOnly || text === this.text)
            return;
        this.text = text;
        this._writer.edited(text);
    }

    /** Colour id of a note (meta.js); yellow by default. */
    colorOf(name) {
        return Meta.colorOf(this._meta, name);
    }

    /** Colour id of the selected note. */
    get color() {
        return this.colorOf(this.selected);
    }

    /** Changes the selected note's colour. */
    setColor(color) {
        return this._enqueue(async () => {
            // Not over a .froonty.json that could not be read.
            if (this.selected === null || !isColor(color) || color === this.color ||
                this.metaState === 'unreadable')
                return;
            this._meta = Meta.withColor(this._meta, this.selected, color);
            await this._saveMeta();
            this._changed();
        });
    }

    /** Labels of a note, sorted (labels.js). */
    labelsOf(name) {
        return Labels.labelsOf(this._labels, name);
    }

    /** Every label of the notes there are, with counts. */
    allLabels() {
        return Labels.allLabels(this._labels, this.notes);
    }

    /** Turns a label on or off for a note; written at once. */
    setLabel(name, label, on) {
        return this._enqueue(async () => {
            if (!this.notes.includes(name))
                return;
            await this._updateLabels(data => Labels.withLabel(data, name, label, on));
        });
    }

    /**
     * Starts writing pending changes now.
     *
     * @returns {Promise} resolves when every write started so far is done
     */
    flush() {
        return this._writer?.flush() ?? Promise.resolve();
    }

    select(name) {
        return this._enqueue(async () => {
            if (name === this.selected || !this.notes.includes(name))
                return;
            await this.flush();
            // Not saved (the write failed): it stays open, with its error.
            if (this._writer.dirty)
                return;
            await this._load(name);
        });
    }

    /** Creates a note named after the current time and selects it. */
    create() {
        return this._enqueue(async () => {
            await this.flush();
            if (this._writer.dirty)
                return; // as in select()
            const now = GLib.DateTime.new_now_local();
            const name = Names.uniqueName(Names.timestampName(now), this.notes);
            await this._store.create(name);
            // Labels left by an earlier note of that name are not this one's.
            if (this.labelsOf(name).length)
                await this._updateLabels(data => Labels.withoutNote(data, name), true);
            this._meta = Meta.withNote(this._meta, name);
            this._setNotes([...this.notes, name]);
            await this._saveMeta();
            await this._load(name);
        });
    }

    /** Renames the selected note. @returns {Promise<boolean>} */
    async rename(newName) {
        const name = Names.cleanName(newName);
        if (!name)
            return false;

        const renamed = await this._enqueue(async () => {
            const old = this.selected;
            if (old === null)
                return false;
            if (name !== old) {
                await this.flush();
                await this._store.rename(old, name);
                this._writer.renamed(name, await this._store.etagOf(name));
                this.selected = name;
                this.notice = null;
                this._meta = Meta.withRename(this._meta, old, name);
                this._setNotes(this.notes.map(n => n === old ? name : n));
                await this._saveMeta();
                this._remember(name);
                this._changed();
                // Its labels go with it (an old entry for the new name goes).
                if (this.labelsState !== 'unreadable' &&
                    (this.labelsOf(old).length || this.labelsOf(name).length))
                    await this._updateLabels(data => Labels.withRename(data, old, name), true);
            }
            return true;
        });
        return renamed === true;
    }

    /**
     * Moves a note to the Trash and selects a neighbour. Its labels stay
     * in the labels file, so restoring it from the Trash brings them back.
     */
    trash(name) {
        return this._enqueue(async () => {
            // Its unsaved edits go to the Trash with it. A write still in
            // flight must land first: written after the trash, it would
            // create the note again.
            if (name === this.selected)
                this._writer.discard();
            await this._writer.idle();
            await this._store.trash(name);

            const index = this.notes.indexOf(name);
            this._meta = Meta.withoutNote(this._meta, name);
            this._setNotes(this.notes.filter(n => n !== name));
            await this._saveMeta();
            if (name === this.selected) {
                this.notice = null;
                const next = this.notes[Math.min(index, this.notes.length - 1)];
                if (next)
                    await this._load(next);
                else
                    this._clearSelection();
            }
            this._changed();
        });
    }

    // Runs `operation` after every earlier one. Failures are reported via
    // `error` and resolve to undefined; the queue keeps going.
    _enqueue(operation) {
        const run = this._queue.then(() => (this._running ? operation() : undefined));
        this._queue = run.catch(() => {});
        return run.catch(e => this._fail(e));
    }

    async _openFolder() {
        // The previous folder's note is saved first. What still cannot be
        // saved there (a failed write) is kept as a copy in the new folder.
        const previous = this._writer;
        if (previous)
            await previous.stop();
        const unsaved = previous?.dirty ? {name: previous.name, text: previous.text} : null;
        this._monitor?.cancel();
        this._store = new NotesStore(this.folder);
        const writer = new NoteWriter(this._store);
        writer.connect('conflict', (_writer, conflict) => this._onConflict(writer, conflict));
        writer.connect('error', (_writer, e) => this._fail(e));
        this._writer = writer;
        await this._store.ensureFolder(this._cancellable);
        this._monitor = this._store.monitor(() => this._queueRefresh());
        this.selected = null;
        let rescued = null;
        let failed = null;
        if (unsaved) {
            try {
                const copy = await this._store.saveCopy(unsaved.name, unsaved.text);
                this._remember(copy.name);
                rescued = {kind: 'rescued', name: unsaved.name, copy: copy.name};
            } catch (e) {
                failed = e; // the new folder is shown all the same
            }
        }
        await this._refresh();
        if (rescued) {
            this.notice = rescued;
            this._changed();
        }
        if (failed)
            this._fail(failed);
    }

    // Our version of a note was kept as a copy (noteWriter.js). The editor
    // shows that text already; the copy becomes the selected note.
    _onConflict(writer, {name, copy}) {
        if (writer !== this._writer || !this._running)
            return;
        if (writer.name === copy && this.selected === name) {
            this.selected = copy;
            this._remember(copy);
        }
        this.notice = {kind: 'conflict', name, copy};
        this._changed();
        this._enqueue(async () => {
            // The store cleared the labels an old note of the copy's name
            // had (store.js saveCopy).
            await this._readLabels();
            if (this.notes.includes(copy))
                return;
            this._meta = Meta.withNote(this._meta, copy);
            this._setNotes([...this.notes, copy]);
            await this._saveMeta();
            this._changed();
        });
    }

    // Folder events arrive in bursts; one pending refresh covers them all.
    _queueRefresh() {
        if (this._refreshQueued)
            return;
        this._refreshQueued = true;
        this._enqueue(() => {
            this._refreshQueued = false;
            return this._refresh();
        });
    }

    // Re-reads the list, the labels, and the selected note unless it has
    // unsaved edits or a write in flight (external changes must not be
    // reloaded under the user's cursor). The view hears of it when the
    // list, its order, the colours or the note changed.
    async _refresh() {
        const before = JSON.stringify([this.notes, this._meta.colors, this.metaState]);
        let names = await this._store.list(this._cancellable);
        const meta = await this._store.readMeta(this._cancellable);
        this._meta = meta.meta;
        this.metaState = meta.state;
        await this._readLabels();
        this._setNotes(names);
        names = this.notes; // display order
        // Notes created by another program join the order where they are first
        // seen (the end), once; the save's own folder event finds none left.
        if (names.some(n => !this._meta.order.includes(n)))
            await this._saveMeta();
        const changed = JSON.stringify([this.notes, this._meta.colors, this.metaState]) !== before;

        const writer = this._writer;
        if (this.selected !== null && names.includes(this.selected)) {
            const quiet = !writer.dirty && !writer.busy;
            const loaded = quiet && await this._load(this.selected);
            if (!loaded && (!quiet || changed))
                this._changed();
            return;
        }
        // Gone while it had unsaved edits: keep them as a copy.
        if (this.selected !== null && writer.dirty) {
            await writer.saveAsCopy();
            return;
        }

        const last = this._settings.get_string(LAST_KEY);
        const pick = names.includes(last) ? last : names.at(-1);
        if (pick)
            await this._load(pick);
        else
            this._clearSelection();
    }

    // Loads a note into the editor. @returns {Promise<boolean>} whether it
    // did (and emitted 'changed'): not when the note is the selected one
    // and nothing changed, or the user's typing is newer.
    async _load(name) {
        const writer = this._writer;
        const quiet = !writer.dirty && !writer.busy;
        const revision = writer.revision;
        const {text, etag, readOnly} = await this._store.readTagged(name, this._cancellable);
        if (!this._running)
            return false;
        if (name === this.selected) {
            // Typed or saved while this read was on its way: it may be
            // older than what the user has; the typing wins.
            if (!quiet || writer.dirty || writer.busy || writer.revision !== revision)
                return false;
            if (text === this.text && readOnly === this.readOnly) {
                // Same text; its etag may still be new (a touched file).
                writer.adopt(text, etag);
                return false;
            }
        }

        // Throws, rather than drop them, over unsaved changes.
        writer.open(name, text, etag, {readOnly: readOnly !== null});
        this.selected = name;
        this.text = text;
        this.readOnly = readOnly;
        this.error = null;
        this.notice = null;
        this._remember(name);
        this._changed();
        return true;
    }

    _clearSelection() {
        this.selected = null;
        this.text = '';
        this.readOnly = null;
        this._changed();
    }

    // Display order: creation order from the metadata (meta.js).
    _setNotes(names) {
        this.notes = Meta.orderedNames([...new Set(names)], this._meta);
    }

    // Only on create, rename, trash and colour changes; never per keystroke.
    // Never over a file that could not be read (the order and colours in it
    // are not lost: they show again once it is fixed).
    async _saveMeta() {
        this._meta = Meta.snapshot(this._meta, this.notes);
        if (this.metaState === 'unreadable')
            return;
        await this._store.writeMeta(this._meta);
        this.metaState = 'ok';
    }

    async _readLabels() {
        const read = await this._store.readLabels(this._cancellable);
        this._setLabels(read.data, read.state);
    }

    // `reportOnly`: a failure is shown, but the operation that asked for
    // the change (a rename, a new note) still succeeded.
    async _updateLabels(change, reportOnly = false) {
        try {
            const data = await this._store.updateLabels(change, this._cancellable);
            this._setLabels(data, 'ok');
        } catch (e) {
            if (!reportOnly)
                throw e;
            this._fail(e);
        }
    }

    _setLabels(data, state) {
        const changed = state !== this.labelsState ||
            Labels.serializeLabels(data) !== Labels.serializeLabels(this._labels);
        this._labels = data;
        this.labelsState = state;
        if (changed && this._running)
            this.emit('labels-changed');
    }

    _remember(name) {
        if (this._settings.get_string(LAST_KEY) !== name)
            this._settings.set_string(LAST_KEY, name);
    }

    _fail(error) {
        if (error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            return;
        this.error = error?.message ?? String(error);
        this._changed();
    }

    _changed() {
        if (this._running)
            this.emit('changed');
    }
}
