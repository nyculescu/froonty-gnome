// SPDX-License-Identifier: GPL-3.0-or-later
// The rendered pictures of the Notes island's Mermaid diagrams, Markdown
// tables and local images, with their saved display sizes. The preview
// (preview.js) draws them in place of their source.

import {markdownBlocks} from '../blocks.js';
import {keyedMarkdownBlocks, RenderSizes} from '../renderSizes.js';
import {MarkdownBlockPictures} from './blocks.js';

export class IslandMarkdownBlocks {
    constructor(entry, {restyle, folder, note}) {
        this._folder = folder;
        this._note = note;
        this._sizes = new RenderSizes(restyle);
        this._pictures = new MarkdownBlockPictures(restyle);
        entry.connect('destroy', () => {
            this._sizes.destroy();
            this._pictures.destroy();
        });
    }

    /** The render entries of `text`'s blocks, asking for uncached ones now. */
    pictures(text, width) {
        const folder = this._folder();
        this._sizes.select(folder, this._note());
        const blocks = keyedMarkdownBlocks(markdownBlocks(text));
        return this._pictures.want(blocks, Math.min(620, width), folder).map(entry => ({
            ...entry, displaySize: this._sizes.get(entry.itemKey),
        }));
    }

    /** A promise of a diagram of `source`, drawn as the note's are (renderer/blocks.js draw()). */
    drawDiagram(source) {
        return this._pictures.draw({kind: 'mermaid', source}, 620, this._folder());
    }

    resize(itemKey, size) {
        // Under the note's name now (it may have been renamed since).
        this._sizes.select(this._folder(), this._note());
        this._sizes.set(itemKey, size);
    }
}
