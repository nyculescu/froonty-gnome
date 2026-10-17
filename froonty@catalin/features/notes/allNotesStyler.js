// SPDX-License-Identifier: GPL-3.0-or-later
// The All notes editor drawn rendered: a read-only display copy of the
// source editor's text, in a view of its own, shown instead of the source
// unless MD is on. Block source is collapsed to one placeholder in that
// copy; the source buffer stays untouched and plain Markdown.
//
// Hidden markers are drawn transparent at a twentieth of the size, not with
// the tags' "invisible" property, so every character keeps a place: the
// task checks and block pictures over the text are placed at theirs.
// Copying a selection leaves them out.
//
// The muted colour (markers, quotes, done items) is a mid grey, which reads
// on light and dark styles alike; the window's editor has no note colour.
//
// A block that cannot be drawn says why, its Markdown under it (selectable);
// a drawn one that leaves something out says so in a dim line under it.
// A right click on a picture copies it, and for an image file also copies
// the original or shows it in Files; for a table it offers Edit table, for
// a diagram Copy Mermaid code (its code alone) and Edit Mermaid code. On
// code (a fenced block, an inline span) it offers Copy code (the code alone)
// and Edit code (the field below, on the part holding it); elsewhere the
// text's own menu (Copy) shows.
//
// Direct edits (editable notes): a click without a drag, once it is no
// double click, opens the part of the note under it (editUnits.js) as a
// field of its Markdown; Enter starts a new line, Ctrl+Enter or clicking
// away writes it back, Escape drops it; the formatting shortcuts (Ctrl+B, …,
// the pane's) edit its Markdown (editField). Edit table opens the table as a grid
// (allNotesTableEditor.js), Edit Mermaid code the diagram's code beside its
// live picture (allNotesMermaidEditor.js). Each sits in the text at the
// part's place (a child anchor in place of its first character, the rest
// hidden), and the copy is not rebuilt while it is open; presses in it stay
// its own (the text under it would start a selection). The note's source takes the edit
// as one user action (one undo step).

import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {MermaidEditor} from './allNotesMermaidEditor.js';
import {TableEditor} from './allNotesTableEditor.js';
import {charOffsets, markdownSpans, markdownTasks} from './render.js';
import {markdownBlocks, markdownPreview} from './blocks.js';
import {codeAt, editUnitAt, sourceOffset} from './editUnits.js';
import {withFenceSource} from './mermaidEdit.js';
import {MarkdownBlockPictures} from './renderer/blocks.js';
import {copiedFilesText, imageFile, readImage, showInFileManager} from './renderer/imageFile.js';
import {clipboardImage, fitRenderSize, keyedMarkdownBlocks, RenderSizes,
    resizeWithAspect} from './renderSizes.js';
import {parseTable, serializeTable} from './table.js';
// local:begin notes-math (working-tree only; tools/pack-public strips it)
import {WindowMath} from '../formulas/notes/window.js';
// local:end notes-math

const MUTED = 'rgba(128, 128, 128, 1)';
// GTK 4 draws a fully transparent foreground in the default colour.
const INVISIBLE = 'rgba(0, 0, 0, 0.01)';
// Tag properties per span style (render.js). Added in this order, so a
// later one wins where they overlap: markers shrink inside a heading.
const STYLES = {
    h1: {weight: Pango.Weight.BOLD, scale: 1.45},
    h2: {weight: Pango.Weight.BOLD, scale: 1.3},
    h3: {weight: Pango.Weight.BOLD, scale: 1.15},
    h4: {weight: Pango.Weight.BOLD},
    h5: {weight: Pango.Weight.BOLD},
    h6: {weight: Pango.Weight.BOLD},
    bold: {weight: Pango.Weight.BOLD},
    italic: {style: Pango.Style.ITALIC},
    strike: {strikethrough: true},
    code: {family: 'monospace', background: 'rgba(128, 128, 128, 0.16)'},
    fence: {family: 'monospace'},
    link: {underline: Pango.Underline.SINGLE},
    quote: {style: Pango.Style.ITALIC, foreground: MUTED},
    done: {strikethrough: true, foreground: MUTED},
    marker: {foreground: MUTED},
    // The source token keeps its width, spaced out to the overlaid
    // checkbox's 18 px, so the task's text does not slide underneath it.
    taskbox: {foreground: INVISIBLE, letter_spacing: 4 * Pango.SCALE},
    hidden: {foreground: INVISIBLE, scale: 0.05},
};

// The line under a block: drawing it, why it was not drawn, or what its
// picture leaves out.
function captionText({kind, state, error, warnings}) {
    if (state === 'ready')
        return _('Not drawn: %s').format(warnings[0]);
    const reason = error ?? '';
    switch (kind) {
    case 'table':
        return state === 'pending' ? _('Rendering table…')
            : _('Could not render table: %s').format(reason);
    case 'image':
        return state === 'pending' ? _('Rendering image…')
            : _('Could not render image: %s').format(reason);
    default:
        return state === 'pending' ? _('Rendering diagram…')
            : _('Could not render diagram: %s').format(reason);
    }
}

// Decoded once per picture (renderer/blocks.js keeps the same bytes).
const textures = new WeakMap();
function textureOf(png) {
    let texture = textures.get(png);
    if (!texture) {
        texture = Gdk.Texture.new_from_bytes(new GLib.Bytes(png));
        textures.set(png, texture);
    }
    return texture;
}

