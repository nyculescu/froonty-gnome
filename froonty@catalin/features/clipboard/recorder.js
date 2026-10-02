// SPDX-License-Identifier: GPL-3.0-or-later
// Clipboard history recorder (docs/features/clipboard.md). Event-driven:
// it is told of every copy (Meta.Selection 'owner-changed'), reads the
// copy once, and keeps it in the history on disk, unless it is
// empty, too large, of a kind it does not keep, or a password.
//
// A password is never saved. It is
// - a copy marked secret by a password manager (entries.js SECRET_HINTS),
// - a copy made while an app in clipboard-ignored-apps has the focus
//   (password managers and authenticators by default),
// - copied text that looks like one (entries.js looksLikePassword), when
//   clipboard-detect-passwords is on: browsers mark nothing.
// The latest one is shown hidden, in memory only, until whichever comes
// first: clipboard-password-minutes pass, the clipboard is cleared (as
// password managers do) or anything else is copied, or the screen locks
// (which disables the extension). With 0 minutes it is not shown at all.
//
// Nothing leaves the computer; the history is on disk (store.js). Picking
// an entry puts it back on the clipboard, to be pasted as usual: Froonty
// never pastes by itself and has no shortcut for it (review guidelines).
//
// Its GNOME parts come in as `clipboard`, `selection` and `focusedApp`
// (shared.js makes them), so plain gjs tests can drive it. No St.
// Emits 'changed' when the history or the current entry changes.

import GLib from 'gi://GLib';

import {Emitter} from '../../core/emitter.js';
import {
    addEntry, classify, copiedFilesText, COPIED_FILES, imageExtension, isFormatted, looksLikePassword,
    MAX_IMAGE_BYTES, MAX_TEXT_LENGTH, parseFiles, trim,
} from './entries.js';

export const LIMIT_KEY = 'clipboard-history-size';
export const IGNORED_KEY = 'clipboard-ignored-apps';
export const PASSWORD_MINUTES_KEY = 'clipboard-password-minutes';
export const DETECT_KEY = 'clipboard-detect-passwords';

// A one-shot timer: the hidden password's expiry (DESIGN.md §8).
const GLIB_TIMER = {
    add: (ms, callback) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        callback();
        return GLib.SOURCE_REMOVE;
    }),
    remove: id => GLib.source_remove(id),
};

const checksum = data => GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, data, -1);
const bytesChecksum = bytes => GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);

function newId(now) {
    const random = GLib.random_int_range(0, 36 ** 4).toString(36).padStart(4, '0');
    return `${now.toString(36)}-${random}`;
}

export class ClipboardRecorder extends Emitter {
    /**
     * @param {object} deps
     * @param {Gio.Settings} deps.settings
     * @param {ClipboardStore} deps.store
     * @param {object} deps.clipboard promise API over St.Clipboard (shared.js)
     * @param {object} deps.selection connect(callback(cleared))/disconnect(id):
     *   each copy, and the clipboard being cleared
     * @param {Function} deps.focusedApp () → names of the focused app
     * @param {Function} [deps.now] () → ms since the epoch
     * @param {object} [deps.timer] add(ms, callback) → id, remove(id)
     */
    constructor({settings, store, clipboard, selection, focusedApp,
        now = () => Date.now(), timer = GLIB_TIMER}) {
        super();
        this._settings = settings;
        this._store = store;
        this._clipboard = clipboard;
        this._selection = selection;
        this._focusedApp = focusedApp;
        this._now = now;
        this._timer = timer;
        this._expiryId = 0;
        this._seq = 0;
        // Set by copy(): null, true (a history entry) or {password: hash}.
        this._ownCopy = null;
        this._destroyed = false;
        /** The history, newest first (saved). */
        this.entries = [];
        /**
         * The latest password, hidden, or null; never saved:
         * {id, kind: 'password', time, expiresAt, hash, text, reason}.
         */
        this.password = null;
        /** Whether the history has been read from disk. */
        this.loaded = false;
        /** The id of the entry on the clipboard now, or null. */
        this.currentId = null;
        /**
         * Whether what is on the clipboard now is text with formatting
         * (copyAsPlainText() leaves only its plain text).
         */
        this.currentFormatted = false;
        /** Why the last copy was not kept (entries.js classify), or null. */
        this.lastSkip = null;
    }

    /** What the tab lists: the hidden password (the latest copy), then the history. */
    get shown() {
        return this.password ? [this.password, ...this.entries] : this.entries;
    }

