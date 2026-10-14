// SPDX-License-Identifier: GPL-3.0-or-later
// Mermaid diagrams, Markdown tables and local images over the live Notes
// text. The PNGs sit over the source; the source remains the editable file.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {byteOffsets, lineAt, markdownTasks, toggleTask} from '../render.js';
import {markdownBlocks} from '../blocks.js';
import {MarkdownBlockPictures} from './blocks.js';

function shape(start, end, width, height) {
    const bottomGap = 4;
    const logical = new Pango.Rectangle();
    logical.x = 0;
    logical.y = -Math.round(height * Pango.SCALE);
    logical.width = Math.round(width * Pango.SCALE);
    logical.height = Math.round((height + bottomGap) * Pango.SCALE);
    const attr = Pango.attr_shape_new(logical, logical);
    attr.start_index = start;
    attr.end_index = end;
    return attr;
}

export function contentOf(bytes, width, height) {
    const loader = new GdkPixbuf.PixbufLoader();
    try {
        loader.write_bytes(new GLib.Bytes(bytes));
        loader.close();
        const pixbuf = loader.get_pixbuf();
        const context = global.stage.context.get_backend().get_cogl_context();
        const content = St.ImageContent.new_with_preferred_size(width, height);
        content.set_bytes(context, pixbuf.read_pixel_bytes(),
            pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
            pixbuf.width, pixbuf.height, pixbuf.rowstride);
        return content;
    } catch (e) {
        try { loader.close(); } catch {}
        return null;
    }
}

export class IslandMarkdownBlocks {
    constructor(entry, {spanAttributes, restyle, folder}) {
        this._entry = entry;
        this._text = entry.clutter_text;
        this._spanAttributes = spanAttributes;
        this._restyle = restyle;
        this._folder = folder;
        this._pictures = new MarkdownBlockPictures(() => this._restyle());
        this.layer = new Clutter.Actor({name: 'froonty-notes-blocks', width: 0, height: 0});
        this._placed = [];
        this._actors = [];
        this._placedTasks = [];
        this._taskActors = [];
        this._width = 0;
        this._laterId = 0;
        this._layerGone = false;
        this._text.connect('notify::allocation', () => {
            if (this._entry.get_width() !== this._width)
                this._restyle();
            else
                this._queuePlace();
        });
        this._text.connect('notify::line-wrap', () => this._restyle());
        this.layer.connect('notify::allocation', () => this._queuePlace());
        this.layer.connect('destroy', () => (this._layerGone = true));
        entry.connect('destroy', () => this._destroy());
    }

    attributes(text, activeLine, muted, base, enabled = true) {
        if (!enabled) {
            this._placed = [];
            this._placedTasks = [];
            this._queuePlace();
            return base;
        }
        const width = this._entry.get_width();
        this._width = width;
        // Block render requests and Pango positions both use logical
        // coordinates. Scaling the request by Clutter's raster scale and
        // dividing the result again made island blocks much smaller than
        // the same blocks in the GTK All notes editor.
        const available = Math.max(120, Math.min(620, width || 120));
        const blocks = markdownBlocks(text).filter(block => {
            const first = lineAt(text, block.start);
            const last = lineAt(text, Math.max(block.start, block.end - 1));
            return activeLine < first || activeLine > last;
        });
        const entries = this._pictures.want(blocks, available, this._folder());
        this._placedTasks = markdownTasks(text);
        const ready = entries.filter(entry => entry.state === 'ready');
        const hidden = this._spanAttributes(text,
            ready.map(entry => ({start: entry.start, end: entry.end, style: 'hidden'})), muted);
        for (const attribute of hidden.get_attributes())
            base.insert(attribute);
        const bytes = byteOffsets(text);
        // Replace the three source characters with an invisible shaped
        // placeholder. Clutter does not honor transparent foreground alpha,
        // so merely colouring `[ ]` muted left the Markdown token visible
        // underneath the checkbox actor.
        for (const task of this._placedTasks) {
            const attr = shape(bytes[task.start], bytes[task.start + 3], 24, 22);
            base.insert(attr);
        }
        this._placed = [];
        for (const entry of ready) {
            const maxWidth = entry.kind === 'image' ? 340 : 620;
            const maxHeight = entry.kind === 'image' ? 320 : 420;
            const scale = Math.min(1, maxWidth / entry.width, maxHeight / entry.height);
            const widthPx = Math.max(1, Math.round(entry.width * scale));
            const heightPx = Math.max(1, Math.round(entry.height * scale));
            const content = entry.content ??= contentOf(entry.png, widthPx, heightPx);
            if (!content)
                continue;
            const start = bytes[entry.start], end = bytes[entry.end];
            const firstEnd = bytes[entry.start + 1];
            // Reserve the full text width, even when the bitmap is narrow.
            // This makes the rendered block stand alone: adjacent text and
            // later objects can only land above or below it.
            base.insert(shape(start, firstEnd, available, heightPx));
            if (firstEnd < end)
                base.insert(shape(firstEnd, end, 0, 0));
            const breaks = Pango.attr_allow_breaks_new(false);
            breaks.start_index = start;
            breaks.end_index = end;
            base.insert(breaks);
            this._placed.push({position: entry.start, content, width: widthPx, height: heightPx});
        }
        this._queuePlace();
        return base;
    }

