// SPDX-License-Identifier: GPL-3.0-or-later
// Saves one open note: autosave after a pause in typing, and never over
// someone else's version. Shared by the island (service.js) and the
// settings window's "All notes" page; no St, no GTK. Unit-tested.
//
// Each write names the etag of the version it replaces (store.js). When
// the file changed since, the writer looks at what is on disk:
//
//   - the same text as ours: someone already saved it; take their etag;
//   - our base text (what we loaded or last wrote): only the file's time
//     changed (a sync tool touched it); write again;
//   - anything else: both versions are kept. Ours goes to a new note,
//     "<name> (conflict)", which the writer follows from then on, and
//     'conflict' is emitted.
//
// Writes run one after the other, each with the etag the previous one
// returned. A write already started finishes even after stop() (disable,
// screen lock), including the conflict copy.
//
// A write that fails (no permission, a full disk, a folder that went away)
// leaves the text unsaved (`dirty`): it is retried with the next edit or
// flush, and open() refuses to replace it, so callers keep the note open
// (or keep the text elsewhere) instead of dropping it. A note opened
// `readOnly` (store.js decodeNote) is never written.
//
// Emits 'conflict' ({name, copy}) and 'error' (e).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Emitter} from '../../core/emitter.js';

const isError = (e, code) => e?.matches?.(Gio.IOErrorEnum, code) ?? false;

export class NoteWriter extends Emitter {
    /**
     * @param {NotesStore} store
     * @param {object} [options]
     * @param {number} [options.delayMs] autosave this long after the last edit
     */
    constructor(store, {delayMs = 800} = {}) {
        super();
        this._store = store;
        this._delayMs = delayMs;
        // The note written to. Writes in flight keep the target they were
        // started for, so open() never redirects them.
        this._target = {name: null, etag: null, base: ''};
        this._text = '';
        this._dirty = false;
        this._timeoutId = 0;
        this._chain = Promise.resolve();
        this._pending = 0;
        // Counts edits and writes: a read that started before a change is
        // stale even when that change is already saved.
        this._revision = 0;
        this._stopped = false;
        this._readOnly = false;
    }

    get name() {
        return this._target.name;
    }

    get etag() {
        return this._target.etag;
    }

    get text() {
        return this._text;
    }

    /** The text last loaded or written: what the file holds, as far as we know. */
    get base() {
        return this._target.base;
    }

    /** Unsaved edits wait for the timer or flush(). */
    get dirty() {
        return this._dirty;
    }

    /** A write is in flight. */
    get busy() {
        return this._pending > 0;
    }

    /** Changes with every edit and every write started. */
    get revision() {
        return this._revision;
    }

    /** The open note is never written (not plain UTF-8 text). */
    get readOnly() {
        return this._readOnly;
    }

    /**
     * A note as read from disk: it becomes the base; nothing to save.
     * Throws while there is unsaved text (a failed write): callers check
     * `dirty` after flush() and keep that note open, or keep its text.
     *
     * @param {string} name
     * @param {string} text
     * @param {?string} etag
     * @param {object} [options]
     * @param {boolean} [options.readOnly] never write this note
     */
    open(name, text, etag, {readOnly = false} = {}) {
        if (this._dirty)
            throw new Error(`“${this._target.name}” has unsaved changes; it stays open`);
        this._cancelTimer();
        this._target = {name, etag: etag ?? null, base: text};
        this._text = text;
        this._readOnly = readOnly;
    }

    /** The disk has this text (ours, or the same): new base and etag. */
    adopt(text, etag) {
        if (this._dirty || this.busy)
            return;
        this._target.base = text;
        this._target.etag = etag ?? null;
        this._text = text;
    }

    /** The user changed the text: save it after a pause. */
    edited(text) {
        if (this._target.name === null || this._readOnly || text === this._text)
            return;
        this._text = text;
        this._dirty = true;
        this._revision++;
        this._schedule();
    }

    /**
     * Starts saving unsaved edits now.
     *
     * @returns {Promise} resolves once every write started so far is done
     */
    flush() {
        this._cancelTimer();
        if (this._dirty) {
            this._dirty = false;
            const target = this._target;
            const text = this._text;
            this._enqueue(() => this._write(target, text));
        }
        return this.idle();
    }

    /** Resolves when no write is in flight. */
    async idle() {
        while (this._pending > 0)
            // eslint-disable-next-line no-await-in-loop
            await this._chain;
    }

    /** Froonty renamed the note. */
    renamed(newName, etag) {
        this._target.name = newName;
        this._target.etag = etag ?? null;
    }

    /** Drops unsaved edits (the note goes to the Trash). */
    discard() {
        this._cancelTimer();
        this._dirty = false;
        this._text = this._target.base;
    }

    /**
     * The note is gone from disk while it had unsaved edits: keeps them as
     * a copy, which the writer follows from then on.
     */
    saveAsCopy() {
        this._cancelTimer();
        this._dirty = false;
        const target = this._target;
        const text = this._text;
        this._enqueue(() => this._keepCopy(target, text));
        return this.idle();
    }

    /** Saves what is unsaved; no timer is started afterwards. */
    stop() {
        this._stopped = true;
        return this.flush();
    }

    _enqueue(step) {
        this._revision++;
        this._pending++;
        this._chain = this._chain
            .then(step)
            .catch(e => this.emit('error', e))
            .finally(() => this._pending--);
    }

    async _write(target, text) {
        try {
            target.etag = await this._store.write(target.name, text, target.etag);
            target.base = text;
            return;
        } catch (e) {
            if (!isError(e, Gio.IOErrorEnum.WRONG_ETAG)) {
                this._unsaved(target);
                throw e;
            }
        }

        // Someone else changed the file since we last read or wrote it.
        let disk = null;
        try {
            disk = await this._store.readTagged(target.name);
        } catch (e) {
            if (!isError(e, Gio.IOErrorEnum.NOT_FOUND)) {
                this._unsaved(target);
                throw e;
            }
        }
        // (A file now read for display only is never taken for ours.)
        if (disk && !disk.readOnly && disk.text === text) {
            target.etag = disk.etag;
            target.base = text;
            return;
        }
        if (disk && !disk.readOnly && disk.text === target.base) {
            // Only the file's time changed: our text replaces the same old one.
            try {
                target.etag = await this._store.write(target.name, text, disk.etag);
                target.base = text;
                return;
            } catch (e) {
                if (!isError(e, Gio.IOErrorEnum.WRONG_ETAG)) {
                    this._unsaved(target);
                    throw e;
                }
            }
        }
        await this._keepCopy(target, text);
    }

    // Writes `text` to a new note next to the target, then follows it.
    async _keepCopy(target, text) {
        const original = target.name;
        let copy;
        try {
            copy = await this._store.saveCopy(original, text);
        } catch (e) {
            this._unsaved(target);
            throw e;
        }
        target.name = copy.name;
        target.etag = copy.etag;
        target.base = text;
        // Typed meanwhile: that goes to the copy too, after the pause.
        if (target === this._target && this._dirty)
            this._schedule();
        this.emit('conflict', {name: original, copy: copy.name});
    }

    // A write failed: what it carried still needs saving, unless the user
    // has moved on to another note.
    _unsaved(target) {
        if (target === this._target)
            this._dirty = true;
    }

    _schedule() {
        this._cancelTimer();
        if (this._stopped)
            return;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._delayMs, () => {
            this._timeoutId = 0;
            this.flush();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelTimer() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }
}
