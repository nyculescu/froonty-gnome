// SPDX-License-Identifier: GPL-3.0-or-later
// Notes tab:
//
//   [2026-09-28 15.40 ×] [Plan] [+]          capsule tabs
//   [B][I][S][H][•][1.][☑][</>][🔗]          formatting bar
//   ┌──────────────────────────────────┐
//   │ editor                           │     multi-line, scrolls
//   └──────────────────────────────────┘
//
// Renders NotesService state; typing goes to service.setText().

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ColorPicker} from './colorPicker.js';
import {COLOR_IDS} from './colors.js';
import {FormatBar} from './formatBar.js';
import {NoteTabs} from './tabs.js';

export class NotesView {
    constructor(ctx, service) {
        this._service = service;
        this._settings = ctx.settings;

        // Content, plus an overlay layer (fixed positions, click-through) for
        // the tab name bubble.
        //
        // Content is a grid: header (tabs, tools) in row 0, editor in row 1.
        // The editor is added first so it is drawn *below* the header. A long
        // scrolled note is one tall actor reaching up behind the header, and
        // Clutter only re-checks what is under the pointer once it leaves the
        // hit actor's area minus actors drawn above it; drawn above the
        // header, the editor kept receiving clicks meant for tabs and tools.
        const grid = new Clutter.GridLayout({orientation: Clutter.Orientation.VERTICAL});
        this._content = new St.Widget({
            style_class: 'froonty-notes',
            layout_manager: grid,
            x_expand: true,
            y_expand: true,
        });
        const overlay = new St.Widget({x_expand: true, y_expand: true});
        this.actor = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this.actor.add_child(this._content);
        this.actor.add_child(overlay);

        this._tabs = new NoteTabs({
            onSelect: async name => {
                await service.select(name);
                this._focusEditor();
            },
            onCreate: () => this._create(),
            onRename: async name => {
                await service.rename(name);
                this._sync(); // also restores the tab if the name was refused
            },
            onTrash: name => service.trash(name),
        });
        this._formatBar = new FormatBar(edit => this._applyEdit(edit));
        this._colorPicker = new ColorPicker({
            onPick: color => service.setColor(color),
            // The swatches take the formatting bar's place while open.
            onOpenChanged: open => (this._formatBar.actor.visible = !open),
        });
        this._tools = new St.BoxLayout({style_class: 'froonty-notes-tools'});
        this._tools.add_child(this._formatBar.actor);
        this._tools.add_child(this._colorPicker.swatches);
        this._tools.add_child(new St.Widget({x_expand: true}));
        this._tools.add_child(this._colorPicker.button);
        this._buildEditor();
        this._buildEmptyState();
        this._error = new St.Label({style_class: 'froonty-notes-error', visible: false});

        const editorArea = new St.BoxLayout({
            style_class: 'froonty-notes-editor-area',
            vertical: true,
            x_expand: true,
            y_expand: true,
        });
        editorArea.add_child(this._scroll);
        editorArea.add_child(this._empty);
        editorArea.add_child(this._error);
        const header = new St.BoxLayout({style_class: 'froonty-notes-header', vertical: true});
        header.add_child(this._tabs.actor);
        header.add_child(this._tools);
        grid.attach(editorArea, 0, 1, 1, 1); // first: drawn below the header
        grid.attach(header, 0, 0, 1, 1);
        overlay.add_child(this._tabs.tooltip);

        // Wrap toggle (formatting bar) ↔ notes-wrap setting ↔ editor.
        this._settings.bind('notes-wrap', this._formatBar.wrapButton, 'checked',
            Gio.SettingsBindFlags.DEFAULT);
        this._wrapId = this._settings.connect('changed::notes-wrap', () => this._applyWrap());
        this._applyWrap();

        this._changedId = service.connect('changed', () => this._sync());
        this._sync();
    }

    destroy() {
        this._settings.disconnect(this._wrapId);
        Gio.Settings.unbind(this._formatBar.wrapButton, 'checked');
        this._service.disconnect(this._changedId);
        this.actor.destroy();
    }

    // Shown: typing goes straight into the note (Escape still collapses).
    setActive(active) {
        if (!active)
            return;
        this._focusEditor();
    }

    async _create() {
        await this._service.create();
        this._focusEditor();
    }

    _focusEditor() {
        if (this._service.selected !== null && this._scroll.visible)
            this._entry.clutter_text.grab_key_focus();
    }

