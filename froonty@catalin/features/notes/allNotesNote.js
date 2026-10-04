// SPDX-License-Identifier: GPL-3.0-or-later
// The "All notes" page's note pane (settings window; GTK 4 + libadwaita, so
// nothing from the Shell side): the open note's header (colour, name,
// labels, a Labels menu and the fold button), the island's formatting bar
// and a plain-text Markdown editor with undo.
//
//   ● Plan                       q4 · work  [Labels ▾] [⤴]
//   [B][I][S][H][•][1.][☑][</>][🔗][↩]                     formatting bar
//   ┌────────────────────────────────────────────────────┐
//   │ # Q4 plan                                          │  matches of the
//   │ Ship the café menu by Friday                       │  search marked
//   └────────────────────────────────────────────────────┘
//
// The bar edits the buffer as one user action (one undo step), saved like
// typing; its toggles follow the cursor. Wrap lines (notes-wrap) and the
// fold button (notes-show-tools) are the island's settings, so both
// editors look alike. A read-only note leaves the formatting buttons
// insensitive.
//
// Saving goes through a NoteWriter, as in the island: after a pause in
// typing, never over a version changed elsewhere (ours is then kept as
// "<name> (conflict)", and the pane follows it). It also saves when another
// note is picked, when the page or the window is left, and on close. A note
// whose save failed stays open until it can be saved. A note that is not
// plain UTF-8 text is shown read-only (store.js decodeNote).
//
// The writer belongs to one folder (the library's store). When the library
// moves to another folder, the open note is saved in its own folder and
// closed (followFolder); text that cannot be saved there is kept as a copy
// in the new folder.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {FormatBar} from './allNotesFormatBar.js';
import * as Labels from './labels.js';
import {NoteWriter} from './noteWriter.js';
import {fold, sourceRange, terms} from './search.js';

const isError = (e, code) => e?.matches?.(Gio.IOErrorEnum, code) ?? false;

// ⤴ / ⤵: the island's bundled symbolic icons, by path.
const foldIcon = name => new Gio.FileIcon({
    file: Gio.File.new_for_uri(import.meta.url).get_parent()
        .get_child('icons').get_child(`froonty-fold-${name}-symbolic.svg`),
});

// UTF-16 indices of `text` → character offsets (what GtkTextIter counts).
function charOffsets(text, indices) {
    const wanted = [...new Set(indices)].sort((a, b) => a - b);
    const offsets = new Map();
    let chars = 0;
    let at = 0;
    for (const index of wanted) {
        for (; at < index; at++) {
            const code = text.charCodeAt(at);
            // A low surrogate continues the character before it.
            if (code < 0xDC00 || code > 0xDFFF)
                chars++;
        }
        offsets.set(index, chars);
    }
    return offsets;
}

export class NotePane {
    /**
     * @param {NotesLibrary} library
     * @param {Gio.Settings} settings
     * @param {object} callbacks
     * @param {Function} callbacks.onConflict (name, copy) ours was kept as `copy`
     * @param {Function} callbacks.onRescued (name, copy) text that could not
     *   be saved in the previous folder was kept as `copy` in the new one
     * @param {Function} callbacks.onError (message)
     */
    constructor(library, settings, {onConflict, onRescued, onError}) {
        this._library = library;
        this._settings = settings;
        this._onConflict = onConflict;
        this._onRescued = onRescued;
        this._onError = onError;
        this._writer = null;
        this._writerStore = null;
        this._showing = 0;
        this._syncing = false;
        this._query = '';
        /** The note shown, or null. */
        this.name = null;

        this._buildHeader();
        this._buildEditor();
        this._buildTools();
        this._stack = new Gtk.Stack({hexpand: true, vexpand: true});
        // Not plain UTF-8 text: shown, never written.
        this._readOnlyBanner = new Adw.Banner({
            title: _('Not plain UTF-8 text: read-only here, so that saving cannot damage it'),
        });
        const note = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        note.append(this._header);
        note.append(this._tools);
        note.append(new Gtk.Separator());
        note.append(this._readOnlyBanner);
        note.append(this._scroll);
        this._stack.add_named(note, 'note');
        this._stack.add_named(new Adw.StatusPage({
            icon_name: 'document-edit-symbolic',
            title: _('Select a note'),
        }), 'empty');
        this._stack.add_named(new Adw.StatusPage({
            icon_name: 'user-trash-symbolic',
            title: _('Moved to the Trash or renamed outside Froonty'),
        }), 'gone');
        this._stack.visible_child_name = 'empty';
        this.widget = this._stack;

        // The formatting buttons edit only an open, editable note.
        const syncEditable = () => this._formatBar.setEditable(
            this.name !== null && this._stack.visible_child_name === 'note' && this._view.editable);
        this._stack.connect('notify::visible-child-name', syncEditable);
        this._view.connect('notify::editable', syncEditable);
        syncEditable();
    }