/** Types `text` at the cursor of `buffer`, over its selection: one user action. */
export function insertAtCursor(buffer, text) {
    buffer.begin_user_action();
    buffer.delete_selection(true, true);
    buffer.insert_at_cursor(text, -1);
    buffer.end_user_action();
}

/**
 * `buffer`'s text and selection, as markdown.js takes them: character
 * offsets (code points, as GtkTextIter counts), start = the selection's
 * fixed end, end = the cursor.
 */
export function bufferState(buffer) {
    const offset = mark => buffer.get_iter_at_mark(mark).get_offset();
    return {
        text: buffer.text,
        start: offset(buffer.get_selection_bound()),
        end: offset(buffer.get_insert()),
    };
}

/**
 * Sets `buffer`'s text: only the part that changed is replaced, as one
 * user action (one undo step).
 */
export function replaceText(buffer, text) {
    const before = [...buffer.text];
    const after = [...text];
    let head = 0;
    while (head < before.length && head < after.length && before[head] === after[head])
        head++;
    let tail = 0;
    while (tail < before.length - head && tail < after.length - head &&
        before[before.length - 1 - tail] === after[after.length - 1 - tail])
        tail++;
    if (before.length === after.length && head === before.length)
        return;
    buffer.begin_user_action();
    buffer.delete(buffer.get_iter_at_offset(head),
        buffer.get_iter_at_offset(before.length - tail));
    buffer.insert(buffer.get_iter_at_offset(head),
        after.slice(head, after.length - tail).join(''), -1);
    buffer.end_user_action();
}

/** Applies a markdown.js edit to `buffer` (replaceText), then its selection. */
export function editBuffer(buffer, edit) {
    const result = edit(bufferState(buffer));
    replaceText(buffer, result.text);
    buffer.select_range(buffer.get_iter_at_offset(result.end),
        buffer.get_iter_at_offset(result.start));
}

const isTable = source => {
    try {
        parseTable(source);
        return true;
    } catch {
        return false;
    }
};

const ENTER = [Gdk.KEY_Return, Gdk.KEY_KP_Enter, Gdk.KEY_ISO_Enter];

// The layer over the rendered text: its controls (task checks, resize grips)
// take clicks, the rest of it lets them through to the text below, which
// can then be selected. GTK picks a plain Gtk.Fixed over its whole area.
const PassThroughFixed = GObject.registerClass(
class FroontyPassThroughFixed extends Gtk.Fixed {
    vfunc_contains(_x, _y) {
        return false;
    }
});

// The rendered text. Laid out anew (a line validated, a field or grid
// resized), it calls onAllocated: what is placed over it follows its lines.
const RenderedView = GObject.registerClass(
class FroontyRenderedView extends Gtk.TextView {
    vfunc_size_allocate(width, height, baseline) {
        super.vfunc_size_allocate(width, height, baseline);
        this.onAllocated?.();
    }
});

