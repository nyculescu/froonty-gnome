// SPDX-License-Identifier: GPL-3.0-or-later
// The "All notes" page's note pane (settings window; GTK 4 + libadwaita, so
// nothing from the Shell side): the open note's header (colour, name,
// labels, a Labels menu and the fold button), the island's formatting bar
// and the note, drawn rendered (allNotesStyler.js) to read and copy, or as
// its Markdown source, to edit with undo (MD).
//
//   ● Plan                       q4 · work  [Labels ▾] [⤴]
//   [B][I][S][H][•][1.][☑][</>][🔗][🖼][MD][↩]           formatting bar
//   ┌────────────────────────────────────────────────────┐
//   │ Q4 plan                                            │  matches of the
//   │ Ship the café menu by **Friday**                   │  search marked
//   └────────────────────────────────────────────────────┘
//
// The bar edits the source as one user action (one undo step), saved like
// typing; its toggles follow the cursor. Wrap lines (notes-wrap), MD
// (notes-markdown-source) and the fold button (notes-show-tools) are the
// island's settings, so both editors look alike. The buttons that edit are
// insensitive while rendered and on a read-only note; in the rendered view,
// task checks toggle, a click edits a paragraph in place and Edit table a
// table (allNotesStyler.js), each one user action too.
//
// Keyboard shortcuts (formatActions.js), as note.bold, …: the bar's edits
// (Ctrl+B, …) in the source of an editable note and in a field open in the
// rendered view; note.markdown (Ctrl+Shift+M) switches MD whenever a note
// is shown.
//
// An image pasted (one on the clipboard with no text, as a browser's Copy
// image puts it) into the source or a field is saved beside the note
// ("pasted-2026-10-16-1405.png") and referenced at the cursor.
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
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {FormatBar} from './allNotesFormatBar.js';
import {bufferState, editBuffer, insertAtCursor, MarkdownStyler, replaceText} from './allNotesStyler.js';
import {formatActions, formatShortcut} from './formatActions.js';
import * as Labels from './labels.js';
import {NoteWriter} from './noteWriter.js';
import {markdownImagePath} from './renderer/imageFile.js';
import {chooseImage, copyImage, saveImageBytes} from './renderer/image-picker.js';
import {charOffsets, toggleTask} from './render.js';
import * as Md from './markdown.js';
import {fold, rangesIn, terms} from './search.js';

Gio._promisify(Gdk.Clipboard.prototype, 'read_async');
Gio._promisify(Gdk.Clipboard.prototype, 'read_texture_async');
Gio._promisify(Gio.OutputStream.prototype, 'splice_async');

const isError = (e, code) => e?.matches?.(Gio.IOErrorEnum, code) ?? false;

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const TEXT_TYPES = ['text/plain', 'text/plain;charset=utf-8', 'UTF8_STRING'];

// The image on `clipboard` when it holds one and no text: a promise of
// {bytes (GLib.Bytes), mime}, the bytes as copied when notes take their
// type (PNG, JPEG, GIF, WebP), else the picture as PNG; null otherwise (a
// text paste).
function pastedImageData(clipboard) {
    const formats = clipboard.get_formats();
    if (formats.contain_gtype(GObject.TYPE_STRING) || TEXT_TYPES.some(type => formats.contain_mime_type(type)))
        return null;
    const mime = IMAGE_TYPES.find(type => formats.contain_mime_type(type));
    if (mime) {
        return clipboard.read_async([mime], GLib.PRIORITY_DEFAULT, null).then(async ([stream]) => {
            const output = Gio.MemoryOutputStream.new_resizable();
            await output.splice_async(stream, Gio.OutputStreamSpliceFlags.CLOSE_SOURCE |
                Gio.OutputStreamSpliceFlags.CLOSE_TARGET, GLib.PRIORITY_DEFAULT, null);
            return {bytes: output.steal_as_bytes(), mime};
        });
    }
    if (formats.contain_gtype(Gdk.Texture.$gtype)) {
        return clipboard.read_texture_async(null)
            .then(texture => ({bytes: texture.save_to_png_bytes(), mime: 'image/png'}));
    }
    return null;
}

