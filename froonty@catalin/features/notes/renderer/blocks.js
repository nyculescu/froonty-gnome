// SPDX-License-Identifier: GPL-3.0-or-later
// Cached pictures for the Markdown blocks which need a layout engine.
//
//   new MarkdownBlockPictures(onChange, client?)
//       onChange() runs when an entry finished rendering (or failed).
//   want(blocks, width, folder) → entries, one per block (blocks.js's
//       markdownBlocks(), optionally keyed), asking for uncached ones now:
//       {...block,
//        state: 'pending' | 'ready' | 'error',
//        width, height   the default display size at `width`: an image's
//                        within 360 × 320 px (and `width`), a table's or
//                        diagram's its picture's size. While pending or
//                        failed: width is the render width, no height.
//        png             ready: PNG bytes (Uint8Array) of pixelWidth ×
//        pixelWidth,     pixelHeight. An image keeps its own size up to
//        pixelHeight     1600 px, larger than it is shown, so enlarging or
//                        copying it stays sharp; draw it scaled to the
//                        display size.
//        warnings        string[]: what the picture leaves out (a diagram
//                        line it does not understand, a table's cell image
//                        that did not load); [] when nothing, or not ready
//        error           failed: a short reason ("Image not found: a.png"),
//                        else null
//        key, request    the cache's own}
//   draw(block, width, folder) → a promise of `block` drawn now, outside
//       the cache (Edit Mermaid code's live picture): the client's
//       {png, width, height, warnings}; rejects with the reason
//   destroy()

import {BlockRenderClient} from './client.js';
import {imageFile} from './imageFile.js';

const LIMIT = 24;
// PNG bytes kept for blocks no longer shown; the shown ones are always kept.
const BYTE_BUDGET = 48 * 1024 * 1024;
const IMAGE_WIDTH = 360;
const IMAGE_HEIGHT = 320;
const keyFor = (request, folder) => JSON.stringify([
    request.kind, request.source, request.uri ?? '', request.width ?? 0, folder?.get_uri?.() ?? '',
]);

// An image's default display size: within IMAGE_WIDTH × IMAGE_HEIGHT and
// the view's width, never enlarged.
function imageSize(entry, width) {
    const scale = Math.min(1, width / entry.pixelWidth, IMAGE_WIDTH / entry.pixelWidth,
        IMAGE_HEIGHT / entry.pixelHeight);
    return {width: Math.max(1, Math.round(entry.pixelWidth * scale)),
        height: Math.max(1, Math.round(entry.pixelHeight * scale))};
}

export class MarkdownBlockPictures {
    constructor(onChange, client = new BlockRenderClient()) {
        this._onChange = onChange;
        this._client = client;
        this._entries = new Map();
        this._destroyed = false;
    }

    /** Returns render entries for blocks, asking for uncached ones now. */
    want(blocks, width, folder) {
        if (this._destroyed)
            return [];
        const wanted = [];
        const keys = new Set();
        for (const block of blocks) {
            const request = this._request(block, width, folder);
            const key = keyFor(request, folder);
            let entry = this._entries.get(key);
            if (!entry) {
                entry = {state: 'pending', request, key, warnings: [], error: null};
                this._entries.set(key, entry);
                this._render(entry);
            } else {
                this._entries.delete(key);
                this._entries.set(key, entry);
            }
            keys.add(key);
            const size = entry.state !== 'ready' ? {width: Math.round(width)}
                : block.kind === 'image' ? imageSize(entry, width) : {};
            wanted.push({...block, ...entry, ...size});
        }
        // The wanted entries are the newest, so only unwanted ones go, even
        // when the note has more than LIMIT blocks or large images.
        let bytes = 0;
        for (const entry of this._entries.values())
            bytes += entry.png?.length ?? 0;
        for (const [key, entry] of this._entries) {
            if (keys.has(key) || (this._entries.size <= Math.max(LIMIT, blocks.length) && bytes <= BYTE_BUDGET))
                break;
            bytes -= entry.png?.length ?? 0;
            this._entries.delete(key);
        }
        return wanted;
    }

    draw(block, width, folder) {
        return this._client.render(this._request(block, width, folder));
    }

    destroy() {
        this._destroyed = true;
        this._entries.clear();
        this._client.destroy();
    }

    _request(block, width, folder) {
        if (block.kind === 'image') {
            // Images are deliberately local and note-relative; their picture
            // does not depend on the width.
            return {kind: 'image', source: block.source,
                uri: imageFile(block, folder)?.get_uri?.() ?? ''};
        }
        // Mermaid flowcharts gain little from filling the editor width; a
        // narrower canvas keeps labels readable and reduces the reserved
        // height of tall top-to-bottom diagrams.
        const renderWidth = block.kind === 'mermaid' ? Math.min(380, width) : width;
        const request = {kind: block.kind, source: block.source, width: Math.round(renderWidth)};
        if (block.kind === 'table')
            request.baseUri = folder ? `${folder.get_uri()}/` : null;
        else if (block.kind === 'mermaid')
            request.baseUri = null; // Diagram sources never load links or external resources.
        return request;
    }

    _render(entry) {
        if (entry.request.kind === 'image' && !entry.request.uri) {
            entry.state = 'error';
            entry.error = 'Use an image file path relative to this note';
            return;
        }
        this._client.render(entry.request).then(result => {
            if (this._destroyed || !this._entries.has(entry.key))
                return;
            Object.assign(entry, {state: 'ready', png: result.png,
                pixelWidth: result.width, pixelHeight: result.height,
                width: result.width, height: result.height, warnings: result.warnings ?? []});
            this._onChange();
        }).catch(error => {
            if (this._destroyed || !this._entries.has(entry.key))
                return;
            Object.assign(entry, {state: 'error', error: error.message});
            this._onChange();
        });
    }
}
