// SPDX-License-Identifier: GPL-3.0-or-later
// Coordinates source editing with the flow-based Markdown preview. The
// Markdown/source button chooses the mode; focus and hover never affect it.
//
// Hidden markers are drawn at a twentieth of the size in the muted colour:
// Pango has no "invisible" attribute (and Clutter ignores Pango's
// foreground alpha), and this keeps every character in place, so cursor
// positions and the formatting bar's edits are those of the plain text.
// The muted colour (markers, quotes, done items) comes from the editor's
// CSS (-froonty-markdown-muted), so it follows the note's colour.

import Pango from 'gi://Pango';

import {IslandMarkdownBlocks} from './renderer/island.js';
import {IslandMarkdownPreview} from './renderer/preview.js';
import {byteOffsets, markdownSpans} from './render.js';
// local:begin notes-math (working-tree only; tools/pack-public strips it)
import {IslandMath} from '../formulas/notes/island.js';
// local:end notes-math

const OPAQUE = 65535;
const HEADING_SCALE = {h1: 1.45, h2: 1.3, h3: 1.15};

// Pango attributes for one span style; `muted` is a Cogl.Color.
function attributesFor(style, muted) {
    const mutedColor = () => Pango.attr_foreground_new(muted.red * 257, muted.green * 257,
        muted.blue * 257);
    switch (style) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
        return [Pango.attr_weight_new(Pango.Weight.BOLD),
            ...style in HEADING_SCALE ? [Pango.attr_scale_new(HEADING_SCALE[style])] : []];
    case 'bold':
        return [Pango.attr_weight_new(Pango.Weight.BOLD)];
    case 'italic':
        return [Pango.attr_style_new(Pango.Style.ITALIC)];
    case 'strike':
        return [Pango.attr_strikethrough_new(true)];
    case 'code':
        return [Pango.attr_family_new('monospace'), Pango.attr_background_new(0, 0, 0),
            Pango.attr_background_alpha_new(Math.round(0.08 * OPAQUE))];
    case 'fence':
        return [Pango.attr_family_new('monospace')];
    case 'link':
        return [Pango.attr_underline_new(Pango.Underline.SINGLE)];
    case 'quote':
        return [Pango.attr_style_new(Pango.Style.ITALIC), mutedColor()];
    case 'done':
        return [Pango.attr_strikethrough_new(true), mutedColor()];
    case 'marker':
        return [mutedColor()];
    case 'taskbox':
        // Preserve the three source characters' width below the checkbox.
        return [mutedColor()];
    case 'hidden':
        return [mutedColor(), Pango.attr_scale_new(0.05)];
    default:
        return [];
    }
}

/** The Pango attributes that draw `text` as rendered Markdown. */
export function markdownAttributes(text, activeLine, muted) {
    return spanAttributes(text, markdownSpans(text, activeLine), muted);
}

/** The Pango attributes for render.js spans of `text`. */
export function spanAttributes(text, spans, muted) {
    const list = new Pango.AttrList();
    const bytes = byteOffsets(text);
    for (const {start, end, style} of spans) {
        for (const attribute of attributesFor(style, muted)) {
            attribute.start_index = bytes[start];
            attribute.end_index = bytes[end];
            list.insert(attribute);
        }
    }
    return list;
}

export class MarkdownStyler {
    /** @param {St.Entry} entry the editor; signals die with it */
    constructor(entry, {folder = () => null} = {}) {
        const text = entry.clutter_text;
        this._entry = entry;
        this._text = text;
        this._line = null;
        this._rendered = true;
        this._folder = folder;
        // A grey that reads on every note colour until the CSS is known.
        this._muted = {red: 128, green: 128, blue: 128};
        // The note's colour changes the editor's style, and its muted colour.
        entry.connect('style-changed', () => {
            const [found, color] = entry.get_theme_node().lookup_color('-froonty-markdown-muted', false);
            if (found)
                this._muted = color;
            this.update(true);
        });
        text.connect('text-changed', () => this.update(true));
        // local:begin notes-math
        // Formulas drawn as pictures (features/formulas/notes/island.js).
        this.math = new IslandMath(entry, {spanAttributes, restyle: () => this.update(true)});
        // local:end notes-math
        this.blocks = new IslandMarkdownBlocks(entry, {spanAttributes,
            restyle: () => this.update(true), folder: this._folder});
        this.preview = new IslandMarkdownPreview(entry);
        this.update(true);
    }

    /** Restyles; unless `force`, only when the edited line changed. */
    update(force = false) {
        const text = this._text;
        const line = -1;
        if (!force && line === this._line)
            return;
        this._line = line;
        const pictures = this.blocks.pictures(text.text,
            Math.max(600, this._entry.get_width(), this.preview.widget.get_width()));
        this.preview.setEditable(text.editable);
        this.preview.update(text.text, pictures);
        this.preview.widget.visible = this._rendered;
        this._entry.visible = !this._rendered;
        this.blocks.layer.visible = false;
        this.math.layer.visible = false;
        this.blocks.attributes(text.text, line, this._muted, new Pango.AttrList(), false);
        // local:begin notes-math
        if (this.math) {
            text.set_attributes(this.math.attributes(text.text, line, this._muted, false));
            return;
        }
        // local:end notes-math
        const attrs = this._rendered
            ? markdownAttributes(text.text, line, this._muted) : new Pango.AttrList();
        text.set_attributes(attrs);
    }

    setRendered(rendered) {
        rendered = Boolean(rendered);
        if (this._rendered === rendered)
            return;
        this._rendered = rendered;
        this.preview.widget.visible = rendered;
        this.math.layer.visible = !rendered;
        this.update(true);
    }

    setEditable(editable) {
        this.preview.setEditable(editable);
    }

    setWrap(wrap) {
        this.preview.setWrap(wrap);
    }
}
