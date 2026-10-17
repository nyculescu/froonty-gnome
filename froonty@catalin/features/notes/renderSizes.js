// SPDX-License-Identifier: GPL-3.0-or-later
// Per-block display sizes are kept beside the Markdown notes so they survive
// restarts and are shared by the Notes island and All notes window.

import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const FILE_NAME = '.froonty-render-sizes.json';
const LIMIT = 1600;
const encode = value => new GLib.Bytes(new TextEncoder().encode(value));

export function keyedMarkdownBlocks(blocks) {
    const occurrences = new Map();
    return blocks.map(block => {
        const identity = JSON.stringify([block.kind, block.source]);
        const occurrence = occurrences.get(identity) ?? 0;
        occurrences.set(identity, occurrence + 1);
        return {...block, itemKey: JSON.stringify([identity, occurrence])};
    });
}

export function resizeWithAspect(start, deltaX, deltaY) {
    const width = Math.max(1, start.width), height = Math.max(1, start.height);
    // Project the drag onto the image's diagonal resize direction. Choosing
    // whichever axis is momentarily larger makes the scale jump back and
    // forth as pointer jitter changes the dominant axis.
    const factor = 1 + (deltaX / width + deltaY / height) / 2;
    return clampRenderSize({width: width * factor, height: height * factor});
}

function clampRenderSize(size) {
    if (!size)
        return null;
    const width = Math.round(Number(size.width));
    const height = Math.round(Number(size.height));
    if (!Number.isFinite(width) || !Number.isFinite(height))
        return null;
    return {width: Math.max(80, Math.min(LIMIT, width)),
        height: Math.max(60, Math.min(LIMIT, height))};
}

/** Fit a saved size inside its requested box without changing source aspect. */
export function fitRenderSize(size, source) {
    if (!size)
        return null;
    const scale = Math.min(size.width / source.width, size.height / source.height);
    return {width: Math.max(1, Math.round(source.width * scale)),
        height: Math.max(1, Math.round(source.height * scale))};
}

/** Encode a rendered Markdown block for the clipboard. Tables and diagrams
 * use JPEG with an opaque white background; ordinary images keep their PNG. */
export function clipboardImage(png, kind) {
    if (kind === 'image')
        return {mime: 'image/png', bytes: png};
    const loader = new GdkPixbuf.PixbufLoader();
    loader.write_bytes(new GLib.Bytes(png));
    loader.close();
    const source = loader.get_pixbuf();
    const flattened = source.composite_color_simple(source.width, source.height,
        GdkPixbuf.InterpType.BILINEAR, 255, 1, 0xffffff, 0xffffff);
    if (!flattened)
        throw new Error('Could not flatten the rendered block');
    const [success, bytes] = flattened.save_to_bufferv('jpeg', ['quality'], ['95']);
    if (!success)
        throw new Error('Could not encode the rendered block as JPEG');
    return {mime: 'image/jpeg', bytes};
}

// The writes of this process, one after the other: each reads the file
// again, so none undoes another.
let writes = Promise.resolve();
function queueWrite(write) {
    const run = writes.then(write);
    writes = run.catch(() => {});
    return run;
}

/**
 * Moves note `from`'s sizes to `to` (a rename; an old entry for `to` goes),
 * or drops them when `to` is null (a new note reusing the name).
 */
export function moveRenderSizes(folder, from, to) {
    const file = folder.get_child(FILE_NAME);
    return queueWrite(async () => {
        const document = await readDocument(file);
        const {notes} = document;
        if (!(from in notes) && !(to !== null && to in notes))
            return;
        if (to !== null) {
            if (from in notes)
                notes[to] = notes[from];
            else
                delete notes[to];
        }
        delete notes[from];
        await writeDocument(file, document);
    });
}

// The sizes file, or an empty one when there is none yet. Any other read or
// parse error throws, so a write never replaces a file it could not read.
async function readDocument(file) {
    let bytes;
    try {
        [bytes] = await file.load_contents_async(null);
    } catch (error) {
        if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return {version: 1, notes: {}};
        throw error;
    }
    const document = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    if (!document?.notes || typeof document.notes !== 'object')
        throw new Error(`${FILE_NAME} has no notes`);
    return document;
}

function writeDocument(file, document) {
    return file.replace_contents_bytes_async(encode(`${JSON.stringify(document, null, 2)}\n`),
        null, false, Gio.FileCreateFlags.NONE, null);
}

export class RenderSizes {
    constructor(onLoad) {
        this._onLoad = onLoad;
        this._folder = null;
        this._note = null;
        this._sizes = {};
        this._generation = 0;
    }

    select(folder, note) {
        const uri = folder?.get_uri?.() ?? '';
        if (uri === this._uri && note === this._note)
            return;
        this._uri = uri;
        this._folder = folder;
        this._note = note || null;
        this._sizes = {};
        this._changedKeys = new Set();
        const generation = ++this._generation;
        if (!folder || !this._note)
            return;
        this._load(folder, this._note, generation);
    }

    get(key) {
        return clampRenderSize(this._sizes[key]);
    }

    set(key, size) {
        const normalized = clampRenderSize(size);
        if (!this._folder || !this._note || !normalized)
            return;
        this._sizes[key] = normalized;
        this._changedKeys.add(key);
        const file = this._folder.get_child(FILE_NAME);
        const note = this._note;
        // Only this key: the other editor (Notes or All notes) may have saved
        // newer sizes for the note's other blocks.
        queueWrite(async () => {
            const document = await readDocument(file);
            document.notes[note] = {...document.notes[note], [key]: normalized};
            await writeDocument(file, document);
        }).catch(error => console.warn(`Froonty notes: could not save rendered item sizes: ${error.message}`));
    }

    /** A load still running then restyles nothing. */
    destroy() {
        this._generation++;
    }

    async _load(folder, note, generation) {
        let sizes = {};
        try {
            await writes; // a rename's move first
            const document = await readDocument(folder.get_child(FILE_NAME));
            if (document.notes[note] && typeof document.notes[note] === 'object')
                sizes = document.notes[note];
        } catch {}
        if (generation !== this._generation)
            return;
        for (const key of this._changedKeys)
            sizes[key] = this._sizes[key];
        this._sizes = sizes;
        this._onLoad();
    }
}