    /** The writer for the library's current folder. */
    get writer() {
        return this._writer;
    }

    /** Saves unsaved edits now. @returns {Promise} */
    flush() {
        return this._writer?.flush() ?? Promise.resolve();
    }

    /**
     * Shows note `name` (null: none), after saving the one shown.
     *
     * @returns {Promise<?boolean>} true when shown; false when the shown
     *   note could not be saved (it stays, with its error) or `name` could
     *   not be read; null when another show() came after this one
     */
    async show(name) {
        this.followFolder();
        if (name === this.name && this._stack.visible_child_name === 'note')
            return true;
        const showing = ++this._showing;
        await this.flush();
        if (showing !== this._showing)
            return null;
        // Not saved (the write failed): it stays open, with its error.
        if (this._writer?.dirty)
            return false;
        if (name === null) {
            this.name = null;
            this._stack.visible_child_name = 'empty';
            return true;
        }
        let read;
        try {
            read = await this._library.store.readTagged(name);
        } catch (e) {
            if (showing !== this._showing)
                return null;
            this.name = null;
            this._stack.visible_child_name = isError(e, Gio.IOErrorEnum.NOT_FOUND) ? 'gone' : 'empty';
            if (!isError(e, Gio.IOErrorEnum.NOT_FOUND))
                this._onError(e.message);
            return false;
        }
        if (showing !== this._showing)
            return null;
        if (this._writer?.dirty)
            return false; // typed into the shown note meanwhile
        this._ensureWriter().open(name, read.text, read.etag, {readOnly: read.readOnly !== null});
        this.name = name;
        this._setText(read.text, 0);
        this._view.editable = read.readOnly === null;
        this._readOnlyBanner.revealed = read.readOnly !== null;
        this._stack.visible_child_name = 'note';
        this.sync();
        this.highlight(this._query);
        return true;
    }

    /**
     * The library is in another folder than the open note's (the setting
     * changed): that note is saved in its own folder and closed. Text that
     * cannot be saved there is kept as a copy in the new folder
     * (onRescued). Nothing to do while the folder is the same.
     *
     * @returns {boolean} whether the pane was cleared
     */
    followFolder() {
        const store = this._library.store;
        if (!this._writer || !store || this._writerStore === store)
            return false;
        const old = this._writer;
        this._writer = null;
        this._writerStore = null;
        this._showing++; // a show() on its way read the old folder
        this.name = null;
        this._stack.visible_child_name = 'empty';
        old.stop().then(async () => {
            if (!old.dirty)
                return;
            try {
                const copy = await store.saveCopy(old.name, old.text);
                this._onRescued(old.name, copy.name);
            } catch (e) {
                this._onError(e.message);
            }
        });
        return true;
    }

    /** The library changed: header, and the note if changed elsewhere. */
    async libraryChanged({names}) {
        if (this.followFolder())
            return;
        this.sync();
        if (this.name === null || !names.includes(this.name))
            return;
        const writer = this._writer;
        const name = this.name;
        if (!writer || writer.dirty || writer.busy)
            return;
        const revision = writer.revision;
        let read;
        try {
            read = await this._library.store.readTagged(name);
        } catch {
            return; // gone: 'removed' says so
        }
        // Typed or saved meanwhile: the typing wins.
        if (name !== this.name || writer.dirty || writer.busy || writer.revision !== revision)
            return;
        const readOnly = read.readOnly !== null;
        if (read.text === this._buffer.text && readOnly === writer.readOnly) {
            writer.adopt(read.text, read.etag);
            return;
        }
        writer.open(name, read.text, read.etag, {readOnly});
        this._setText(read.text, this._buffer.cursor_position);
        this._view.editable = !readOnly;
        this._readOnlyBanner.revealed = readOnly;
        this.highlight(this._query);
    }