// ⤴ / ⤵: the island's bundled symbolic icons, by path.
const foldIcon = name => new Gio.FileIcon({
    file: Gio.File.new_for_uri(import.meta.url).get_parent()
        .get_child('icons').get_child(`froonty-fold-${name}-symbolic.svg`),
});

export class NotePane {
    /**
     * @param {NotesLibrary} library
     * @param {Gio.Settings} settings
     * @param {object} callbacks
     * @param {Function} callbacks.onConflict (name, copy) ours was kept as `copy`
     * @param {Function} callbacks.onRescued (name, copy) text that could not
     *   be saved in the previous folder was kept as `copy` in the new one
     * @param {Function} callbacks.onError (message)
     * @param {Function} callbacks.onRename (name, text) the title was edited
     */
    constructor(library, settings, {onConflict, onRescued, onError, onRename}) {
        this._library = library;
        this._settings = settings;
        this._onConflict = onConflict;
        this._onRescued = onRescued;
        this._onError = onError;
        this._onRename = onRename;
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

        // The formatting buttons edit only an open, editable note's source,
        // and light only then.
        const syncEditable = () => {
            this._formatBar.setEditable(this._editing());
            this._syncFormatState();
        };
        this._stack.connect('notify::visible-child-name', syncEditable);
        this._view.connect('notify::editable', syncEditable);
        this._formatBar.markdownButton.connect('notify::active', syncEditable);
        syncEditable();

        // Undo and redo in both views (a task ticked in the rendered one is
        // an edit too). The source view has Ctrl+Z and Ctrl+Shift+Z itself.
        const actions = new Gio.SimpleActionGroup();
        for (const name of ['undo', 'redo']) {
            const action = new Gio.SimpleAction({name});
            action.connect('activate', () => {
                if (this.name !== null && this._view.editable)
                    this._buffer[name]();
            });
            actions.add_action(action);
        }
        // The bar's edits: on an open field, else on the source (MD) of an
        // editable note (_applyEdit). MD keeps the keys in the note.
        for (const {id, edit} of formatActions(_)) {
            const action = new Gio.SimpleAction({name: id});
            action.connect('activate', () => {
                if (!this._styler.editField(edit))
                    this._applyEdit(edit);
            });
            actions.add_action(action);
        }
        const markdown = new Gio.SimpleAction({name: 'markdown'});
        markdown.connect('activate', () => {
            if (this.name === null)
                return;
            const source = this._formatBar.markdownButton;
            source.active = !source.active;
            if (source.active)
                this._view.grab_focus();
            else
                this._styler.focusRendered();
        });
        actions.add_action(markdown);
        this._stack.insert_action_group('note', actions);
        const shortcuts = new Gtk.ShortcutController();
        for (const [trigger, name] of [['<Control>z', 'undo'], ['<Control><Shift>z', 'redo'], ['<Control>y', 'redo']]) {
            shortcuts.add_shortcut(new Gtk.Shortcut({
                trigger: Gtk.ShortcutTrigger.parse_string(trigger),
                action: Gtk.NamedAction.new(`note.${name}`),
            }));
        }
        this._stack.add_controller(shortcuts);
        // The formatting shortcuts, from the note's views and fields only
        // (not the title or the Labels menu). A key controller, not
        // shortcut triggers: a shifted digit (Ctrl+Shift+8) is matched by
        // its key, whose keyval is the layout's symbol (formatShortcut).
        const formatKeys = new Gtk.EventControllerKey();
        formatKeys.connect('key-pressed', (_controller, keyval, keycode, state) => {
            const shortcut = formatShortcut(keyval, keycode, state);
            if (!shortcut)
                return false;
            this._styler.widget.activate_action(`note.${shortcut}`, null);
            return true;
        });
        this._styler.widget.add_controller(formatKeys);
    }

    /** The writer for the library's current folder. */
    get writer() {
        return this._writer;
    }

