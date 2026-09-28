// SPDX-License-Identifier: GPL-3.0-or-later
// Notes service: the list of notes, the selected note's text, autosave and
// folder watching. No St; unit-tested with plain gjs.
//
// Emits 'changed' when the list, the selection, the loaded text or the
// error changes. Text typed by the user is pushed in with setText() and is
// not echoed back, so the editor is never re-rendered under the cursor.
//
// Every operation that reads or changes the folder (open, refresh, select,
// create, rename, trash) runs through one queue, strictly one after the
// other. The folder monitor fires for our own writes too; without the
// queue its refresh would race the operation that caused it.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Emitter} from '../../core/emitter.js';
import * as Names from './names.js';
import {NotesStore} from './store.js';

// Save this long after the last keystroke (and on hide, switch, disable).
const AUTOSAVE_DELAY_MS = 800;

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
        this.selected = null;
        this.text = '';
        this.error = null;

        this._store = null;
        this._monitor = null;
        this._dirty = false;
        this._saveTimeoutId = 0;
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
        // and touches nothing but the file.
        this.flush();
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
        if (this.selected === null || text === this.text)
            return;
        this.text = text;
        this._dirty = true;
        this._scheduleSave();
    }

    /** Starts writing pending changes now. @returns {Promise} */
    flush() {
        this._cancelSave();
        if (!this._dirty || !this._store || this.selected === null)
            return Promise.resolve();

        this._dirty = false;
        return this._store.write(this.selected, this.text).catch(e => this._fail(e));
    }

    select(name) {
        return this._enqueue(async () => {
            if (name === this.selected || !this.notes.includes(name))
                return;
            await this.flush();
            await this._load(name);
        });
    }

    /** Creates a note named after the current time and selects it. */
    create() {
        return this._enqueue(async () => {
            await this.flush();
            const now = GLib.DateTime.new_now_local();
            const name = Names.uniqueName(Names.timestampName(now), this.notes);
            await this._store.create(name);
            this._setNotes([...this.notes, name]);
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
                this.selected = name;
                this._setNotes(this.notes.map(n => n === old ? name : n));
                this._remember(name);
                this._changed();
            }
            return true;
        });
        return renamed === true;
    }

    /** Moves a note to the Trash and selects a neighbour. */
    trash(name) {
        return this._enqueue(async () => {
            if (name === this.selected) {
                // Its unsaved edits go to the Trash with it.
                this._cancelSave();
                this._dirty = false;
            }
            await this._store.trash(name);

            const index = this.notes.indexOf(name);
            this._setNotes(this.notes.filter(n => n !== name));
            if (name === this.selected) {
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
        await this.flush();
        this._monitor?.cancel();
        this._store = new NotesStore(this.folder);
        await this._store.ensureFolder(this._cancellable);
        this._monitor = this._store.monitor(() => this._queueRefresh());
        this.selected = null;
        await this._refresh();
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

    // Re-reads the list, and the selected note unless it has unsaved edits
    // (external changes must not be reloaded under the user's cursor).
    async _refresh() {
        const names = await this._store.list(this._cancellable);
        this._setNotes(names);

        if (this.selected !== null && names.includes(this.selected)) {
            if (!this._dirty)
                await this._load(this.selected);
            else
                this._changed();
            return;
        }

        const last = this._settings.get_string(LAST_KEY);
        const pick = names.includes(last) ? last : names.at(-1);
        if (pick)
            await this._load(pick);
        else
            this._clearSelection();
    }

    async _load(name) {
        const text = await this._store.read(name, this._cancellable);
        if (!this._running || (name === this.selected && text === this.text))
            return;

        this.selected = name;
        this.text = text;
        this._dirty = false;
        this.error = null;
        this._remember(name);
        this._changed();
    }

    _clearSelection() {
        this.selected = null;
        this.text = '';
        this._changed();
    }

    _setNotes(names) {
        this.notes = [...new Set(names)].sort(Names.compareNames);
    }

    _remember(name) {
        if (this._settings.get_string(LAST_KEY) !== name)
            this._settings.set_string(LAST_KEY, name);
    }

    _scheduleSave() {
        this._cancelSave();
        this._saveTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            AUTOSAVE_DELAY_MS, () => {
                this._saveTimeoutId = 0;
                this.flush();
                return GLib.SOURCE_REMOVE;
            });
    }

    _cancelSave() {
        if (this._saveTimeoutId) {
            GLib.source_remove(this._saveTimeoutId);
            this._saveTimeoutId = 0;
        }
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