    /** A rename in the folder: the editor follows its note. */
    renamed(from, to) {
        if (this.followFolder() || this.name !== from)
            return;
        this.name = to;
        if (this._writer?.name === from)
            this._writer.renamed(to, this._writer.etag);
        this.sync();
    }

    /** A note is gone from the folder. */
    async removed(name) {
        if (this.followFolder() || this.name !== name || !this._writer)
            return;
        await this._writer.idle();
        if (this.name !== name)
            return;
        if (this._writer.dirty) {
            await this._writer.saveAsCopy(); // 'conflict' selects the copy
            return;
        }
        try {
            await this._library.store.etagOf(name);
            return; // made again meanwhile (our own last write)
        } catch {}
        if (this.name === name) {
            this.name = null;
            this._stack.visible_child_name = 'gone';
        }
    }

    /** Header: colour, name, labels; the Labels menu if open. */
    sync() {
        const name = this.name;
        if (name === null)
            return;
        const color = this._library.colorOf(name);
        this._dot.css_classes = ['froonty-dot', `froonty-dot-${color}`];
        this._title.label = name;
        const labels = this._library.labelsOf(name);
        this._labelsCaption.label = labels.join(' · ');
        this._labelsCaption.visible = labels.length > 0;
        this._labelsButton.sensitive = this._library.labelsState !== 'unreadable';
        if (this._labelsPopover.visible)
            this._fillLabels();
    }

    /**
     * Marks the matches of a search in the note.
     *
     * @returns {?number} character offset of the first match
     */
    highlight(query) {
        this._query = query ?? '';
        const buffer = this._buffer;
        buffer.remove_tag(this._matchTag, buffer.get_start_iter(), buffer.get_end_iter());
        const words = terms(this._query);
        if (!words.length || this.name === null)
            return null;
        const text = buffer.text;
        const f = fold(text);
        const ranges = [];
        for (const word of words) {
            for (let at = f.folded.indexOf(word); at >= 0; at = f.folded.indexOf(word, at + word.length))
                ranges.push(sourceRange(f, at, at + word.length));
        }
        if (!ranges.length)
            return null;
        const offsets = charOffsets(text, ranges.flat());
        for (const [start, end] of ranges) {
            buffer.apply_tag(this._matchTag, buffer.get_iter_at_offset(offsets.get(start)),
                buffer.get_iter_at_offset(offsets.get(end)));
        }
        const first = Math.min(...ranges.map(([start]) => offsets.get(start)));
        buffer.move_mark(this._matchMark, buffer.get_iter_at_offset(first));
        this._view.scroll_to_mark(this._matchMark, 0.1, true, 0, 0.3);
        return first;
    }

    /** Enter in the search: into the note, at the first match or the end. */
    focusEditor() {
        if (this.name === null)
            return;
        const first = this.highlight(this._query);
        const buffer = this._buffer;
        buffer.place_cursor(first === null ? buffer.get_end_iter() : buffer.get_iter_at_offset(first));
        this._view.grab_focus();
        this._view.scroll_to_mark(buffer.get_insert(), 0.1, false, 0, 0);
    }

    /** The page or the window is closing. */
    stop() {
        return this._writer?.stop() ?? Promise.resolve();
    }

    _ensureWriter() {
        const store = this._library.store;
        if (this._writer && this._writerStore === store)
            return this._writer;
        this._writer?.stop();
        const writer = new NoteWriter(store);
        writer.connect('conflict', (_writer, {name, copy}) => {
            if (writer !== this._writer)
                return;
            if (writer.name === copy && this.name === name)
                this.name = copy;
            this.sync();
            this._onConflict(name, copy);
        });
        writer.connect('error', (_writer, e) => this._onError(e.message));
        this._writer = writer;
        this._writerStore = store;
        return writer;
    }

    // Loading a note or a reload is not an edit: undo never reaches back
    // into another note or another version.
    _setText(text, cursor) {
        const buffer = this._buffer;
        this._syncing = true;
        buffer.begin_irreversible_action();
        buffer.text = text;
        buffer.end_irreversible_action();
        this._syncing = false;
        buffer.place_cursor(buffer.get_iter_at_offset(Math.min(cursor, buffer.get_char_count())));
    }

