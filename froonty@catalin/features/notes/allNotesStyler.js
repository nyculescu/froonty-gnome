// SPDX-License-Identifier: GPL-3.0-or-later
// Renders a separate display copy of the All notes editor. Block source is
// collapsed to one placeholder in that copy; the editable buffer stays
// untouched and plain Markdown.
//
// Hidden markers are drawn transparent at a twentieth of the size, not with
// the tags' "invisible" property: GtkTextBuffer:text leaves invisible
// characters out, and the pane saves that text. As in the island, every
// character also stays in place for the cursor and the formatting bar.
//
// The muted colour (markers, quotes, done items) is a mid grey, which reads
// on light and dark styles alike; the window's editor has no note colour.

import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import {charOffsets, markdownSpans, markdownTasks, toggleTask} from './render.js';
import {markdownBlocks, markdownPreview} from './blocks.js';
import {MarkdownBlockPictures} from './renderer/blocks.js';
// local:begin notes-math (working-tree only; tools/pack-public strips it)
import {WindowMath} from '../formulas/notes/window.js';
// local:end notes-math

const MUTED = 'rgba(128, 128, 128, 1)';
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
    // Keep the source token's width under the overlay control so the task
    // label after it does not slide underneath the checkbox.
    taskbox: {foreground: 'rgba(0, 0, 0, 0)'},
    hidden: {foreground: 'rgba(0, 0, 0, 0)', scale: 0.05},
};