    start() {
        this._selectionId = this._selection.connect(cleared =>
            cleared ? this._onCleared() : this._capture());
        this._limitId = this._settings.connect(`changed::${LIMIT_KEY}`, () => this._trim());
        this._minutesId = this._settings.connect(`changed::${PASSWORD_MINUTES_KEY}`,
            () => this._rescheduleExpiry());
        this._loading = this._store.load().then(entries => {
            if (this._destroyed)
                return;
            this.entries = trim(entries, this._limit()).entries;
            this.loaded = true;
            this.emit('changed');
        });
        return this._loading;
    }

    destroy() {
        this._destroyed = true;
        this._selection.disconnect(this._selectionId);
        this._settings.disconnect(this._limitId);
        this._settings.disconnect(this._minutesId);
        this._dropPassword();
    }

    /** The file holding an image entry's picture (for previews). */
    imageFile(entry) {
        return this._store.imageFile(entry.file);
    }

    /** Puts entry `id` back on the clipboard, ready to be pasted. */
    async copy(id) {
        if (this.password?.id === id) {
            // It comes back as a copy of plain text: still the password.
            this._ownCopy = {password: this.password.hash};
            this._clipboard.setText(this.password.text);
            return true;
        }
        const entry = this.entries.find(e => e.id === id);
        if (!entry)
            return false;
        // The window that had the focus may be a password manager; a
        // pick in Froonty is not a copy from it.
        this._ownCopy = true;
        if (entry.kind === 'text') {
            this._clipboard.setText(entry.text);
        } else if (entry.kind === 'files') {
            this._clipboard.setContent(COPIED_FILES,
                new GLib.Bytes(new TextEncoder().encode(copiedFilesText(entry))));
        } else {
            let bytes;
            try {
                bytes = await this._store.readImage(entry.file);
            } catch (e) {
                // Its file is gone (e.g. deleted by hand): drop the entry.
                this._ownCopy = null;
                await this.remove(id);
                return false;
            }
            this._clipboard.setContent(entry.mime, bytes);
        }
        return true;
    }

    /**
     * "Paste as plain text": puts the current text back without its
     * formatting, so the next paste anywhere is plain. Froonty never pastes
     * by itself (review guidelines).
     */
    copyAsPlainText() {
        const entry = this.entries.find(e => e.id === this.currentId);
        if (!entry || entry.kind !== 'text' || !this.currentFormatted)
            return false;
        this._ownCopy = true;
        this._clipboard.setText(entry.text);
        return true;
    }

    async remove(id) {
        if (this.password?.id === id) {
            this._dropPassword();
            this.emit('changed');
            return;
        }
        const entry = this.entries.find(e => e.id === id);
        if (!entry)
            return;
        this.entries = this.entries.filter(e => e.id !== id);
        if (this.currentId === id)
            this.currentId = null;
        this.emit('changed');
        await this._store.save(this.entries);
        await this._store.removeImagesOf([entry]);
    }

    /** Forgets everything: the list and its files. The clipboard itself is left alone. */
    async clear() {
        this._dropPassword();
        this.entries = [];
        this.currentId = null;
        this.emit('changed');
        await this._store.clear();
    }

    _limit() {
        return this._settings.get_int(LIMIT_KEY);
    }

    async _trim() {
        const {entries, dropped} = trim(this.entries, this._limit());
        if (!dropped.length)
            return;
        this.entries = entries;
        if (dropped.some(e => e.id === this.currentId))
            this.currentId = null;
        this.emit('changed');
        await this._store.save(entries);
        await this._store.removeImagesOf(dropped);
    }

    // The clipboard was emptied (a password manager clearing it, or the
    // app that copied quitting): a hidden password goes with it.
    _onCleared() {
        this._seq++;
        this.currentFormatted = false;
        this._ownCopy = null;
        this._dropPassword();
        this.currentId = null;
        this.emit('changed');
    }

    _dropPassword() {
        if (this._expiryId)
            this._timer.remove(this._expiryId);
        this._expiryId = 0;
        if (this.password && this.currentId === this.password.id)
            this.currentId = null;
        this.password = null;
    }

    _minutes() {
        return this._settings.get_int(PASSWORD_MINUTES_KEY);
    }

    _rescheduleExpiry() {
        if (!this.password)
            return;
        if (this._expiryId)
            this._timer.remove(this._expiryId);
        this._expiryId = 0;
        this.password.expiresAt = this.password.time + this._minutes() * 60 * 1000;
        const left = this.password.expiresAt - this._now();
        if (left <= 0) {
            this._dropPassword();
        } else {
            this._expiryId = this._timer.add(left, () => {
                this._expiryId = 0;
                this._dropPassword();
                this.emit('changed');
            });
        }
        this.emit('changed');
    }