export class MarkdownStyler {
    /**
     * @param {Gtk.TextView} view the editor; signals die with it
     * @param {Function} folder the notes folder (Gio.File)
     * @param {Function} note the note's name
     * @param {object} callbacks
     * @param {Function} callbacks.onToggleTask (offset) a task check was
     *   clicked: the offset of its `[`, in characters, in the source
     * @param {Function} callbacks.onEdit (start, end, text) a direct edit:
     *   `text` replaces the source's [start, end) (UTF-16 offsets)
     * @param {Function} callbacks.onPasteImage (clipboard) a paste into a
     *   field: null when the clipboard holds no image (a text paste), else
     *   a promise of the Markdown that references it once saved (or null)
     */
    constructor(view, folder = () => null, note = () => null, {onToggleTask, onEdit, onPasteImage}) {
        this._sourceView = view;
        this._sourceBuffer = view.buffer;
        // Rebuilt on every update: no undo history to grow.
        this._buffer = new Gtk.TextBuffer({enable_undo: false});
        this._view = new RenderedView({
            buffer: this._buffer,
            wrap_mode: view.wrap_mode,
            left_margin: view.left_margin,
            right_margin: view.right_margin,
            top_margin: view.top_margin,
            bottom_margin: view.bottom_margin,
            editable: false,
            cursor_visible: false,
        });
        // Rendered Markdown has its own one-line placeholders for block
        // objects. The source editor remains untouched, so hidden code fences
        // and table rows cannot add phantom height to the preview.
        this.widget = new Gtk.Stack({hexpand: true, vexpand: true});
        this._sourceScroll = new Gtk.ScrolledWindow({
            hexpand: true, vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            child: view,
        });
        this.widget.add_named(this._sourceScroll, 'source');
        const preview = new Gtk.Overlay({child: this._view});
        this._overlay = new PassThroughFixed({
            hexpand: true, vexpand: true,
            halign: Gtk.Align.FILL, valign: Gtk.Align.FILL,
        });
        preview.add_overlay(this._overlay);
        preview.set_measure_overlay(this._overlay, false);
        this._previewScroll = new Gtk.ScrolledWindow({
            hexpand: true, vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            child: preview,
        });
        this.widget.add_named(this._previewScroll, 'rendered');
        this.widget.visible_child_name = 'rendered';
        const buffer = this._buffer;
        this._rendered = true;
        this._tags = new Map();
        this._folder = folder;
        this._onToggleTask = onToggleTask;
        this._onEdit = onEdit;
        this._onPasteImage = onPasteImage;
        this._blockHidden = new Gtk.TextTag({
            name: 'froonty-markdown-block-hidden', foreground: INVISIBLE,
            scale: 0.01, allow_breaks: false,
        });
        buffer.get_tag_table().add(this._blockHidden);
        // The text a field or table grid stands in for while open.
        this._editHidden = new Gtk.TextTag({name: 'froonty-edit-hidden', invisible: true});
        buffer.get_tag_table().add(this._editHidden);
        this._editor = null;
        this._clickId = 0;
        this._clickArmed = false;
        this._blockRoomTags = [];
        this._blockPictures = [];
        this._blockFrames = [];
        this._blockCaptions = [];
        this._blockResizeHandles = [];
        this._placedTasks = [];
        this._taskChecks = [];
        this._updatingTasks = false;
        this._placeId = 0;
        this._adjustments = [];
        this._blocks = new MarkdownBlockPictures(() => this.update());
        this._sizes = new RenderSizes(() => this.update());
        this._note = note;
        for (const [style, properties] of Object.entries(STYLES)) {
            const tag = new Gtk.TextTag({name: `froonty-markdown-${style}`, ...properties});
            buffer.get_tag_table().add(tag);
            this._tags.set(style, tag);
        }
        // Search matches (setMatches()): over the styles, under the hidden
        // markers.
        this._matchTag = new Gtk.TextTag({
            name: 'froonty-match', background: '#f6d32d', foreground: '#1f1f1f',
        });
        buffer.get_tag_table().add(this._matchTag);
        this._matchTag.set_priority(this._tags.get('taskbox').get_priority());
        this._matches = {text: null, ranges: []};
        this._matchOffsets = [];
        this._scrollToMatch = false;
        this._view.connect('copy-clipboard', () => this._copy());
        this._view.onAllocated = () => this._queuePlace();
        view.connect('destroy', () => this._destroy());
        this._followAdjustments();
        this._sourceBuffer.connect('changed', () => {
            // Changed under an open field (a reload): it is dropped.
            const editor = this._editor;
            if (editor && this._sourceBuffer.text.slice(editor.start, editor.end) !== editor.original)
                this._closeEditor(false);
            else
                this.update();
        });
        // A click edits the part under it (rendered.edit-at, with the
        // copy's character offset), once it is no double click.
        const actions = new Gio.SimpleActionGroup();
        const editAt = new Gio.SimpleAction({name: 'edit-at', parameter_type: new GLib.VariantType('i')});
        editAt.connect('activate', (_action, offset) => this._editAt(offset.unpack()));
        actions.add_action(editAt);
        this._view.insert_action_group('rendered', actions);
        const clicks = new Gtk.EventControllerLegacy();
        clicks.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        clicks.connect('event', (_controller, event) => this._onClick(event));
        this._view.add_controller(clicks);
        // A right click on code: its own menu (Copy code, Edit code).
        this._codeMenu = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        this._codePopover = new Gtk.Popover({child: this._codeMenu});
        this._codePopover.set_parent(this._overlay);
        this._overlay.connect('destroy', () => this._codePopover.unparent());
        const rightClick = new Gtk.GestureClick({button: Gdk.BUTTON_SECONDARY});
        rightClick.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        rightClick.connect('pressed', (gesture, _presses, x, y) => this._onRightClick(gesture, x, y));
        this._view.add_controller(rightClick);
        // local:begin notes-math
        // Formulas drawn as pictures (features/formulas/notes/window.js).
        this.math = new WindowMath(this._view, () => this.update());
        // local:end notes-math
        this.update();
    }

    /** Restyles the rendered view from the source; setRendered(true) does. */
    update() {
        // Not under an open field: closing it updates.
        if (!this._rendered || this._editor)
            return;
        const buffer = this._buffer;
        const text = this._sourceBuffer.text;
        const width = this._width = this._blockWidth();
        const folder = this._folder();
        this._sizes.select(folder, this._note?.() ?? null);
        const blocks = keyedMarkdownBlocks(markdownBlocks(text));
        const requests = this._blocks.want(blocks, width, folder).map(picture => ({
            ...picture, displaySize: this._sizes.get(picture.itemKey),
        }));
        const document = markdownPreview(text, requests);
        buffer.text = document.text;
        for (const tag of this._tags.values())
            buffer.remove_tag(tag, ...buffer.get_bounds());
        buffer.remove_tag(this._blockHidden, ...buffer.get_bounds());
        for (const tag of this._blockRoomTags)
            buffer.remove_tag(tag, ...buffer.get_bounds());
        const spans = this._spans(document.text);
        const offsets = charOffsets(document.text, spans.flatMap(({start, end}) => [start, end]));
        for (const {start, end, style} of spans) {
            buffer.apply_tag(this._tags.get(style),
                buffer.get_iter_at_offset(offsets.get(start)),
                buffer.get_iter_at_offset(offsets.get(end)));
        }
        this._document = document;
        this._markMatches();
        this._updateBlocks(text, document, requests);
    }

    /**
     * Marks the matches of a search, until the source changes, and
     * scrolls to the first.
     *
     * @param {number[][]} ranges [start, end] in the source, UTF-16 offsets
     */
    setMatches(ranges) {
        this._matches = {text: this._sourceBuffer.text, ranges};
        this._scrollToMatch = ranges.length > 0;
        this._markMatches();
        this._queuePlace();
    }

    /** Gives the key focus to the rendered view. */
    focusRendered() {
        this._view.grab_focus();
    }

    /** Closes an open field or table grid, writing it back if `commit`. */
    endEditing(commit) {
        this._closeEditor(commit);
    }

    /**
     * Applies a markdown.js edit to the open field (a formatting shortcut).
     *
     * @returns {boolean} whether a field was open (not a table or diagram)
     */
    editField(edit) {
        const field = this._editor?.field;
        if (!field)
            return false;
        editBuffer(field.buffer, edit);
        return true;
    }

