// SPDX-License-Identifier: GPL-3.0-or-later
// Formulas in the island's Notes editor (docs/features/notes.md,
// "Formulas"; working-tree builds only): $…$ and $$…$$ drawn as pictures
// on the lines without the cursor, as LaTeX on the line being edited. The
// note's text, and so its file, stays plain Markdown: only how the text is
// laid out changes, and pictures are drawn over it.
//
// How (render.js finds the formulas, MarkdownStyler asks attributes() on
// each restyle):
// - A Pango shape attribute on a formula's first character reserves a box
//   of the picture's size, its baseline on the line's baseline; the
//   formula's other characters get a shape of no size. Clutter.Text lays
//   shapes out (lines grow for a tall formula, a block of lines that holds
//   nothing else takes no room) and draws nothing in them, and every
//   character stays where it is for the cursor and the formatting bar.
// - The pictures are actors in `layer`, a sibling of the editor in its
//   scrolled box (a child of the Clutter.Text itself would not be drawn),
//   placed before each redraw at the reserved boxes (position_to_coords).
// - Pictures come from the shared renderer (images.js), at the note's text
//   colour and size and the editor's resource scale. Until one comes, the
//   formula shows as dimmed source; a formula MathJax refuses shows its
//   source underlined; without MathJax the source shows as text.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {byteOffsets, charOffsets, mathMarkdownSpans} from '../../notes/render.js';
import {EM_PX, FormulaImages} from './images.js';

