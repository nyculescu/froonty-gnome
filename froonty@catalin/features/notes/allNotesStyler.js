// SPDX-License-Identifier: GPL-3.0-or-later
// Draws the All notes window's editor as rendered Markdown (render.js), as
// the island's MarkdownStyler (styler.js) does: text tags on the
// GtkTextBuffer, recomputed on each edit, when the cursor moves to another
// line (that line shows its markers, dimmed), and when the editor gains or
// loses the focus (without it, every marker is hidden). The text itself,
// and so the note's file, stays plain Markdown.
//
// Hidden markers are drawn transparent at a twentieth of the size, not with
// the tags' "invisible" property: GtkTextBuffer:text leaves invisible
// characters out, and the pane saves that text. As in the island, every
// character also stays in place for the cursor and the formatting bar.
//
// The muted colour (markers, quotes, done items) is a mid grey, which reads
// on light and dark styles alike; the window's editor has no note colour.

import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {charOffsets, lineAt, markdownSpans} from './render.js';
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
    hidden: {foreground: 'rgba(0, 0, 0, 0)', scale: 0.05},
};

export class MarkdownStyler {
    /** @param {Gtk.TextView} view the editor; signals die with it */
    constructor(view) {
        const buffer = view.buffer;
        this._buffer = buffer;
        this._line = null;
        this._tags = new Map();
        for (const [style, properties] of Object.entries(STYLES)) {
            const tag = new Gtk.TextTag({name: `froonty-markdown-${style}`, ...properties});
            buffer.get_tag_table().add(tag);
            this._tags.set(style, tag);
        }
        this._focus = new Gtk.EventControllerFocus();
        this._focus.connect('notify::is-focus', () => this.update(true));
        view.add_controller(this._focus);
        buffer.connect('changed', () => this.update(true));
        buffer.connect('notify::cursor-position', () => this.update());
        // local:begin notes-math
        // Formulas drawn as pictures (features/formulas/notes/window.js).
        this.math = new WindowMath(view, () => this.update(true));
        // local:end notes-math
        this.update(true);
    }

    /** Restyles; unless `force`, only when the edited line changed. */
    update(force = false) {
        const buffer = this._buffer;
        const text = buffer.get_text(...buffer.get_bounds(), true);
        const line = this._focus.is_focus ? lineAt(text, buffer.cursor_position) : -1;
        if (!force && line === this._line)
            return;
        this._line = line;
        for (const tag of this._tags.values())
            buffer.remove_tag(tag, ...buffer.get_bounds());
        const spans = this._spans(text, line);
        const offsets = charOffsets(text, spans.flatMap(({start, end}) => [start, end]));
        for (const {start, end, style} of spans) {
            buffer.apply_tag(this._tags.get(style), buffer.get_iter_at_offset(offsets.get(start)),
                buffer.get_iter_at_offset(offsets.get(end)));
        }
    }

    _spans(text, line) {
        // local:begin notes-math
        if (this.math)
            return this.math.update(text, line);
        // local:end notes-math
        return markdownSpans(text, line);
    }
}