    _buildHeader() {
        this._dot = new Gtk.Box({css_classes: ['froonty-dot'], valign: Gtk.Align.CENTER});
        this._title = new Gtk.Label({
            css_classes: ['title-4'],
            ellipsize: Pango.EllipsizeMode.END,
            xalign: 0,
            hexpand: true,
        });
        this._labelsCaption = new Gtk.Label({
            css_classes: ['dim-label', 'caption'],
            ellipsize: Pango.EllipsizeMode.END,
            max_width_chars: 30,
        });
        this._labelsPopover = new Gtk.Popover();
        this._labelsPopover.connect('show', () => {
            this._labelsFor = null; // a fresh order each time it opens
            this._fillLabels();
        });
        this._labelsButton = new Gtk.MenuButton({
            label: _('Labels'),
            valign: Gtk.Align.CENTER,
            popover: this._labelsPopover,
        });

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
        this._labelEntry = new Gtk.Entry({placeholder_text: _('Add a label…')});
        this._labelEntry.connect('activate', () => this._onLabelEnter());
        this._labelList = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        box.append(this._labelEntry);
        box.append(new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            propagate_natural_height: true,
            max_content_height: 240,
            child: this._labelList,
        }));
        this._labelsPopover.set_child(box);

        this._header = new Gtk.Box({
            spacing: 10,
            margin_start: 12,
            margin_end: 12,
            margin_top: 8,
            margin_bottom: 8,
        });
        this._header.append(this._dot);
        this._header.append(this._title);
        this._header.append(this._labelsCaption);
        this._header.append(this._labelsButton);

        // Folds the formatting bar away (notes-show-tools, as in the island).
        this._foldIcon = new Gtk.Image();
        this._foldButton = new Gtk.Button({
            child: this._foldIcon,
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        this._foldButton.connect('clicked', () => this._settings.set_boolean('notes-show-tools',
            !this._settings.get_boolean('notes-show-tools')));
        this._header.append(this._foldButton);
    }

    // The formatting bar, under the header: Wrap lines and the fold button
    // follow the island's settings.
    _buildTools() {
        this._formatBar = new FormatBar(edit => this._applyEdit(edit));
        this._tools = new Gtk.Box({
            margin_start: 8,
            margin_end: 8,
            margin_bottom: 6,
        });
        this._tools.append(this._formatBar.widget);

        const wrap = this._formatBar.wrapButton;
        this._settings.bind('notes-wrap', wrap, 'active', Gio.SettingsBindFlags.DEFAULT);
        const applyWrap = () => {
            this._view.wrap_mode = wrap.active ? Gtk.WrapMode.WORD_CHAR : Gtk.WrapMode.NONE;
            this._scroll.hscrollbar_policy = wrap.active
                ? Gtk.PolicyType.NEVER : Gtk.PolicyType.AUTOMATIC;
        };
        wrap.connect('notify::active', applyWrap);
        applyWrap();

        const up = foldIcon('up');
        const down = foldIcon('down');
        this._settings.bind('notes-show-tools', this._tools, 'visible', Gio.SettingsBindFlags.GET);
        const syncFold = () => {
            const shown = this._tools.visible;
            this._foldIcon.gicon = shown ? up : down;
            const name = shown ? _('Hide formatting tools') : _('Show formatting tools');
            this._foldButton.tooltip_text = name;
            this._foldButton.update_property([Gtk.AccessibleProperty.LABEL], [name]);
            this._syncFormatState();
        };
        this._tools.connect('notify::visible', syncFold);
        syncFold();
    }

    // The editor text and selection, as markdown.js takes them: character
    // offsets (code points, as GtkTextIter counts), start = the selection's
    // fixed end, end = the cursor.
    _editorState() {
        const buffer = this._buffer;
        const offset = mark => buffer.get_iter_at_mark(mark).get_offset();
        return {
            text: buffer.text,
            start: offset(buffer.get_selection_bound()),
            end: offset(buffer.get_insert()),
        };
    }

    // Applies a markdown.js edit: only the part of the text that changed is
    // replaced, as one user action (one undo step); the 'changed' handler
    // saves it as it does typing. Then the edit's selection, and the focus
    // back in the editor.
    _applyEdit(edit) {
        if (this.name === null || !this._view.editable) {
            this._syncFormatState();
            return;
        }
        const buffer = this._buffer;
        const result = edit(this._editorState());
        const before = [...buffer.text];
        const after = [...result.text];
        let head = 0;
        while (head < before.length && head < after.length && before[head] === after[head])
            head++;
        let tail = 0;
        while (tail < before.length - head && tail < after.length - head &&
            before[before.length - 1 - tail] === after[after.length - 1 - tail])
            tail++;
        if (before.length !== after.length || head < before.length) {
            buffer.begin_user_action();
            buffer.delete(buffer.get_iter_at_offset(head),
                buffer.get_iter_at_offset(before.length - tail));
            buffer.insert(buffer.get_iter_at_offset(head),
                after.slice(head, after.length - tail).join(''), -1);
            buffer.end_user_action();
        }
        buffer.select_range(buffer.get_iter_at_offset(result.end),
            buffer.get_iter_at_offset(result.start));
        this._view.grab_focus();
        this._syncFormatState();
    }

    // Lights the formatting toggles for the cursor. Skipped while the bar is
    // folded away; unfolding calls it again.
    _syncFormatState() {
        if (this._tools?.visible)
            this._formatBar.update(this._editorState());
    }

    // One check button per label: this note's first, then the others. The
    // order is set when the menu opens; while it is open, ticks follow the
    // file and new labels are added at the end.
    _fillLabels() {
        const name = this.name;
        if (name === null)
            return;
        const mine = this._library.labelsOf(name);
        const keys = new Set(mine.map(Labels.labelKey));
        const checks = [];
        for (let child = this._labelList.get_first_child(); child; child = child.get_next_sibling())
            checks.push(child);
        if (this._labelsFor !== name) {
            for (const check of checks)
                this._labelList.remove(check);
            checks.length = 0;
            this._labelsFor = name;
        }
        const shown = new Set(checks.map(check => Labels.labelKey(check.label)));
        const others = this._library.allLabels().map(({label}) => label)
            .filter(label => !keys.has(Labels.labelKey(label)));
        for (const label of [...mine, ...others]) {
            if (shown.has(Labels.labelKey(label)))
                continue;
            const check = new Gtk.CheckButton({label});
            check.connect('toggled', () => {
                if (!this._fillingLabels)
                    this._setLabel(name, label, check.active);
            });
            this._labelList.append(check);
            checks.push(check);
        }
        this._fillingLabels = true;
        for (const check of checks)
            check.active = keys.has(Labels.labelKey(check.label));
        this._fillingLabels = false;
    }

    // Enter: an existing label is turned on (never off), a new one added.
    _onLabelEnter() {
        const clean = Labels.cleanLabel(this._labelEntry.text);
        if (!clean || this.name === null)
            return;
        this._labelEntry.text = '';
        if (!this._library.labelsOf(this.name).some(l => Labels.labelKey(l) === Labels.labelKey(clean)))
            this._setLabel(this.name, clean, true);
    }

    async _setLabel(name, label, on) {
        try {
            await this._library.setLabel(name, label, on);
        } catch (e) {
            this._onError(e.message);
            this.sync();
        }
    }

    _buildEditor() {
        this._buffer = new Gtk.TextBuffer();
        this._matchTag = new Gtk.TextTag({
            name: 'froonty-match',
            background: '#f6d32d',
            foreground: '#1f1f1f',
        });
        this._buffer.get_tag_table().add(this._matchTag);
        this._matchMark = this._buffer.create_mark(null, this._buffer.get_start_iter(), true);
        this._buffer.connect('changed', () => {
            if (!this._syncing && this.name !== null)
                this._writer?.edited(this._buffer.text);
            this._syncFormatState();
        });
        // The cursor or the selection moved.
        this._buffer.connect('mark-set', (_buffer, _iter, mark) => {
            if (mark === this._buffer.get_insert() || mark === this._buffer.get_selection_bound())
                this._syncFormatState();
        });
        this._view = new Gtk.TextView({
            buffer: this._buffer,
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            left_margin: 12,
            right_margin: 12,
            top_margin: 12,
            bottom_margin: 12,
        });
        this._scroll = new Gtk.ScrolledWindow({
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            child: this._view,
        });
    }
}