    setRendered(rendered) {
        rendered = Boolean(rendered);
        if (this._rendered === rendered)
            return;
        this._closeEditor(true);
        this._rendered = rendered;
        this.widget.visible_child_name = rendered ? 'rendered' : 'source';
        this.update();
    }

    setWrap(wrap) {
        const mode = wrap ? Gtk.WrapMode.WORD_CHAR : Gtk.WrapMode.NONE;
        this._sourceView.wrap_mode = mode;
        this._view.wrap_mode = mode;
        this._sourceScroll.hscrollbar_policy = wrap
            ? Gtk.PolicyType.NEVER : Gtk.PolicyType.AUTOMATIC;
        this._previewScroll.hscrollbar_policy = wrap
            ? Gtk.PolicyType.NEVER : Gtk.PolicyType.AUTOMATIC;
    }

    // The width blocks are rendered at.
    _blockWidth() {
        return Math.max(180, Math.min(600,
            this._view.get_width() - this._view.left_margin - this._view.right_margin));
    }

    // The matches outside blocks, at their places in the copy.
    _markMatches() {
        const buffer = this._buffer;
        buffer.remove_tag(this._matchTag, ...buffer.get_bounds());
        if (this._matches.text !== this._sourceBuffer.text)
            this._matches = {text: null, ranges: []};
        const document = this._document;
        const ranges = this._matches.ranges
            .map(([start, end]) => [document.mapOffset(start), document.mapOffset(end - 1)])
            .filter(([start, last]) => start !== null && last !== null)
            .map(([start, last]) => [start, last + 1]);
        const offsets = charOffsets(document.text, ranges.flat());
        this._matchOffsets = ranges.map(([start, end]) => [offsets.get(start), offsets.get(end)]);
        for (const [start, end] of this._matchOffsets) {
            buffer.apply_tag(this._matchTag, buffer.get_iter_at_offset(start),
                buffer.get_iter_at_offset(end));
        }
    }

    // Copies the selection as drawn: without hidden markers, task boxes
    // and block placeholders.
    _copy() {
        this._view.stop_emission_by_name('copy-clipboard');
        const [selected, start, end] = this._buffer.get_selection_bounds();
        if (!selected)
            return;
        const hidden = [this._tags.get('hidden'), this._tags.get('taskbox'), this._blockHidden];
        const chars = [];
        for (const iter = start.copy(); iter.compare(end) < 0; iter.forward_char()) {
            if (!hidden.some(tag => iter.has_tag(tag)))
                chars.push(iter.get_char());
        }
        this._view.get_clipboard().set(chars.join(''));
    }

    _updateBlocks(text, document, pictures) {
        const chars = charOffsets(document.text, document.blocks.map(block => block.previewStart));
        const placed = [];
        for (let i = 0; i < pictures.length; i++) {
            const picture = pictures[i];
            const offset = chars.get(document.blocks[i].previewStart);
            const iter = this._buffer.get_iter_at_offset(offset);
            this._buffer.apply_tag(this._blockHidden, iter,
                this._buffer.get_iter_at_offset(offset + 1));
            // A pending or failed block shows its caption instead; a drawn
            // one with warnings, its picture and the caption under it.
            const caption = this._caption(i, picture, text);
            let width = picture.width, height = 0;
            if (picture.state === 'ready') {
                const maxWidth = picture.kind === 'mermaid' ? 380 : 560;
                const maxHeight = picture.kind === 'mermaid' ? 320 : 420;
                const scale = Math.min(1, maxWidth / picture.width, maxHeight / picture.height);
                ({width, height} = fitRenderSize(picture.displaySize, picture) ?? {
                    width: Math.max(1, Math.round(picture.width * scale)),
                    height: Math.max(1, Math.round(picture.height * scale)),
                });
            }
            const lineHeight = Math.max(1, this._view.get_iter_location(iter).height);
            const room = this._blockRoomTag(i);
            room.pixels_below_lines = Math.max(0,
                height + (height && caption ? 4 : 0) + caption - lineHeight + 4);
            this._buffer.apply_tag(room, iter, this._buffer.get_iter_at_offset(offset + 1));
            placed.push({...picture, offset, width, height});
        }
        this._placedBlocks = placed;
        const tasks = markdownTasks(text).map(task => ({
            sourceOffset: task.start,
            offset: document.mapOffset(task.start),
            checked: task.checked,
        })).filter(task => task.offset !== null);
        const taskOffsets = charOffsets(document.text, tasks.map(task => task.offset));
        this._placedTasks = tasks.map(task => ({...task, offset: taskOffsets.get(task.offset)}));
        this._blockHidden.set_priority(this._buffer.get_tag_table().get_size() - 1);
        this._queuePlace();
    }

