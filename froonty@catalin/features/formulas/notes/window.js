// SPDX-License-Identifier: GPL-3.0-or-later
// Formulas in the All notes window's editor (docs/features/notes.md,
// "Formulas"; working-tree builds only), as in the island (island.js):
// $…$ and $$…$$ drawn as pictures on the lines without the cursor, as
// LaTeX on the line being edited. The buffer, its undo history and the
// note's file stay the plain Markdown: only text tags and overlays change.
//
// How (render.js finds the formulas; MarkdownStyler asks update() on each
// restyle):
// - A formula's characters are drawn transparent and almost no size
//   (never "invisible": GtkTextBuffer:text, which the pane saves, leaves
//   invisible characters out). Its first character makes room for the
//   picture: letter spacing as wide as it, raised by its height above the
//   baseline, and the last one lowered by its depth below, so the line is
//   as tall as the picture. A formula alone on its lines gets the
//   picture's height as space above its first line instead, and is
//   centred.
// - The pictures are overlays of the text view (add_overlay(), buffer
//   coordinates, so they scroll with the text), placed from the iterators'
//   locations after GTK has laid the lines out: once at once, and again
//   when GTK is idle, and when the view's width or height changes.
// - Pictures come from the shared renderer (images.js) in the text colour
//   of the style (light or dark), at the editor's font size and scale.
//   Until one comes, the formula shows as dimmed source; one MathJax
//   refuses shows its source underlined, MathJax's message as its
//   tooltip; without MathJax the source shows as text.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import {charOffsets, mathMarkdownSpans} from '../../notes/render.js';
import {EM_PX, FormulaImages} from './images.js';