export class MarkdownStyler {
    /** @param {Gtk.TextView} view the editor; signals die with it */
    constructor(view, folder = () => null) {
        this._sourceView = view;
        this._sourceBuffer = view.buffer;
        this._buffer = new Gtk.TextBuffer();
        this._view = new Gtk.TextView({
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
        this._overlay = new Gtk.Fixed({
            hexpand: true, vexpand: true,
            halign: Gtk.Align.FILL, valign: Gtk.Align.FILL,
        });
        // The fixed layer has no background; let its task controls receive
        // clicks while the blank areas continue to propagate normally.
        this._overlay.can_target = true;
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
        this._blockHidden = new Gtk.TextTag({
            name: 'froonty-markdown-block-hidden', foreground: 'rgba(0,0,0,0)',
            scale: 0.01, allow_breaks: false,
        });
        buffer.get_tag_table().add(this._blockHidden);
        this._blockRoomTags = new Map();
        this._blockPictures = [];
        this._blockStatuses = [];
        this._placedTasks = [];
        this._taskChecks = [];
        this._updatingTasks = false;
        this._placeId = 0;
        this._adjustments = [];
        this._blocks = new MarkdownBlockPictures(() => this.update(true));
        for (const [style, properties] of Object.entries(STYLES)) {
            const tag = new Gtk.TextTag({name: `froonty-markdown-${style}`, ...properties});
            buffer.get_tag_table().add(tag);
            this._tags.set(style, tag);
        }
        this._view.connect('notify::width', () => this.update(true));
        view.connect('destroy', () => this._destroy());
        this._followAdjustments();
        this._sourceBuffer.connect('changed', () => this.update(true));
        // local:begin notes-math
        // Formulas drawn as pictures (features/formulas/notes/window.js).
        this.math = new WindowMath(this._view, () => this.update(true));
        // local:end notes-math
        this.update(true);
    }

    /** Restyles; unless `force`, only when the edited line changed. */
    update(force = false) {
        const buffer = this._buffer;
        const text = this._sourceBuffer.text;
        const width = Math.max(180, Math.min(600,
            this._view.get_width() - this._view.left_margin - this._view.right_margin));
        const requests = this._blocks.want(markdownBlocks(text), width, this._folder());
        const document = markdownPreview(text, requests);
        buffer.text = document.text;
        for (const tag of this._tags.values())
            buffer.remove_tag(tag, ...buffer.get_bounds());
        buffer.remove_tag(this._blockHidden, ...buffer.get_bounds());
        for (const tag of this._blockRoomTags.values())
            buffer.remove_tag(tag, ...buffer.get_bounds());
        const spans = this._spans(document.text);
        const offsets = charOffsets(document.text, spans.flatMap(({start, end}) => [start, end]));
        for (const {start, end, style} of spans) {
            buffer.apply_tag(this._tags.get(style),
                buffer.get_iter_at_offset(offsets.get(start)),
                buffer.get_iter_at_offset(offsets.get(end)));
        }
        this._updateBlocks(text, document, requests);
    }

    setRendered(rendered) {
        rendered = Boolean(rendered);
        if (this._rendered === rendered)
            return;
        this._rendered = rendered;
        this.widget.visible_child_name = rendered ? 'rendered' : 'source';
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

    _updateBlocks(text, document, pictures) {
        const chars = charOffsets(document.text, document.blocks.map(block => block.previewStart));
        const placed = [];
        for (let i = 0; i < pictures.length; i++) {
            const picture = pictures[i];
            const offset = chars.get(document.blocks[i].previewStart);
            const iter = this._buffer.get_iter_at_offset(offset);
            this._buffer.apply_tag(this._blockHidden, iter,
                this._buffer.get_iter_at_offset(offset + 1));
            let width = picture.width, height = picture.height;
            if (picture.state === 'ready') {
                const maxWidth = picture.kind === 'mermaid' ? 380 : 560;
                const maxHeight = picture.kind === 'mermaid' ? 320 : 420;
                const scale = Math.min(1, maxWidth / width, maxHeight / height);
                width = Math.max(1, Math.round(width * scale));
                height = Math.max(1, Math.round(height * scale));
                const lineHeight = Math.max(1, this._view.get_iter_location(iter).height);
                const room = this._blockRoomTag(`block:${picture.key}`, {
                    pixels_below_lines: Math.max(0, height - lineHeight + 4),
                });
                this._buffer.apply_tag(room, iter, this._buffer.get_iter_at_offset(offset + 1));
            }
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

    _blockRoomTag(key, properties) {
        let tag = this._blockRoomTags.get(key);
        if (!tag) {
            tag = new Gtk.TextTag({name: `froonty-block-room-${this._blockRoomTags.size}`, ...properties});
            this._buffer.get_tag_table().add(tag);
            this._blockRoomTags.set(key, tag);
        }
        return tag;
    }

    _placeBlocks() {
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
            if (!picture) {
                picture = new Gtk.Picture({can_target: false, can_shrink: true,
                    content_fit: Gtk.ContentFit.CONTAIN,
                    halign: Gtk.Align.START, valign: Gtk.Align.START});
                this._overlay.put(picture, x, y);
                this._blockPictures.push(picture);
            } else {
                this._overlay.move(picture, x, y);
            }
            if (placed.state === 'ready') {
                try {
                    picture.paintable = Gdk.Texture.new_from_bytes(new GLib.Bytes(placed.png));
                } catch {
                    picture.paintable = null;
                }
                picture.set_size_request(Math.round(placed.width), Math.round(placed.height));
                picture.visible = Boolean(picture.paintable);
            } else {
                picture.visible = false;
                picture.paintable = null;
            }
            let status = this._blockStatuses[i];
            if (placed.state !== 'ready') {
                if (!status) {
                    status = new Gtk.Label({xalign: 0, css_classes: ['dim-label']});
                    this._overlay.put(status, x, y);
                    this._blockStatuses[i] = status;
                } else {
                    this._overlay.move(status, x, y);
                }
                status.label = placed.state === 'pending'
                    ? `Rendering ${placed.kind}…` : `Could not render ${placed.kind}`;
                status.tooltip_text = placed.error ?? '';
                status.visible = true;
            } else if (status) {
                status.visible = false;
            }
        });
        for (const picture of this._blockPictures.slice(this._placedBlocks?.length ?? 0)) {
            picture.visible = false;
            picture.paintable = null;
        }
        for (const status of this._blockStatuses.slice(this._placedBlocks?.length ?? 0))
            status.visible = false;
        this._placedTasks.forEach((task, i) => {
            let check = this._taskChecks[i];
            if (!check) {
                check = new Gtk.CheckButton({width_request: 18, height_request: 18,
                    halign: Gtk.Align.START, valign: Gtk.Align.START,
                    css_classes: ['flat', 'froonty-task-check']});
                check.connect('toggled', () => {
                    if (this._updatingTasks || !this._sourceView.editable)
                        return;
                    const task = this._placedTasks[i];
                    if (!task)
                        return;
                    const replacement = toggleTask(this._sourceBuffer.text, task.sourceOffset);
                    if (replacement === null)
                        return;
                    const before = [...this._sourceBuffer.text], after = [...replacement];
                    let head = 0;
                    while (head < before.length && before[head] === after[head])
                        head++;
                    let tail = 0;
                    while (tail < before.length - head &&
                        before[before.length - 1 - tail] === after[after.length - 1 - tail])
                        tail++;
                    const buffer = this._sourceBuffer;
                    const cursor = buffer.cursor_position;
                    buffer.begin_user_action();
                    buffer.delete(buffer.get_iter_at_offset(head),
                        buffer.get_iter_at_offset(before.length - tail));
                    buffer.insert(buffer.get_iter_at_offset(head),
                        after.slice(head, after.length - tail).join(''), -1);
                    buffer.place_cursor(buffer.get_iter_at_offset(Math.min(cursor,
                        buffer.get_char_count())));
                    buffer.end_user_action();
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
            this._overlay.move(check, x + Math.max(0, (markerWidth - 18) / 2),
                lineY + Math.max(0, (box.height - 18) / 2));
            check.visible = true;
        });
        for (const check of this._taskChecks.slice(this._placedTasks.length))
            check.visible = false;
    }

    _destroy() {
        if (this._placeId)
            GLib.source_remove(this._placeId);
        this._placeId = 0;
        this._blocks.destroy();
        for (const [adjustment, ids] of this._adjustments) {
            for (const id of ids)
                adjustment.disconnect(id);
        }
        this._adjustments = [];
        this._placedBlocks = [];
        this._blockPictures = [];
        this._blockStatuses = [];
        this._placedTasks = [];
        this._taskChecks = [];
    }

    _followAdjustments() {
        for (const [adjustment, ids] of this._adjustments) {
            for (const id of ids)
                adjustment.disconnect(id);
        }
        this._adjustments = [];
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
            return this.math.update(text, -1, true);
        // local:end notes-math
        return markdownSpans(text, -1);
    }
}
