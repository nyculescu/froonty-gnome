// SPDX-License-Identifier: GPL-3.0-or-later
// Cover art for the Media tab and the pill (docs/features/media.md §Art).
//
// A player gives its cover as mpris:artUrl. A file:// cover is read
// asynchronously (at most 12 MiB, regular files only) and decoded with
// GdkPixbuf at the size it is shown; an http(s) cover is fetched only
// when "Cover art from the internet" is on (fetch.js), at most 4 MiB.
// A picture is decoded only when its header (model.imageSize) says it
// is at most MAX_PIXELS: a small file can claim 25000 × 25000, and
// GdkPixbuf (through glycin) decodes it all before any size signal.
//
// Not St.TextureCache.load_file_async (it keeps a file monitor on every
// file it loaded, for the life of the Shell) and not CSS background-image
// (loaded synchronously and cached for good): checked in GNOME Shell 50.

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {artSource, imageSize, tintFromPixels} from './model.js';

export const MAX_FILE_BYTES = 12 * 1024 * 1024;
export const MAX_REMOTE_BYTES = 4 * 1024 * 1024;
export const MAX_PIXELS = 4096 * 4096;
const LRU_SIZE = 8;

function queryInfo(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.query_info_async('standard::size,standard::type', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, cancellable, (_file, result) => {
                try {
                    resolve(file.query_info_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function loadBytes(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.load_contents_async(cancellable, (_file, result) => {
            try {
                resolve(file.load_contents_finish(result)[1]);
            } catch (e) {
                reject(e);
            }
        });
    });
}

/**
 * Decodes `data` (Uint8Array) to fit `side` × `side`; null for a format
 * imageSize does not read, or a picture over MAX_PIXELS.
 */
export function decode(data, side) {
    const size = imageSize(data);
    if (!size || size.width <= 0 || size.height <= 0 || size.width * size.height > MAX_PIXELS)
        return null;
    const scale = side / Math.max(size.width, size.height);
    const loader = new GdkPixbuf.PixbufLoader();
    loader.set_size(Math.max(1, Math.round(size.width * scale)), Math.max(1, Math.round(size.height * scale)));
    try {
        loader.write_bytes(new GLib.Bytes(data));
        loader.close();
    } catch (e) {
        try {
            loader.close();
        } catch {}
        throw e;
    }
    return loader.get_pixbuf();
}

/** The tint of a decoded cover (model.tint), from a 16 × 16 reduction. */
export function pixbufTint(pixbuf) {
    const small = pixbuf.scale_simple(16, 16, GdkPixbuf.InterpType.BILINEAR);
    if (!small)
        return null;
    return tintFromPixels(small.get_pixels(), {
        width: small.get_width(),
        height: small.get_height(),
        rowstride: small.get_rowstride(),
        nChannels: small.get_n_channels(),
        hasAlpha: small.get_has_alpha(),
    });
}

export class ArtLoader {
    /** @param {object} options {fetcher} (fetch.js) */
    constructor({fetcher}) {
        this._fetcher = fetcher;
        this._remote = new Map(); // url → pixbuf, least recently used first
    }

    /**
     * @param {?string} url mpris:artUrl
     * @param {object} options
     * @param {boolean} options.remote media-remote-art
     * @param {number} options.side decode size, physical pixels
     * @param {Gio.Cancellable} options.cancellable
     * @returns {Promise<object>} {state: 'ready', pixbuf, tint}, or
     *   {state: 'blocked'} (a web cover while that is off), or
     *   {state: 'none'} (no cover, or one that cannot be read)
     */
    async load(url, {remote, side, cancellable}) {
        const kind = artSource(url, {remote});
        if (kind === 'blocked')
            return {state: 'blocked'};
        if (!kind)
            return {state: 'none'};
        let pixbuf = null;
        if (kind === 'file') {
            const file = Gio.File.new_for_uri(url);
            const info = await queryInfo(file, cancellable);
            if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_size() > MAX_FILE_BYTES)
                return {state: 'none'};
            pixbuf = decode(await loadBytes(file, cancellable), side);
        } else {
            pixbuf = this._remote.get(url) ?? null;
            if (pixbuf) {
                this._remote.delete(url);
            } else {
                const bytes = await this._fetcher.get(url, {
                    maxBytes: MAX_REMOTE_BYTES,
                    accept: 'image/',
                    cancellable,
                });
                pixbuf = decode(bytes.toArray(), side);
            }
            if (pixbuf)
                this._remote.set(url, pixbuf);
            while (this._remote.size > LRU_SIZE)
                this._remote.delete(this._remote.keys().next().value);
        }
        return pixbuf ? {state: 'ready', pixbuf, tint: pixbufTint(pixbuf)} : {state: 'none'};
    }

    /** Forgets web covers (turned off, or stop()). */
    clearRemote() {
        this._remote.clear();
    }
}
