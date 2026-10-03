// SPDX-License-Identifier: GPL-3.0-or-later
// The Media tab's only network access (docs/features/media.md §Network),
// both off by default: covers that a player gives as a web address
// (media-remote-art) and lyrics from lrclib.net (media-lyrics-online).
//
// One Soup.Session, made on the first request (never otherwise): no cookie
// jar, no cache (Soup adds neither by itself), a User-Agent that names
// Froonty, a 10 s timeout, and bodies read in chunks up to a cap, so a
// large or endless answer is cut off instead of filling memory.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const CHUNK = 64 * 1024;

export class HttpError extends Error {
    constructor(status) {
        super(`HTTP ${status}`);
        this.status = status;
    }
}

function send(session, message, cancellable) {
    return new Promise((resolve, reject) => {
        session.send_async(message, GLib.PRIORITY_DEFAULT, cancellable, (_session, result) => {
            try {
                resolve(session.send_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function readChunk(stream, cancellable) {
    return new Promise((resolve, reject) => {
        stream.read_bytes_async(CHUNK, GLib.PRIORITY_DEFAULT, cancellable, (_stream, result) => {
            try {
                resolve(stream.read_bytes_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/** Closes a stream asynchronously, ignoring errors. */
export function closeQuietly(stream) {
    stream.close_async(GLib.PRIORITY_DEFAULT, null, (_stream, result) => {
        try {
            stream.close_finish(result);
        } catch {
            // Already closed or aborted: nothing to release.
        }
    });
}

export class Fetcher {
    /** @param {object} options {userAgent} */
    constructor({userAgent = 'Froonty'} = {}) {
        this._userAgent = userAgent;
        /** The Soup.Session, or null until the first request (tests check it). */
        this.session = null;
    }

    /**
     * GETs `url` and returns its body, at most `maxBytes`.
     *
     * @param {string} url http or https
     * @param {object} options
     * @param {number} options.maxBytes larger bodies fail
     * @param {?string} [options.accept] required Content-Type prefix ("image/")
     * @param {boolean} [options.noRedirect]
     * @param {?Gio.Cancellable} [options.cancellable]
     * @returns {Promise<GLib.Bytes>}
     */
    async get(url, {maxBytes, accept = null, noRedirect = false, cancellable = null}) {
        const scheme = GLib.Uri.peek_scheme(url);
        if (scheme !== 'http' && scheme !== 'https')
            throw new Error('not a web address');
        const message = Soup.Message.new('GET', url);
        if (!message)
            throw new Error('invalid address');
        if (noRedirect)
            message.add_flags(Soup.MessageFlags.NO_REDIRECT);
        this.session ??= new Soup.Session({
            timeout: 10,
            idle_timeout: 10,
            max_conns: 2,
            user_agent: this._userAgent,
        });
        const stream = await send(this.session, message, cancellable);
        try {
            const status = message.get_status();
            if (status !== Soup.Status.OK)
                throw new HttpError(status);
            const [type] = message.get_response_headers().get_content_type();
            if (accept && !(type ?? '').toLowerCase().startsWith(accept))
                throw new Error(`not ${accept}*: ${type}`);
            const chunks = [];
            let total = 0;
            for (;;) {
                // eslint-disable-next-line no-await-in-loop
                const bytes = await readChunk(stream, cancellable);
                const size = bytes.get_size();
                if (size === 0)
                    break;
                total += size;
                if (total > maxBytes)
                    throw new Error(`larger than ${maxBytes} bytes`);
                chunks.push(bytes.toArray());
            }
            const body = new Uint8Array(total);
            let at = 0;
            for (const chunk of chunks) {
                body.set(chunk, at);
                at += chunk.length;
            }
            return new GLib.Bytes(body);
        } finally {
            closeQuietly(stream);
        }
    }

    /** Aborts every request in flight; the session is kept for later ones. */
    abort() {
        this.session?.abort();
    }

    destroy() {
        this.abort();
        this.session = null;
    }
}

export const isCancelled = e => e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ?? false;