    _queuePlace() {
        if (this._placeId)
            return;
        this._placeId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._placeId = 0;
            this._placeBlocks();
            return GLib.SOURCE_REMOVE;
        });
    }

    // The room under the i-th block's line; its height is set on each update.
    _blockRoomTag(i) {
        let tag = this._blockRoomTags[i];
        if (!tag) {
            tag = new Gtk.TextTag({name: `froonty-block-room-${i}`});
            this._buffer.get_tag_table().add(tag);
            this._blockRoomTags[i] = tag;
        }
        return tag;
    }

    // Sets the i-th block's caption (captionText(), and on a failure the
    // block's Markdown) and returns its height; 0 when it has none.
    _caption(i, block, text) {
        let caption = this._blockCaptions[i];
        if (!caption) {
            caption = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4,
                halign: Gtk.Align.START, valign: Gtk.Align.START});
            caption._line = new Gtk.Label({xalign: 0, wrap_mode: Pango.WrapMode.WORD_CHAR});
            caption._source = new Gtk.Label({xalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR,
                selectable: true, css_classes: ['monospace']});
            caption.append(caption._line);
            caption.append(caption._source);
            this._overlay.put(caption, 0, 0);
            this._blockCaptions[i] = caption;
        }
        const ready = block.state === 'ready';
        caption.visible = !ready || block.warnings.length > 0;
        if (!caption.visible)
            return 0;
        const line = caption._line;
        line.label = captionText(block);
        line.css_classes = block.state === 'error' ? [] : ['dim-label'];
        // Warnings: one short line, all of them in its tooltip.
        line.wrap = !ready;
        line.ellipsize = ready ? Pango.EllipsizeMode.END : Pango.EllipsizeMode.NONE;
        line.tooltip_text = ready ? block.warnings.join('\n') : null;
        caption._source.visible = block.state === 'error';
        caption._source.label = text.slice(block.start, block.end);
        caption.set_size_request(this._width, -1);
        return caption.measure(Gtk.Orientation.VERTICAL, this._width)[1];
    }

    // The i-th block's right-click menu, for the block as now placed.
    _fillMenu(menu, popover, placed) {
        const items = [[placed.kind === 'image' ? _('Copy as PNG') : _('Copy as JPEG'),
            () => this._copyPicture(placed)]];
        const file = placed.kind === 'image' ? imageFile(placed, this._folder()) : null;
        if (file) {
            items.push([_('Open file location'), () => showInFileManager(file)],
                [_('Copy original'), () => this._copyOriginal(file)]);
        }
        if (placed.kind === 'table')
            items.push([_('Copy as Markdown'), () => this._view.get_clipboard().set(placed.source)]);
        if (placed.kind === 'table' && this._sourceView.editable && isTable(placed.source))
            items.push([_('Edit table'), () => this._editTable(placed)]);
        if (placed.kind === 'mermaid') {
            items.push([_('Copy Mermaid code'), () => this._view.get_clipboard().set(placed.source)]);
            if (this._sourceView.editable)
                items.push([_('Edit Mermaid code'), () => this._editMermaid(placed)]);
        }
        this._menuItems(menu, popover, items);
    }

    // Fills `menu` (in `popover`) with a button per [label, run]; a click
    // closes the popover, then runs it.
    _menuItems(menu, popover, items) {
        for (let child; (child = menu.get_first_child());)
            menu.remove(child);
        for (const [label, run] of items) {
            const button = new Gtk.Button({label, has_frame: false});
            button.get_child().xalign = 0;
            button.connect('clicked', async () => {
                popover.popdown();
                try {
                    await run();
                } catch (error) {
                    console.warn(`Froonty notes: ${label}: ${error.message}`);
                }
            });
            menu.append(button);
        }
    }

    _copyPicture(placed) {
        const copied = clipboardImage(placed.png, placed.kind);
        const provider = Gdk.ContentProvider.new_for_bytes(copied.mime, new GLib.Bytes(copied.bytes));
        if (!this._view.get_clipboard().set_content(provider))
            throw new Error(`Clipboard rejected ${copied.mime}`);
    }

    // The image file itself: its bytes as its type, and the file, to paste
    // into Files.
    async _copyOriginal(file) {
        const {bytes, mime} = await readImage(file);
        const providers = [Gdk.ContentProvider.new_for_bytes(mime, new GLib.Bytes(bytes))];
        for (const [type, text] of Object.entries(copiedFilesText(file.get_uri()))) {
            providers.push(Gdk.ContentProvider.new_for_bytes(type,
                new GLib.Bytes(new TextEncoder().encode(text))));
        }
        this._view.get_clipboard().set_content(Gdk.ContentProvider.new_union(providers));
    }

    // A right click at (x, y) of the view on code: Copy code, and Edit code
    // on an editable note (Copy too, over a selection). Elsewhere, or while
    // a field is open, the view's own menu.
    _onRightClick(gesture, x, y) {
        if (this._editor || !this._rendered)
            return;
        const [bx, by] = this._view.window_to_buffer_coords(Gtk.TextWindowType.WIDGET, x, y);
        const [over, iter] = this._view.get_iter_at_location(bx, by);
        const offset = iter.get_offset();
        const at = over ? this._sourceAt(offset) : null;
        const code = at === null ? null : codeAt(this._sourceBuffer.text, at);
        if (code === null)
            return;
        gesture.set_state(Gtk.EventSequenceState.CLAIMED);
        const items = [];
        if (this._buffer.get_has_selection())
            items.push([_('Copy'), () => this._view.emit('copy-clipboard')]);
        items.push([_('Copy code'), () => this._view.get_clipboard().set(code)]);
        if (this._sourceView.editable)
            items.push([_('Edit code'), () => this._editAt(offset)]);
        this._menuItems(this._codeMenu, this._codePopover, items);
        this._codePopover.set_pointing_to(new Gdk.Rectangle({
            x: Math.round(x), y: Math.round(y), width: 1, height: 1,
        }));
        this._codePopover.popup();
    }

    // The note offset shown at the copy's character `offset`; null on a block.
    _sourceAt(offset) {
        const buffer = this._buffer;
        return sourceOffset(this._sourceBuffer.text, this._document,
            buffer.get_text(buffer.get_start_iter(), buffer.get_iter_at_offset(offset), true).length);
    }

    // A press, then a release with nothing selected and no second press
    // within the double-click time: the click edits there. Never while a
    // field is open (that click closes it).
    _onClick(event) {
        const type = event.get_event_type();
        if (type === Gdk.EventType.BUTTON_PRESS) {
            const second = this._clickId !== 0;
            this._cancelClick();
            this._clickArmed = !second && !this._editor && event.get_button() === Gdk.BUTTON_PRIMARY;
        } else if (type === Gdk.EventType.BUTTON_RELEASE && this._clickArmed) {
            this._clickArmed = false;
            this._clickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                Gtk.Settings.get_default().gtk_double_click_time, () => {
                    this._clickId = 0;
                    const buffer = this._buffer;
                    if (!buffer.get_has_selection())
                        this._editAt(buffer.get_iter_at_mark(buffer.get_insert()).get_offset());
                    return GLib.SOURCE_REMOVE;
                });
        }
        return false;
    }

    _cancelClick() {
        if (this._clickId)
            GLib.source_remove(this._clickId);
        this._clickId = 0;
    }

    // The width an editor at the copy's character `offset` has, up to the
    // view's right margin.
    _editorWidth(offset) {
        const box = this._view.get_iter_location(this._buffer.get_iter_at_offset(offset));
        const [x] = this._view.buffer_to_window_coords(Gtk.TextWindowType.WIDGET, box.x, box.y);
        return Math.max(160, this._view.get_width() - this._view.right_margin - x - 8);
    }

    // Opens the part of the note shown at the copy's character `offset` as
    // a field of its Markdown, the caret where the click was.
    _editAt(offset) {
        if (this._editor || !this._rendered || !this._sourceView.editable)
            return;
        const text = this._sourceBuffer.text;
        const document = this._document;
        const at = this._sourceAt(offset);
        const unit = at === null ? null : editUnitAt(text, at, document.blocks);
        if (!unit)
            return;
        const from = document.mapOffset(unit.start);
        const to = document.mapOffset(unit.end);
        const chars = charOffsets(document.text, [from, to]);
        const original = text.slice(unit.start, unit.end);
        const field = new Gtk.TextView({
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            top_margin: 4, bottom_margin: 4, left_margin: 6, right_margin: 6,
        });
        field.buffer.text = original;
        field.buffer.place_cursor(field.buffer.get_iter_at_offset(
            [...text.slice(unit.start, Math.min(Math.max(at, unit.start), unit.end))].length));
        const frame = new Gtk.Frame({child: field, width_request: this._editorWidth(chars.get(from))});
        const editor = {start: unit.start, end: unit.end, original, field, text: () => field.buffer.text};

        const keys = new Gtk.EventControllerKey();
        keys.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        keys.connect('key-pressed', (_controller, keyval, _keycode, state) => {
            if (keyval === Gdk.KEY_Escape) {
                this._closeEditor(false, true);
            } else if (ENTER.includes(keyval) && state & Gdk.ModifierType.CONTROL_MASK) {
                this._closeEditor(true, true);
            } else {
                return false; // Enter: the field's own new line
            }
            return true;
        });
        frame.add_controller(keys);
        // Clicking away writes it back, once the focus has moved: removing
        // the field while GTK hands the focus over left GTK looping.
        const focus = new Gtk.EventControllerFocus();
        focus.connect('leave', () => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this._editor === editor)
                this._closeEditor(true);
            return GLib.SOURCE_REMOVE;
        }));
        field.add_controller(focus);
        field.connect('paste-clipboard', () => {
            const markdown = this._onPasteImage(field.get_clipboard());
            if (!markdown)
                return;
            field.stop_emission_by_name('paste-clipboard');
            markdown.then(reference => {
                if (reference && this._editor === editor)
                    insertAtCursor(field.buffer, reference);
            });
        });
        this._openEditor(chars.get(from), chars.get(to), frame, editor, () => field.grab_focus());
    }

    // Opens a rendered table as a grid of its cells.
    _editTable(placed) {
        this._editBlock(placed, (block, original, width) => {
            const model = parseTable(block.source);
            const unchanged = serializeTable(model);
            const table = new TableEditor(model, width,
                () => this._closeEditor(true, true), () => this._closeEditor(false, true));
            return {widget: table.widget, focus: () => table.focus(),
                // Done without a change leaves the table as it was written.
                text: () => {
                    const text = serializeTable(table.model);
                    return text === unchanged ? original : text;
                }};
        });
    }

    // Opens a rendered diagram as its code beside its live picture, drawn
    // as the note's are.
    _editMermaid(placed) {
        this._editBlock(placed, (block, original, width) => {
            const mermaid = new MermaidEditor(block.source, width,
                source => this._blocks.draw({kind: 'mermaid', source}, this._width, this._folder()),
                () => this._closeEditor(true, true), () => this._closeEditor(false, true));
            return {widget: mermaid.widget, focus: () => mermaid.focus(), close: () => mermaid.close(),
                // Unchanged code writes nothing; else it goes between the fence lines.
                text: () => (mermaid.code === block.source ? original
                    : withFenceSource(original, mermaid.code))};
        });
    }

    // Opens the drawn block `placed` in place, in the editor make(block,
    // its Markdown, width) returns: {widget, focus(), text() (the block's
    // Markdown now), close()? (it is gone)}.
    _editBlock(placed, make) {
        const i = this._placedBlocks.findIndex(block => block.start === placed.start &&
            block.source === placed.source);
        if (i < 0 || this._editor || !this._sourceView.editable)
            return;
        const block = this._placedBlocks[i];
        const original = this._sourceBuffer.text.slice(block.start, block.end);
        const {widget, focus, text, close} = make(block, original, this._editorWidth(block.offset));
        this._openEditor(block.offset, block.offset + 1, widget,
            {start: block.start, end: block.end, original, block: i, text, close}, focus);
    }

    // Puts `widget` in the copy in place of its characters [from, to): the
    // first becomes its anchor, the others are hidden; then focus() gives
    // it the key focus.
    _openEditor(from, to, widget, editor, focus) {
        this._cancelClick();
        const buffer = this._buffer;
        buffer.delete(buffer.get_iter_at_offset(from), buffer.get_iter_at_offset(from + 1));
        const anchor = buffer.create_child_anchor(buffer.get_iter_at_offset(from));
        buffer.apply_tag(this._editHidden, buffer.get_iter_at_offset(from + 1),
            buffer.get_iter_at_offset(to));
        // Its presses (on a button, a margin) stop here: the view would take
        // the focus and drag a selection from them, over the lines around.
        const own = new Gtk.EventControllerLegacy();
        own.connect('event', (_controller, event) => [Gdk.EventType.BUTTON_PRESS,
            Gdk.EventType.BUTTON_RELEASE].includes(event.get_event_type()));
        widget.add_controller(own);
        this._view.add_child_at_anchor(widget, anchor);
        this._editor = editor;
        this._queuePlace();
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this._editor === editor)
                focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Closes the open field or grid; with `commit`, its text replaces the
    // part it was opened on, unless the note changed there meanwhile.
    _closeEditor(commit, refocus = false) {
        const editor = this._editor;
        if (!editor)
            return;
        this._editor = null;
        editor.close?.();
        const before = this._sourceBuffer.text;
        const text = commit ? editor.text() : editor.original;
        if (text !== editor.original && before.slice(editor.start, editor.end) === editor.original)
            this._onEdit(editor.start, editor.end, text);
        // Restyled already when the edit changed the source.
        if (this._sourceBuffer.text === before)
            this.update();
        if (refocus)
            this._view.grab_focus();
    }

    _placeBlocks() {
        // Hidden: setRendered(true) updates and places them.
        if (!this._rendered)
            return;
        // A new width: the blocks are rendered at it first (once no field
        // is open).
        if (this._blockWidth() !== this._width && !this._editor) {
            this.update();
            return;
        }
        const view = this._view;
        this._placedBlocks?.forEach((placed, i) => {
            const iter = this._buffer.get_iter_at_offset(placed.offset);
            const box = view.get_iter_location(iter);
            // get_iter_location() is in buffer coordinates; the Gtk.Fixed is
            // a sibling overlay in widget coordinates. Convert so overlays
            // stay aligned when the TextView scrolls.
            const [x, lineY] = view.buffer_to_window_coords(
                Gtk.TextWindowType.WIDGET, box.x, box.y);
            const y = lineY;
            let picture = this._blockPictures[i];
            let frame = this._blockFrames[i];
            if (!picture) {
                picture = new Gtk.Picture({can_target: true, can_shrink: true,
                    content_fit: Gtk.ContentFit.CONTAIN,
                    halign: Gtk.Align.START, valign: Gtk.Align.START});
                frame = new Gtk.Overlay({child: picture,
                    halign: Gtk.Align.START, valign: Gtk.Align.START});
                const menu = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
                const popover = new Gtk.Popover({child: menu});
                popover.set_parent(picture);
                picture.connect('destroy', () => popover.unparent());
                const menuGesture = new Gtk.GestureClick();
                menuGesture.set_button(Gdk.BUTTON_SECONDARY);
                menuGesture.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
                menuGesture.connect('pressed', (gesture, _presses, x, y) => {
                    const placed = this._placedBlocks[i];
                    if (placed?.state !== 'ready')
                        return;
                    gesture.set_state(Gtk.EventSequenceState.CLAIMED);
                    this._fillMenu(menu, popover, placed);
                    popover.set_pointing_to(new Gdk.Rectangle({
                        x: Math.round(x), y: Math.round(y), width: 1, height: 1,
                    }));
                    popover.popup();
                });
                picture.add_controller(menuGesture);
                this._overlay.put(frame, x, y);
                this._blockPictures.push(picture);
                this._blockFrames.push(frame);
            } else {
                this._move(frame, x, y);
            }
            // In a table grid now: the grid shows instead.
            const editing = this._editor?.block === i;
            const png = placed.state === 'ready' ? placed.png : null;
            if (picture._png !== png) {
                picture._png = png;
                try {
                    picture.paintable = png ? textureOf(png) : null;
                } catch {
                    picture.paintable = null;
                }
            }
            if (png)
                picture.set_size_request(Math.round(placed.width), Math.round(placed.height));
            picture.visible = Boolean(png && picture.paintable) && !editing;
            const caption = this._blockCaptions[i];
            if (caption && editing)
                caption.visible = false;
            if (caption?.visible)
                this._move(caption, x, png ? y + placed.height + 4 : y);
            // A grip only on a picture that shows.
            let handle = this._blockResizeHandles[i];
            if (picture.visible) {
                if (!handle) {
                    handle = new Gtk.Button({label: '◢', width_request: 20,
                        halign: Gtk.Align.END, valign: Gtk.Align.END,
                        height_request: 20, tooltip_text: _('Drag to resize this rendered item'),
                        css_classes: ['flat', 'froonty-render-resize']});
                    handle.set_cursor_from_name('se-resize');
                    const drag = new Gtk.GestureDrag();
                    drag.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
                    handle.add_controller(drag);
                    // The pointer in the layer's coordinates: the grip moves
                    // with the picture it resizes, so offsets from the
                    // gesture (relative to the grip) would feed back.
                    const pointer = (x, y) => handle.translate_coordinates(this._overlay, x, y).slice(1);
                    let start = null, origin = null, size = null;
                    drag.connect('drag-begin', (_gesture, x, y) => {
                        const placed = this._placedBlocks[i];
                        start = {width: placed.width, height: placed.height};
                        origin = pointer(x, y);
                        size = null;
                    });
                    drag.connect('drag-update', gesture => {
                        if (!start)
                            return;
                        const [x, y] = pointer(...gesture.get_point(null).slice(1));
                        size = resizeWithAspect(start, x - origin[0], y - origin[1]);
                        this._blockPictures[i].set_size_request(size.width, size.height);
                    });
                    drag.connect('drag-end', () => {
                        start = null;
                        const item = this._placedBlocks[i];
                        if (!size || !item)
                            return;
                        // Under the note's name now (it may have been renamed).
                        this._sizes.select(this._folder(), this._note?.() ?? null);
                        this._sizes.set(item.itemKey, size);
                        this.update();
                    });
                    frame.add_overlay(handle);
                    frame.set_measure_overlay(handle, false);
                    this._blockResizeHandles[i] = handle;
                }
                handle.visible = true;
            } else if (handle) {
                handle.visible = false;
            }
        });
        for (const picture of this._blockPictures.slice(this._placedBlocks?.length ?? 0)) {
            picture.visible = false;
            picture.paintable = null;
            picture._png = null;
        }
        for (const caption of this._blockCaptions.slice(this._placedBlocks?.length ?? 0))
            caption.visible = false;
        for (const handle of this._blockResizeHandles.slice(this._placedBlocks?.length ?? 0))
            handle.visible = false;
        this._placedTasks.forEach((task, i) => {
            let check = this._taskChecks[i];
            if (!check) {
                check = new Gtk.CheckButton({width_request: 18, height_request: 18,
                    halign: Gtk.Align.START, valign: Gtk.Align.START,
                    css_classes: ['flat', 'froonty-task-check']});
                check.connect('toggled', () => {
                    const task = this._placedTasks[i];
                    if (!this._updatingTasks && task)
                        this._onToggleTask([...this._sourceBuffer.text.slice(0, task.sourceOffset)].length);
                });
                this._overlay.put(check, 0, 0);
                this._taskChecks.push(check);
            }
            const box = view.get_iter_location(this._buffer.get_iter_at_offset(task.offset));
            const [x, lineY] = view.buffer_to_window_coords(
                Gtk.TextWindowType.WIDGET, box.x, box.y);
            this._updatingTasks = true;
            check.active = task.checked;
            this._updatingTasks = false;
            check.sensitive = this._sourceView.editable;
            const markerBox = view.get_iter_location(
                this._buffer.get_iter_at_offset(task.offset + 3));
            const markerWidth = Math.max(18, markerBox.x - box.x);
            check.set_size_request(18, 18);
            this._move(check, x + Math.max(0, (markerWidth - 18) / 2),
                lineY + Math.max(0, (box.height - 18) / 2));
            check.visible = true;
        });
        for (const check of this._taskChecks.slice(this._placedTasks.length))
            check.visible = false;
        // To the first match, once the view has a size.
        const vadjustment = this._previewScroll.get_vadjustment();
        if (this._scrollToMatch && this._matchOffsets.length && vadjustment.page_size > 0) {
            this._scrollToMatch = false;
            const first = Math.min(...this._matchOffsets.map(([start]) => start));
            const box = view.get_iter_location(this._buffer.get_iter_at_offset(first));
            const [, y] = view.buffer_to_window_coords(Gtk.TextWindowType.WIDGET, box.x, box.y);
            vadjustment.value = y - 0.3 * vadjustment.page_size;
        }
    }

    // Moves `widget` in the layer unless it is there: placing again on each
    // layout of the view, a move would lay it out once more.
    _move(widget, x, y) {
        const [atX, atY] = this._overlay.get_child_position(widget);
        if (atX !== x || atY !== y)
            this._overlay.move(widget, x, y);
    }

    _destroy() {
        this._cancelClick();
        this._editor?.close?.();
        if (this._placeId)
            GLib.source_remove(this._placeId);
        this._placeId = 0;
        this._blocks.destroy();
        this._sizes.destroy();
        for (const [adjustment, ids] of this._adjustments) {
            for (const id of ids)
                adjustment.disconnect(id);
        }
        this._adjustments = [];
        this._placedBlocks = [];
        this._blockPictures = [];
        this._blockFrames = [];
        this._blockCaptions = [];
        this._blockResizeHandles = [];
        this._placedTasks = [];
        this._taskChecks = [];
    }

    _followAdjustments() {
        for (const adjustment of [this._previewScroll.get_hadjustment(),
            this._previewScroll.get_vadjustment()]) {
            if (!adjustment)
                continue;
            const ids = [
                adjustment.connect('value-changed', () => this._queuePlace()),
                adjustment.connect('changed', () => this._queuePlace()),
            ];
            this._adjustments.push([adjustment, ids]);
        }
    }

    _spans(text) {
        // local:begin notes-math
        if (this.math)
            return this.math.update(text);
        // local:end notes-math
        return markdownSpans(text);
    }
}