    _buildEditor() {
        // Natural height at the top: St.Entry centers its text vertically,
        // which would float a short note in the middle of a tall editor.
        this._entry = new St.Entry({
            style_class: 'froonty-notes-editor',
            hint_text: _('Type anything. It saves by itself.'),
            can_focus: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
        });
        const text = this._entry.clutter_text;
        text.single_line_mode = false;
        text.activatable = false;
        text.line_wrap = true;
        text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        text.connect('text-changed', () => {
            if (!this._settings.get_boolean('notes-wrap'))
                this._syncNoWrapWidth();
            if (!this._syncing)
                this._service.setText(text.text);
        });
        text.connect('cursor-changed', () => this._keepCursorVisible());

        // St.Entry is not scrollable itself; a BoxLayout is. A click on the
        // box below the text (or on the entry's padding) focuses the editor
        // with the cursor at the end, like a text area.
        const box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            reactive: true,
        });
        box.add_child(this._entry);
        box.connect('button-press-event', () => {
            text.grab_key_focus();
            text.set_cursor_position(-1);
            text.set_selection_bound(-1);
            return Clutter.EVENT_STOP;
        });
        this._scroll = new St.ScrollView({
            style_class: 'froonty-notes-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            child: box,
        });
    }

    _buildEmptyState() {
        const button = new St.Button({
            style_class: 'froonty-notes-new',
            label: _('New note'),
            can_focus: true,
        });
        button.connect('clicked', () => this._create());
        this._empty = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._empty.add_child(new St.Label({
            style_class: 'froonty-notes-empty',
            text: _('No notes yet'),
            x_align: Clutter.ActorAlign.CENTER,
        }));
        this._empty.add_child(button);
    }

    _sync() {
        const {notes, selected, text, error} = this._service;
        const hasNote = selected !== null;

        this._tabs.update(notes, selected, name => this._service.colorOf(name));
        this._tools.visible = hasNote;
        if (!hasNote)
            this._colorPicker.setOpen(false);
        this._colorPicker.setColor(this._service.color);
        this._setTint(this._service.color);
        this._scroll.visible = hasNote;
        this._empty.visible = !hasNote;
        this._error.text = error ?? '';
        this._error.visible = Boolean(error);

        // Only replace the text when the service loaded something else;
        // never while it matches what the user is typing.
        if (this._entry.text !== text) {
            this._syncing = true;
            this._entry.text = text;
            this._syncing = false;
        }
    }

    // The editor surface takes the note's colour (stylesheet.css).
    _setTint(color) {
        for (const id of COLOR_IDS)
            this._scroll.remove_style_class_name(`froonty-note-color-${id}`);
        this._scroll.add_style_class_name(`froonty-note-color-${color}`);
    }

    // Applies a markdown.js edit to the editor text and selection.
    _applyEdit(edit) {
        const text = this._entry.clutter_text;
        const cursor = text.cursor_position;
        const bound = text.selection_bound;
        // -1 means "end of text" for both.
        const length = [...text.text].length;
        const position = p => (p < 0 ? length : p);

        const result = edit({text: text.text, start: position(bound), end: position(cursor)});
        text.text = result.text;
        text.set_selection(result.start, result.end);
        this._entry.grab_key_focus();
    }

    // Wrapped: long lines wrap. Unwrapped: they stay on one line and the
    // note scrolls horizontally.
    _applyWrap() {
        const wrap = this._settings.get_boolean('notes-wrap');
        this._entry.clutter_text.line_wrap = wrap;
        this._scroll.hscrollbar_policy = wrap ? St.PolicyType.NEVER : St.PolicyType.AUTOMATIC;
        this._syncNoWrapWidth();
        this._keepCursorVisible();
    }

    // A scrolled view sizes its content by its minimum width, and
    // Clutter.Text reports ~1px even when it does not wrap, so unwrapped
    // lines would still be squeezed into the viewport. Pin the minimum to
    // the natural width while unwrapped (after each text change).
    _syncNoWrapWidth() {
        this._entry.min_width_set = false;
        if (!this._settings.get_boolean('notes-wrap'))
            this._entry.min_width = this._entry.get_preferred_width(-1)[1];
    }

    _keepCursorVisible() {
        const text = this._entry.clutter_text;
        const [ok, x, y, lineHeight] = text.position_to_coords(text.cursor_position);
        if (!ok)
            return;

        // Horizontally too, when lines do not wrap (a small margin keeps the
        // caret off the very edge).
        const h = this._scroll.hadjustment;
        const margin = lineHeight;
        if (x < h.value)
            h.value = Math.max(0, x - margin);
        else if (x + margin > h.value + h.page_size)
            h.value = x + margin - h.page_size;

        const adjustment = this._scroll.vadjustment;
        const top = adjustment.value;
        const bottom = top + adjustment.page_size;
        if (y < top)
            adjustment.value = y;
        else if (y + lineHeight > bottom)
            adjustment.value = y + lineHeight - adjustment.page_size;
    }
}