    async _capture() {
        const seq = ++this._seq;
        this.currentFormatted = false;
        const own = this._ownCopy;
        this._ownCopy = null;
        // Anything copied replaces a hidden password, except putting that
        // same password back from the tab.
        if (!own?.password)
            this._dropPassword();
        try {
            await this._loading;
            const entry = await this._read(own, seq);
            if (this._destroyed || seq !== this._seq)
                return;
            if (entry.password) {
                this._showPassword(entry);
                return;
            }
            if (!entry.kept) {
                this.currentId = null;
                this.lastSkip = entry.reason;
                this.emit('changed');
                return;
            }
            await this._keep(entry.entry, entry.bytes, entry.formatted);
        } catch (e) {
            // A copy that cannot be read (its app quit meanwhile) is not kept.
            if (!this._destroyed && seq === this._seq) {
                this.currentId = null;
                this.emit('changed');
            }
        }
    }

    // A password: hidden for clipboard-password-minutes, or not at all.
    _showPassword({text, hash, reason, time}) {
        if (this.password?.hash === hash) {
            // The same password, put back from the tab.
            this.currentId = this.password.id;
            this.emit('changed');
            return;
        }
        this._dropPassword();
        if (this._minutes() <= 0) {
            this.currentId = null;
            this.lastSkip = reason;
            this.emit('changed');
            return;
        }
        this.password = {id: newId(time), kind: 'password', time, expiresAt: 0, hash, text, reason};
        this.currentId = this.password.id;
        this.lastSkip = null;
        this._rescheduleExpiry();
    }

    // What the clipboard holds now, as an entry to keep, a password, or why not.
    async _read(own, seq) {
        const skip = reason => ({kept: false, reason});
        const mimetypes = this._clipboard.mimetypes();
        const decision = classify(mimetypes, {
            names: own ? [] : this._focusedApp(),
            ignored: this._settings.get_strv(IGNORED_KEY),
        });
        if (decision.action === 'skip')
            return skip(decision.reason);

        const time = this._now();
        const base = {id: newId(time), time};
        if (decision.action === 'text' || decision.action === 'password') {
            const text = await this._clipboard.text();
            if (!text?.trim())
                return skip('empty');
            if (text.length > MAX_TEXT_LENGTH)
                return skip('too-large');
            const hash = checksum(text);
            const password = {password: true, text, hash: `password:${hash}`, time};
            if (decision.action === 'password')
                return {...password, reason: decision.reason};
            if (own?.password === password.hash)
                return {...password, reason: this.password?.reason ?? 'looks'};
            // A pick from the history stays history, whatever it looks like.
            if (own !== true && this._settings.get_boolean(DETECT_KEY) && looksLikePassword(text))
                return {...password, reason: 'looks'};
            return {
                kept: true,
                formatted: isFormatted(mimetypes),
                entry: {...base, kind: 'text', hash: `text:${hash}`, text},
            };
        }

        const bytes = await this._clipboard.content(decision.mime);
        if (!bytes || bytes.get_size() === 0)
            return skip('empty');
        if (seq !== this._seq)
            return skip('superseded');
        if (decision.action === 'files') {
            const files = parseFiles(new TextDecoder().decode(bytes.toArray()), decision.mime);
            if (!files)
                return skip('empty');
            return {
                kept: true,
                entry: {
                    ...base, kind: 'files', ...files,
                    hash: `files:${checksum([files.operation, ...files.uris].join('\n'))}`,
                },
            };
        }
        if (bytes.get_size() > MAX_IMAGE_BYTES)
            return skip('too-large');
        return {
            kept: true,
            bytes,
            entry: {
                ...base, kind: 'image', mime: decision.mime, size: bytes.get_size(),
                file: `${base.id}.${imageExtension(decision.mime)}`,
                hash: `image:${bytesChecksum(bytes)}`,
            },
        };
    }

    async _keep(entry, bytes, formatted = false) {
        const known = this.entries.some(e => e.hash === entry.hash);
        // A new image is on disk before the history names it.
        if (entry.kind === 'image' && !known)
            await this._store.writeImage(entry.file, bytes);
        if (this._destroyed)
            return;
        const {entries, top, dropped} = addEntry(this.entries, entry, this._limit());
        this.entries = entries;
        this.currentId = top.id;
        this.currentFormatted = formatted;
        this.lastSkip = null;
        this.emit('changed');
        await this._store.save(entries);
        await this._store.removeImagesOf(dropped);
    }
}
