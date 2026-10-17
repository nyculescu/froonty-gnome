// SPDX-License-Identifier: GPL-3.0-or-later
// Edit Mermaid code, in the island (renderer/preview.js) and in All notes
// (allNotesMermaidEditor.js): the code written back between its fence
// lines, what the editor shows (Code | Split | Preview, kept for the
// session) and its live picture.
//
//   withFenceSource(fence, source) → the fence (a block's Markdown, from
//       its opening line to its closing one) with `source` as its code; the
//       fence lines, info string and all, stay as they were
//   mermaidLayout() / setMermaidLayout(layout): one of LAYOUTS
//   new DiagramDraft(draw, show, delay?): see below

import GLib from 'gi://GLib';

/** What the editor shows: the code alone, both side by side, the picture alone. */
export const LAYOUTS = ['code', 'split', 'preview'];

let layout = 'split';

export const mermaidLayout = () => layout;

export function setMermaidLayout(value) {
    layout = value;
}

export function withFenceSource(fence, source) {
    const open = fence.slice(0, fence.indexOf('\n'));
    const close = fence.slice(fence.lastIndexOf('\n') + 1);
    return source ? `${open}\n${source}\n${close}` : `${open}\n${close}`;
}

// The picture of the code being edited, drawn once typing has paused for
// `delay` ms, one drawing at a time. Only the latest code's shows: a
// drawing finished for older code is dropped, and the latest is drawn next.
export class DiagramDraft {
    /**
     * @param {Function} draw (source) → a promise of the picture
     *   ({png, width, height, warnings}); rejects with the reason
     * @param {Function} show ({picture} or {error}) the latest code's
     * @param {number} delay ms
     */
    constructor(draw, show, delay = 400) {
        this._draw = draw;
        this._show = show;
        this._delay = delay;
        this._source = null;
        this._timer = 0;
        this._drawing = false;
        this._again = false;
        this._gone = false;
    }

    /** The code now; drawn after the pause, or at once with `now`. */
    set(source, now = false) {
        this._source = source;
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        if (now) {
            this._next();
            return;
        }
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._delay, () => {
            this._timer = 0;
            this._next();
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._gone = true;
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
    }

    async _next() {
        if (this._drawing) {
            this._again = true;
            return;
        }
        this._drawing = true;
        const source = this._source;
        let result;
        try {
            result = {picture: await this._draw(source)};
        } catch (error) {
            result = {error: error.message};
        }
        this._drawing = false;
        if (this._gone)
            return;
        if (source === this._source)
            this._show(result);
        if (this._again) {
            this._again = false;
            if (source !== this._source)
                this._next();
        }
    }
}