    pictures(text, width = this._entry.get_width()) {
        const available = Math.max(120, Math.min(620, width || 120));
        return this._pictures.want(markdownBlocks(text), available, this._folder());
    }

    _queuePlace() {
        if (this._laterId || this._layerGone)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._place();
            return GLib.SOURCE_REMOVE;
        });
    }

    _place() {
        const text = this._text;
        const layer = this.layer.get_allocation_box();
        const entry = this._entry.get_allocation_box();
        const inner = text.get_allocation_box();
        const dx = entry.x1 + inner.x1 - layer.x1;
        const dy = entry.y1 + inner.y1 - layer.y1;
        this._placed.forEach((placed, i) => {
            let actor = this._actors[i];
            if (!actor) {
                actor = new Clutter.Actor();
                this.layer.add_child(actor);
                this._actors.push(actor);
            }
            const [ok, x, y] = text.position_to_coords(placed.position);
            actor.content = placed.content;
            // Keep decoded PNGs proportional even if toolkit scale factors
            // make the reported preferred size differ by a pixel or two.
            actor.set_content_gravity(Clutter.ContentGravity.RESIZE_ASPECT);
            actor.set_size(placed.width, placed.height);
            actor.set_position(Math.round(dx + x), Math.round(dy + y));
            actor.visible = ok;
        });
        for (const actor of this._actors.splice(this._placed.length))
            actor.destroy();
        this._placedTasks.forEach((task, i) => {
            let actor = this._taskActors[i];
            if (!actor) {
                const label = new St.Label({style: 'font-size: 15px; font-weight: bold;'});
                actor = new St.Button({reactive: true, can_focus: true, child: label});
                actor._checkLabel = label;
                actor.connect('clicked', () => {
                    if (!this._text.editable)
                        return;
                    const task = this._placedTasks[i];
                    if (task) {
                        const offset = [...this._text.text.slice(0, task.start)].length;
                        const replacement = toggleTask(this._text.text, offset);
                        if (replacement !== null)
                            this._text.text = replacement;
                    }
                });
                this.layer.add_child(actor);
                this._taskActors.push(actor);
            }
            actor._checkLabel.text = task.checked ? '✓' : '';
            actor.style = task.checked
                ? 'min-width: 22px; min-height: 22px; padding: 0; border: 2px solid #a9330c; border-radius: 4px; background-color: #d54b17; color: white;'
                : 'min-width: 22px; min-height: 22px; padding: 0; border: 2px solid #444; border-radius: 4px; background-color: #fffdf0; color: #222;';
            const [ok, x, y] = text.position_to_coords(task.start);
            actor.set_size(24, 24);
            actor.set_position(Math.round(dx + x), Math.round(dy + y));
            actor.visible = ok;
        });
        for (const actor of this._taskActors.splice(this._placedTasks.length))
            actor.destroy();
    }

    _destroy() {
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        this._pictures.destroy();
        this._placed = [];
        this._actors = [];
        this._placedTasks = [];
        this._taskActors = [];
        if (!this._layerGone)
            this.layer.destroy();
    }
}