const hex = rgba => `#${[rgba.red, rgba.green, rgba.blue]
    .map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;

// A texture drawn at its size in logical pixels (a picture drawn for a
// scale of 2 is twice as large in pixels as on screen). Registered when
// first needed, not at import.
let ScaledTexture = null;
function scaledTexture(texture, width, height) {
    ScaledTexture ??= GObject.registerClass({
        GTypeName: 'FroontyNotesScaledTexture',
        Implements: [Gdk.Paintable],
    }, class extends GObject.Object {
        _init(params) {
            super._init();
            Object.assign(this, params);
        }

        vfunc_get_intrinsic_width() {
            return this.width;
        }

        vfunc_get_intrinsic_height() {
            return this.height;
        }

        vfunc_snapshot(snapshot, width, height) {
            this.texture.snapshot(snapshot, width, height);
        }
    });
    return new ScaledTexture({texture, width, height});
}

export class WindowMath {
    /**
     * @param {Gtk.TextView} view the editor; this goes with it
     * @param {Function} restyle restyles the editor (the styler's
     *   update(true)), which calls update()
     */
    constructor(view, restyle) {
        this._view = view;
        this._buffer = view.buffer;
        this._restyle = restyle;
        this._images = new FormulaImages(() => this._restyle());
        const table = this._buffer.get_tag_table();
        // After the Markdown tags: a formula's characters stay hidden in a
        // heading too.
        this._hidden = new Gtk.TextTag({
            name: 'froonty-math-hidden',
            foreground: 'rgba(0, 0, 0, 0)',
            scale: 0.01,
            allow_breaks: false,
        });
        this._refused = new Gtk.TextTag({name: 'froonty-math-refused', underline: Pango.Underline.ERROR});
        table.add(this._hidden);
        table.add(this._refused);
        this._boxTags = new Map(); // properties → tag, made as needed
        this._placed = []; // {offset, block, width, height, paintable}
        this._refusals = []; // {start, end, message}, character offsets
        this._pictures = []; // overlays, the ones not needed now hidden
        this._placeId = 0;
        this._adjustments = [];
        this._styleIds = [];
        this._destroyed = false;

        view.has_tooltip = true;
        view.connect('query-tooltip', (_view, x, y, keyboard, tooltip) =>
            this._tooltip(x, y, keyboard, tooltip));
        // Width and height changes come through the scrolled window's
        // adjustments.
        view.connect('notify::hadjustment', () => this._followAdjustments());
        view.connect('notify::vadjustment', () => this._followAdjustments());
        this._followAdjustments();
        // Light or dark: the text colour changes, and so the pictures.
        view.connect('map', () => {
            const style = Adw.StyleManager.get_default();
            this._unfollowStyle();
            this._styleIds = ['notify::dark', 'notify::high-contrast']
                .map(signal => style.connect(signal, () => this._restyle()));
            this._restyle();
        });
        view.connect('unmap', () => this._unfollowStyle());
        view.connect('destroy', () => this._destroy());
    }

    /** The formulas drawn (tests): {offset, block, width, height, paintable}. */
    get placed() {
        return this._placed;
    }

    /**
     * Tags the formulas of `text` (the buffer's) and places their
     * pictures; asks for those it does not have yet.
     *
     * @param {string} text
     * @param {number} line the edited line, -1 for none
     * @returns {object[]} the Markdown spans to draw (render.js)
     */
    update(text, line) {
        const buffer = this._buffer;
        const {spans, formulas} = mathMarkdownSpans(text, line);
        const {color, scale, resource} = this._style();
        for (const tag of [this._hidden, this._refused, ...this._boxTags.values()])
            buffer.remove_tag(tag, ...buffer.get_bounds());

        const requests = [];
        const tags = []; // [tag, start, end], UTF-16 indices
        const placed = [];
        const refusals = [];
        for (const formula of formulas) {
            const request = {tex: formula.tex, display: formula.display, color, scale};
            requests.push(request);
            if (formula.active)
                continue;
            const entry = this._images.get(request);
            const state = entry?.state ?? 'pending';
            if (state === 'pending') {
                spans.push({start: formula.start, end: formula.end, style: 'marker'});
            } else if (state === 'error') {
                tags.push([this._refused, formula.start, formula.end]);
                refusals.push({start: formula.start, end: formula.end, message: entry.message});
            } else if (state === 'ready' && this._texture(entry)) {
                placed.push(this._makeRoom(text, formula, entry, resource, tags));
            }
        }
        this._images.want(requests);

        const offsets = charOffsets(text, [
            ...tags.flatMap(([, start, end]) => [start, end]),
            ...placed.map(p => p.start),
            ...refusals.flatMap(r => [r.start, r.end]),
        ]);
        const iter = index => buffer.get_iter_at_offset(offsets.get(index));
        for (const [tag, start, end] of tags)
            buffer.apply_tag(tag, iter(start), iter(end));
        for (const p of placed)
            p.offset = offsets.get(p.start);
        this._placed = placed;
        this._refusals = refusals.map(r => ({...r, start: offsets.get(r.start), end: offsets.get(r.end)}));
        this._pruneBoxTags(new Set(tags.map(([tag]) => tag)));
        // Now (lines above may still move), and again once GTK has laid
        // the changed lines out.
        this._place();
        this._queuePlace();
        return spans;
    }

    // Tags (into `tags`) that make room for a drawn formula.
    _makeRoom(text, formula, entry, resource, tags) {
        const width = entry.result.width / resource;
        const height = entry.result.height / resource;
        const above = entry.result.baseline / resource;
        let {start, end} = formula;
        if (formula.block) {
            // Its lines, spaces around it included, hold nothing else.
            start = text.lastIndexOf('\n', formula.start - 1) + 1;
            const lineEnd = text.indexOf('\n', formula.end);
            end = lineEnd < 0 ? text.length : lineEnd;
            tags.push([this._hidden, start, end]);
            tags.push([this._boxTag({pixels_above_lines: Math.ceil(height)}), start, formula.start + 1]);
        } else {
            tags.push([this._hidden, start, end]);
            tags.push([this._boxTag({
                letter_spacing: Math.round(width * Pango.SCALE),
                rise: Math.round(above * Pango.SCALE),
            }), start, start + 1]);
            tags.push([this._boxTag({rise: -Math.round((height - above) * Pango.SCALE)}), end - 1, end]);
        }
        return {start: formula.start, block: formula.block, width, height, paintable: entry.paintable};
    }

    // One tag per set of properties, just under the hidden one (so a
    // search match, added after the styler's tags, stays on top).
    _boxTag(properties) {
        const key = JSON.stringify(properties);
        let tag = this._boxTags.get(key);
        if (!tag) {
            tag = new Gtk.TextTag(properties);
            this._buffer.get_tag_table().add(tag);
            tag.set_priority(this._hidden.get_priority());
            this._boxTags.set(key, tag);
        }
        return tag;
    }

    _pruneBoxTags(used) {
        for (const [key, tag] of this._boxTags) {
            if (!used.has(tag)) {
                this._buffer.get_tag_table().remove(tag);
                this._boxTags.delete(key);
            }
        }
    }

    // The picture as a paintable of its size on screen; null when it
    // cannot be read.
    _texture(entry) {
        if (entry.paintable === undefined) {
            try {
                const {png} = entry.result;
                const {resource} = this._style();
                entry.paintable = scaledTexture(Gdk.Texture.new_from_bytes(png),
                    entry.result.width / resource, entry.result.height / resource);
            } catch (e) {
                entry.paintable = null;
            }
        }
        return entry.paintable;
    }

    // The text colour (the style's), and the scale for the editor's font
    // at the window's scale, rounded so that the requests repeat.
    _style() {
        const view = this._view;
        const color = hex(view.get_color());
        const context = view.get_pango_context();
        const font = context.get_font_description();
        let px = EM_PX;
        if (font && font.get_size() > 0) {
            px = font.get_size() / Pango.SCALE;
            if (!font.get_size_is_absolute()) {
                const dpi = PangoCairo.context_get_resolution(context);
                px *= (dpi > 0 ? dpi : 96) / 72;
            }
        }
        const resource = view.get_native()?.get_surface()?.get_scale?.() || view.get_scale_factor() || 1;
        return {color, resource, scale: Math.round(px / EM_PX * resource * 100) / 100};
    }

    _queuePlace() {
        if (this._placeId || this._destroyed)
            return;
        // After GTK's own idle work (laying out the changed lines).
        this._placeId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._placeId = 0;
            this._place();
            return GLib.SOURCE_REMOVE;
        });
    }

    // The pictures over the room made for them.
    _place() {
        const view = this._view;
        const buffer = this._buffer;
        const wide = view.get_width() - view.left_margin - view.right_margin;
        this._placed.forEach((placed, i) => {
            const iter = buffer.get_iter_at_offset(placed.offset);
            let x, y;
            if (placed.block) {
                const [top] = view.get_line_yrange(iter);
                iter.set_line_offset(0);
                x = view.get_iter_location(iter).x + Math.max(0, (wide - placed.width) / 2);
                y = top;
            } else {
                const box = view.get_iter_location(iter);
                x = box.x;
                y = box.y;
            }
            x = Math.round(x);
            y = Math.round(y);
            let picture = this._pictures[i];
            if (!picture) {
                picture = new Gtk.Picture({can_target: false, can_shrink: true, content_fit: Gtk.ContentFit.FILL});
                view.add_overlay(picture, x, y);
                this._pictures.push(picture);
            } else {
                view.move_overlay(picture, x, y);
            }
            picture.paintable = placed.paintable;
            picture.set_size_request(Math.round(placed.width), Math.round(placed.height));
            picture.visible = true;
        });
        // Kept for later, hidden: GTK 4.20's remove() does not take an
        // overlay off ("not a child of GtkTextView").
        for (const picture of this._pictures.slice(this._placed.length)) {
            picture.visible = false;
            picture.paintable = null;
        }
    }

    // MathJax's message over a formula it refused.
    _tooltip(x, y, keyboard, tooltip) {
        if (keyboard || !this._refusals.length)
            return false;
        const [bx, by] = this._view.window_to_buffer_coords(Gtk.TextWindowType.WIDGET, x, y);
        const [found, iter] = this._view.get_iter_at_location(bx, by);
        if (!found)
            return false;
        const offset = iter.get_offset();
        const refusal = this._refusals.find(r => offset >= r.start && offset < r.end);
        if (!refusal)
            return false;
        tooltip.set_text(refusal.message);
        return true;
    }

    _followAdjustments() {
        for (const [adjustment, id] of this._adjustments)
            adjustment.disconnect(id);
        this._adjustments = [];
        const h = this._view.get_hadjustment();
        const v = this._view.get_vadjustment();
        if (h) {
            this._adjustments.push([h, h.connect('notify::page-size', () => {
                // Centred ones move with the width; wrapped lines too.
                this._queuePlace();
            })]);
        }
        if (v)
            this._adjustments.push([v, v.connect('changed', () => this._queuePlace())]);
    }

    _unfollowStyle() {
        const style = Adw.StyleManager.get_default();
        for (const id of this._styleIds)
            style.disconnect(id);
        this._styleIds = [];
    }

    _destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        if (this._placeId)
            GLib.source_remove(this._placeId);
        this._placeId = 0;
        this._unfollowStyle();
        for (const [adjustment, id] of this._adjustments)
            adjustment.disconnect(id);
        this._adjustments = [];
        this._images.destroy();
        this._placed = [];
        this._pictures = [];
    }
}