    /** Saves unsaved edits now, an open field's too. @returns {Promise} */
    flush() {
        this._styler.endEditing(true);
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
     * Marks the matches of a search in the note, in both views, and
     * scrolls them to the first.
     *
     * @returns {?number} character offset of the first match
     */
    highlight(query) {
        this._query = query ?? '';
        const buffer = this._buffer;
        buffer.remove_tag(this._matchTag, buffer.get_start_iter(), buffer.get_end_iter());
        const words = this.name === null ? [] : terms(this._query);
        const text = buffer.text;
        const ranges = rangesIn(fold(text), words);
        this._styler.setMatches(ranges);
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

    /**
     * Enter in the search: into the note, at the first match or the end.
     * Rendered, into the rendered view, which highlight() scrolled.
     */
    focusEditor() {
        if (this.name === null)
            return;
        const first = this.highlight(this._query);
        if (!this._formatBar.markdownButton.active) {
            this._styler.focusRendered();
            return;
        }
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

    _endRename(rename) {
        if (this._titleStack.visible_child_name !== 'entry')
            return;
        this._titleStack.visible_child_name = 'title';
        if (rename && this.name !== null && this._titleEntry.text !== this.name)
            this._onRename(this.name, this._titleEntry.text);
    }

    _buildHeader() {
        this._dot = new Gtk.Box({css_classes: ['froonty-dot'], valign: Gtk.Align.CENTER});
        this._title = new Gtk.Label({
            css_classes: ['title-4'],
            ellipsize: Pango.EllipsizeMode.END,
            xalign: 0,
            tooltip_text: _('Double-click to rename'),
        });
        // A double click renames, as on the island's tab: Enter or leaving
        // the entry renames, Escape does not.
        this._titleEntry = new Gtk.Entry();
        this._titleStack = new Gtk.Stack({hexpand: true});
        this._titleStack.add_named(this._title, 'title');
        this._titleStack.add_named(this._titleEntry, 'entry');
        const doubleClick = new Gtk.GestureClick();
        doubleClick.connect('pressed', (_gesture, presses) => {
            if (presses === 2 && this.name !== null && this._view.editable) {
                this._titleEntry.text = this.name;
                this._titleStack.visible_child_name = 'entry';
                this._titleEntry.grab_focus();
            }
        });
        this._title.add_controller(doubleClick);
        this._titleEntry.connect('activate', () => this._endRename(true));
        const leave = new Gtk.EventControllerFocus();
        // Once the focus has moved (GTK must not lose the entry meanwhile).
        leave.connect('leave', () => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._endRename(true);
            return GLib.SOURCE_REMOVE;
        }));
        this._titleEntry.add_controller(leave);
        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_controller, keyval) => {
            if (keyval !== Gdk.KEY_Escape)
                return false;
            this._endRename(false);
            return true;
        });
        this._titleEntry.add_controller(keys);
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
        this._header.append(this._titleStack);
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
        this._formatBar = new FormatBar(edit => this._applyEdit(edit), () => this._chooseImage());
        this._tools = new Gtk.Box({
            margin_start: 8,
            margin_end: 8,
            margin_bottom: 6,
        });
        this._tools.append(this._formatBar.widget);

        const wrap = this._formatBar.wrapButton;
        this._settings.bind('notes-wrap', wrap, 'active', Gio.SettingsBindFlags.DEFAULT);
        const applyWrap = () => this._styler.setWrap(wrap.active);
        wrap.connect('notify::active', applyWrap);
        applyWrap();

        const markdownSource = this._formatBar.markdownButton;
        this._settings.bind('notes-markdown-source', markdownSource, 'active', Gio.SettingsBindFlags.DEFAULT);
        markdownSource.connect('notify::active', () => this._styler.setRendered(!markdownSource.active));
        this._styler.setRendered(!markdownSource.active);

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


    // An open, editable note, shown as its source (MD).
    _editing() {
        return this.name !== null && this._stack.visible_child_name === 'note' &&
            this._view.editable && this._formatBar.markdownButton.active;
    }

    // Applies a markdown.js edit as one user action (one undo step; the
    // 'changed' handler saves it as it does typing), then the edit's
    // selection, and the focus back in the editor.
    _applyEdit(edit) {
        if (!this._editing()) {
            this._syncFormatState();
            return;
        }
        editBuffer(this._buffer, edit);
        this._view.grab_focus();
        this._syncFormatState();
    }

