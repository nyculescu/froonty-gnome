// SPDX-License-Identifier: GPL-3.0-or-later
// Coordinates source editing with the flow-based Markdown preview
// (renderer/preview.js). The Markdown/source button chooses the mode; focus
// and hover never affect it. Rendered, the source editor is hidden; as
// source, it shows the plain Markdown.

import {IslandMarkdownBlocks} from './renderer/island.js';
import {IslandMarkdownPreview} from './renderer/preview.js';
// local:begin notes-math (working-tree only; tools/pack-public strips it)
import {lineAt} from './render.js';
import {IslandMath} from '../formulas/notes/island.js';
// local:end notes-math

export class MarkdownStyler {
    /**
     * @param {St.Entry} entry the editor; signals die with it
     * @param {object} options folder and note (getters), and the
     *   preview's (renderer/preview.js): contextMenu, edit, pasteImage,
     *   showFile, tooltip, drawDiagram
     */
    constructor(entry, {folder, note, ...options}) {
        const text = entry.clutter_text;
        this._entry = entry;
        this._text = text;
        this._rendered = true;
        text.connect('text-changed', () => this.update());
        // local:begin notes-math
        // As source, formulas are drawn as pictures, except on the edited
        // line (features/formulas/notes/island.js). The line styled last;
        // null while rendered (no formula attributes).
        this._line = null;
        this.math = new IslandMath(entry, () => this._styleMath());
        const lineMoved = () => this._styleMath(false);
        text.connect('notify::cursor-position', lineMoved);
        text.connect('key-focus-in', lineMoved);
        text.connect('key-focus-out', lineMoved);
        // The note's colour changes the pictures' and the dimmed source's.
        entry.connect('style-changed', () => {
            // Also emitted as it leaves the stage (closing, destroying).
            if (entry.get_stage())
                this._styleMath();
        });
        // local:end notes-math
        this.blocks = new IslandMarkdownBlocks(entry, {restyle: () => this.update(), folder, note});
        this.preview = new IslandMarkdownPreview(entry, {
            ...options,
            folder,
            onResize: (itemKey, size) => {
                this.blocks.resize(itemKey, size);
                this.update();
            },
        });
        this.update();
    }

    /** Shows the preview, rebuilt, or the source editor. */
    update() {
        const text = this._text;
        this.preview.widget.visible = this._rendered;
        this._entry.visible = !this._rendered;
        // local:begin notes-math
        this._styleMath();
        // local:end notes-math
        // While hidden, the preview is neither rebuilt nor asks for renders;
        // setRendered(true) brings it up to date.
        if (!this._rendered)
            return;
        // Laid-out widths only: measuring a widget off the stage (as the
        // view is being built) asks St for a theme node it cannot have.
        const width = actor => (actor.has_allocation() ? actor.width : 0);
        const pictures = this.blocks.pictures(text.text,
            Math.max(600, width(this._entry), width(this.preview.widget)));
        this.preview.update(text.text, pictures);
    }
    // local:begin notes-math

    // The source editor's formulas; unless `force`, only when the edited
    // line changed (no key focus: none). Rendered, the formulas' attributes
    // and pictures go once, and nothing is done until the source shows.
    _styleMath(force = true) {
        // The editor losing the key focus as it is destroyed.
        if (this.math.gone)
            return;
        const text = this._text;
        this.math.layer.visible = !this._rendered;
        if (this._rendered) {
            if (this._line !== null) {
                this._line = null;
                this.math.clear();
                text.set_attributes(null);
            }
            return;
        }
        const line = text.has_key_focus()
            ? lineAt(text.text, text.cursor_position < 0 ? Infinity : text.cursor_position) : -1;
        if (!force && line === this._line)
            return;
        this._line = line;
        text.set_attributes(this.math.attributes(text.text, line));
    }
    // local:end notes-math

    setRendered(rendered) {
        rendered = Boolean(rendered);
        if (this._rendered === rendered)
            return;
        // A field or table open in the preview goes into the source first.
        if (!rendered)
            this.preview.finish();
        this._rendered = rendered;
        this.update();
    }

    setEditable(editable) {
        this.preview.setEditable(editable);
    }

    setWrap(wrap) {
        this.preview.setWrap(wrap);
    }
}
