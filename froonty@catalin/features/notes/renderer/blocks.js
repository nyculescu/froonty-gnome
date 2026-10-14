// SPDX-License-Identifier: GPL-3.0-or-later
// Cached pictures for the Markdown blocks which need a layout engine.

import {BlockRenderClient} from './client.js';

const LIMIT = 24;
const keyFor = (block, width, folder) => JSON.stringify([
    'renderer-v2', block.kind, block.source, block.uri ?? '', Math.round(width), folder?.get_uri?.() ?? '',
]);

export class MarkdownBlockPictures {
    constructor(onChange, {client = null} = {}) {
        this._onChange = onChange;
        this._client = client ?? new BlockRenderClient();
        this._ownsClient = client === null;
        this._entries = new Map();
        this._destroyed = false;
    }

    /** Returns render entries for blocks, asking for uncached ones now. */
    want(blocks, width, folder) {
        if (this._destroyed)
            return [];
        const wanted = [];
        for (const block of blocks) {
            const request = this._request(block, width, folder);
            const key = keyFor(request, width, folder);
            let entry = this._entries.get(key);
            if (!entry) {
                entry = {state: 'pending', request, width: Math.round(width), key};
                this._entries.set(key, entry);
                this._render(entry);
            } else {
                this._entries.delete(key);
                this._entries.set(key, entry);
            }
            wanted.push({...block, ...entry});
        }
        while (this._entries.size > LIMIT)
            this._entries.delete(this._entries.keys().next().value);
        return wanted;
    }

    destroy() {
        this._destroyed = true;
        this._entries.clear();
        if (this._ownsClient)
            this._client.destroy();
    }

    _request(block, width, folder) {
        // Mermaid flowcharts gain little from filling the editor width; a
        // narrower canvas keeps labels readable and reduces the reserved
        // height of tall top-to-bottom diagrams.
        const renderWidth = block.kind === 'mermaid' ? Math.min(380, width) : width;
        const request = {kind: block.kind, source: block.source, width: Math.round(renderWidth)};
        if (block.kind === 'image') {
            if (/^(?:[a-z]+:|\/)/i.test(block.source))
                return {...request, uri: ''}; // Images are deliberately local and note-relative.
            const file = folder?.resolve_relative_path?.(block.source);
            request.uri = file?.get_uri?.() ?? '';
            request.alt = block.alt;
            request.baseUri = folder ? `${folder.get_uri()}/` : null;
        } else if (block.kind === 'table') {
            request.baseUri = folder ? `${folder.get_uri()}/` : null;
        } else if (block.kind === 'mermaid') {
            // Diagram sources never load links or external resources.
            request.baseUri = null;
        }
        return request;
    }

    _render(entry) {
        if (!entry.request || (entry.request.kind === 'image' && !entry.request.uri)) {
            entry.state = 'error';
            entry.error = 'Use an image file path relative to this note';
            return;
        }
        this._client.render(entry.request).then(result => {
            if (this._destroyed || !this._entries.has(entry.key))
                return;
            Object.assign(entry, {state: 'ready', ...result});
            this._onChange();
        }).catch(error => {
            if (this._destroyed || !this._entries.has(entry.key))
                return;
            Object.assign(entry, {state: 'error', error: error.message});
            this._onChange();
        });
    }
}