const hex = color => `#${[color.red, color.green, color.blue]
    .map(c => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

// A Pango shape: a box of width × height px whose top is `top` px above
// the baseline.
function shapeAttribute(start, end, width, height, top) {
    const box = new Pango.Rectangle();
    box.x = 0;
    box.y = Math.round(-top * Pango.SCALE);
    box.width = Math.round(width * Pango.SCALE);
    box.height = Math.round(height * Pango.SCALE);
    const attribute = Pango.attr_shape_new(box, box);
    attribute.start_index = start;
    attribute.end_index = end;
    return attribute;
}

// The picture as actor content, or null when it cannot be read.
function imageContent({png, width, height}) {
    const loader = new GdkPixbuf.PixbufLoader();
    try {
        loader.write_bytes(png);
        loader.close();
        const pixbuf = loader.get_pixbuf();
        const context = global.stage.context.get_backend().get_cogl_context();
        const content = St.ImageContent.new_with_preferred_size(width, height);
        content.set_bytes(context, pixbuf.read_pixel_bytes(),
            pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
            pixbuf.width, pixbuf.height, pixbuf.rowstride);
        return content;
    } catch (e) {
        try {
            loader.close();
        } catch {}
        return null;
    }
}

export class IslandMath {
    /**
     * @param {St.Entry} entry the Notes editor; this goes with it
     * @param {object} hooks
     * @param {Function} hooks.spanAttributes (text, spans, muted) →
     *   Pango.AttrList (styler.js)
     * @param {Function} hooks.restyle restyles the editor (the styler's
     *   update(true)), which calls attributes()
     */
    constructor(entry, {spanAttributes, restyle}) {
        this._entry = entry;
        this._text = entry.clutter_text;
        this._spanAttributes = spanAttributes;
        this._restyle = restyle;
        this._images = new FormulaImages(() => this._restyle());
        // For the editor's box, after the editor. Of no size, so it takes
        // no room; its children are drawn over the text.
        this.layer = new Clutter.Actor({name: 'froonty-notes-math', width: 0, height: 0});
        this._actors = [];
        this._placed = [];
        this._centred = false;
        this._width = 0;
        this._laterId = 0;
        this._layerGone = false;
        this._text.connect('notify::allocation', () => this._queuePlace());
        // Wrapped lines centre formulas on lines of their own.
        this._text.connect('notify::line-wrap', () => this._restyle());
        this.layer.connect('notify::allocation', () => this._queuePlace());
        this.layer.connect('destroy', () => (this._layerGone = true));
        entry.connect('destroy', () => this._destroy());
    }

    /** The formulas' places, in text coordinates (tests). */
    get placed() {
        return this._placed;
    }

    /**
     * The editor's attributes: the Markdown's (spanAttributes) and the
     * formulas'. Asks for pictures it does not have yet.
     *
     * @param {string} text
     * @param {number} line the edited line, -1 for none
     * @param {Cogl.Color} muted
     * @returns {Pango.AttrList}
     */
    attributes(text, line, muted) {
        const {spans, formulas} = mathMarkdownSpans(text, line);
        const {color, scale, resource} = this._style();
        const width = this._text.get_width();
        const wrap = this._text.line_wrap;
        const requests = [];
        const ready = [];
        const refused = [];
        for (const formula of formulas) {
            const request = {tex: formula.tex, display: formula.display, color, scale};
            requests.push(request);
            if (formula.active)
                continue;
            const entry = this._images.get(request);
            switch (entry?.state ?? 'pending') {
            case 'ready':
                if (entry.content === undefined)
                    entry.content = imageContent(entry.result); // null: unreadable
                if (entry.content)
                    ready.push({formula, entry});
                break;
            case 'error':
                refused.push(formula);
                break;
            case 'pending':
                spans.push({start: formula.start, end: formula.end, style: 'marker'});
                break;
            }
        }
        this._images.want(requests);

        const list = this._spanAttributes(text, spans, muted);
        const bytes = byteOffsets(text);
        const insert = (attribute, start, end) => {
            attribute.start_index = bytes[start];
            attribute.end_index = bytes[end];
            list.insert(attribute);
        };
        for (const {start, end} of refused) {
            insert(Pango.attr_underline_new(Pango.Underline.ERROR), start, end);
            insert(Pango.attr_underline_color_new(muted.red * 257, muted.green * 257, muted.blue * 257),
                start, end);
        }
        const positions = charOffsets(text, ready.map(({formula}) => formula.start));
        this._centred = false;
        this._placed = ready.map(({formula, entry}) => {
            const {start, end, block} = formula;
            const w = entry.result.width / resource;
            const h = entry.result.height / resource;
            // Alone on its lines, with lines wrapped: centred in the editor.
            const centred = block && wrap && width - 1 > w;
            const box = centred ? Math.floor(width) - 1 : Math.ceil(w);
            this._centred ||= centred;
            list.insert(shapeAttribute(bytes[start], bytes[start + 1], box, h, entry.result.baseline / resource));
            list.insert(shapeAttribute(bytes[start + 1], bytes[end], 0, 0, 0));
            insert(Pango.attr_allow_breaks_new(false), start, end);
            if (block) {
                // The spaces around it on its lines take no room either.
                const lineStart = text.lastIndexOf('\n', start - 1) + 1;
                const lineEnd = text.indexOf('\n', end);
                for (const [from, to] of [[lineStart, start], [end, lineEnd < 0 ? text.length : lineEnd]]) {
                    if (to > from)
                        list.insert(shapeAttribute(bytes[from], bytes[to], 0, 0, 0));
                }
            }
            return {position: positions.get(start), content: entry.content, width: w, height: h, box, tex: formula.tex};
        });
        this._width = width;
        this._queuePlace();
        return list;
    }

    // The pictures' colour (the note's text) and scale (its font size, at
    // the editor's resource scale, rounded so that the requests repeat).
    _style() {
        const node = this._entry.peek_theme_node();
        const color = node ? hex(node.get_foreground_color()) : '#000000';
        // The theme node's font, not the Clutter.Text's: reading that one
        // (font-description, or its getter) again and again crashed GNOME
        // Shell 50 (free(): invalid pointer, checked in the headless Shell).
        const font = node?.get_font() ?? null;
        let px = EM_PX;
        if (font && font.get_size() > 0) {
            px = font.get_size() / Pango.SCALE;
            if (!font.get_size_is_absolute())
                px *= Clutter.get_default_backend().get_resolution() / 72;
        }
        const resource = this._text.get_resource_scale() || 1;
        return {color, resource, scale: Math.round(px / EM_PX * resource * 100) / 100};
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

    // The pictures over their boxes, after layout.
    _place() {
        const text = this._text;
        // A new width moves the centred ones: lay out again first.
        if (this._centred && text.get_width() !== this._width) {
            this._restyle();
            return;
        }
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
            actor.set_size(placed.width, placed.height);
            actor.set_position(Math.round(dx + x + (placed.box - placed.width) / 2), Math.round(dy + y));
            actor.visible = ok;
        });
        for (const actor of this._actors.splice(this._placed.length))
            actor.destroy();
    }

    _destroy() {
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        this._images.destroy();
        this._placed = [];
        this._actors = [];
        if (!this._layerGone)
            this.layer.destroy();
    }
}