    // Toggles the task whose box is at character `offset`, if any; the
    // cursor stays. @returns {boolean} whether one was toggled
    _toggleTask(offset) {
        const replacement = toggleTask(this._buffer.text, offset);
        if (replacement === null || this.name === null || !this._view.editable)
            return false;
        const cursor = this._buffer.cursor_position;
        replaceText(this._buffer, replacement);
        this._buffer.place_cursor(this._buffer.get_iter_at_offset(Math.min(cursor,
            this._buffer.get_char_count())));
        return true;
    }

    // A direct edit in the rendered view: `text` over the source's [start,
    // end) (UTF-16 offsets), one user action; the cursor stays.
    _editRange(start, end, text) {
        if (this.name === null || !this._view.editable)
            return;
        const source = this._buffer.text;
        const cursor = this._buffer.cursor_position;
        replaceText(this._buffer, source.slice(0, start) + text + source.slice(end));
        this._buffer.place_cursor(this._buffer.get_iter_at_offset(Math.min(cursor,
            this._buffer.get_char_count())));
    }

    // The image on `clipboard` saved into the note's folder: a promise of
    // its Markdown reference (null when the note changed meanwhile or saving
    // failed); null when the clipboard holds no image.
    _pastedImage(clipboard) {
        const image = pastedImageData(clipboard);
        if (!image)
            return null;
        const note = this.name;
        const store = this._library.store;
        return (async () => {
            try {
                const {bytes, mime} = await image;
                if (this.name !== note || this._library.store !== store)
                    return null;
                const name = await saveImageBytes(bytes, mime, store.folder);
                return this.name === note ? `![](${markdownImagePath(name)})` : null;
            } catch (e) {
                this._onError(e.message);
                return null;
            }
        })();
    }

    async _chooseImage() {
        if (!this._editing())
            return;
        const note = this.name;
        const store = this._library.store;
        try {
            // Copied only if it is still to go into the same note.
            const path = await chooseImage();
            if (!path || this.name !== note || this._library.store !== store || !this._editing())
                return;
            const name = await copyImage(path, store.folder);
            if (this.name === note && this._editing())
                this._applyEdit(state => Md.insertImage(state, name));
        } catch (e) {
            this._onError(e.message);
        }
    }

    // Lights the formatting toggles for the cursor; none while the bar
    // cannot edit (rendered, read-only). Skipped while the bar is folded
    // away; unfolding calls it again.
    _syncFormatState() {
        if (this._tools?.visible)
            this._formatBar.update(this._editing() ? bufferState(this._buffer) : {text: '', start: 0, end: 0});
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
        this._buffer.enable_undo = true;
        this._buffer.max_undo_levels = 200;
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
            accepts_tab: true,
            left_margin: 12,
            right_margin: 12,
            top_margin: 12,
            bottom_margin: 12,
        });
        // An image pasted into the source goes in at the cursor.
        this._view.connect('paste-clipboard', view => {
            const markdown = this._editing() ? this._pastedImage(view.get_clipboard()) : null;
            if (!markdown)
                return;
            view.stop_emission_by_name('paste-clipboard');
            markdown.then(reference => {
                if (reference && this._editing())
                    insertAtCursor(this._buffer, reference);
            });
        });
        this._styler = new MarkdownStyler(this._view,
            () => this._library.store?.folder ?? this._library.folder,
            () => this.name, {
                onToggleTask: offset => this._toggleTask(offset),
                onEdit: (start, end, text) => this._editRange(start, end, text),
                onPasteImage: clipboard => this._pastedImage(clipboard),
            });
        this._matchTag = new Gtk.TextTag({
            name: 'froonty-match',
            background: '#f6d32d',
            foreground: '#1f1f1f',
        });
        this._buffer.get_tag_table().add(this._matchTag);
        this._matchMark = this._buffer.create_mark(null, this._buffer.get_start_iter(), true);
        this._scroll = this._styler.widget;
    }
}
