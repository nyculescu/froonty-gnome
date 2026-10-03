// SPDX-License-Identifier: GPL-3.0-or-later
// The Writing tab's HTTP (docs/features/writing.md §5): one Soup session
// per engine, requests whose answers are read with a size cap, and Ollama's
// streamed NDJSON. No St or Gtk.
//
// Statuses are read from `status_code`: Soup.Message.get_status() returns
// a Soup.Status, which has no value for some codes LanguageTool uses (429).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.InputStream.prototype, 'close_async');

const CHUNK = 64 * 1024;
const MiB = 1024 * 1024;

export function newSession(timeoutS = 20) {
    return new Soup.Session({timeout: timeoutS, user_agent: 'Froonty'});
}

function newMessage(method, url, {form = null, json = null} = {}) {
    let message;
    try {
        message = form
            ? Soup.Message.new_from_encoded_form(method, url, Soup.form_encode_hash(form))
            : Soup.Message.new(method, url);
    } catch (e) {
        message = null;
    }
    if (!message)
        throw new Error(`Not a valid address: ${url}`);
    message.request_headers.append('Accept', 'application/json');
    if (json !== null) {
        message.set_request_body_from_bytes('application/json',
            new GLib.Bytes(new TextEncoder().encode(JSON.stringify(json))));
    }
    return message;
}

async function readCapped(stream, maxBytes, cancellable) {
    const parts = [];
    let total = 0;
    try {
        for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const bytes = await stream.read_bytes_async(CHUNK, GLib.PRIORITY_DEFAULT, cancellable);
            const size = bytes.get_size();
            if (!size)
                break;
            total += size;
            if (total > maxBytes)
                throw Object.assign(new Error('The answer is too large.'), {tooLarge: true});
            parts.push(bytes.toArray());
        }
    } finally {
        stream.close_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
    }
    const all = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        all.set(part, at);
        at += part.length;
    }
    return all;
}

/**
 * One request; the answer is read whole, up to `maxBytes`.
 *
 * @param {Soup.Session} session
 * @param {string} method
 * @param {string} url
 * @param {object} [options]
 * @param {object} [options.form] fields, sent form-encoded
 * @param {*} [options.json] sent as a JSON body
 * @param {Gio.Cancellable} [options.cancellable]
 * @param {number} [options.maxBytes]
 * @returns {Promise<{status: number, body: string, bytes: Uint8Array}>}
 */
export async function request(session, method, url, {form = null, json = null,
    cancellable = null, maxBytes = MiB} = {}) {
    const message = newMessage(method, url, {form, json});
    const stream = await session.send_async(message, GLib.PRIORITY_DEFAULT, cancellable);
    const bytes = await readCapped(stream, maxBytes, cancellable);
    return {status: message.status_code, body: new TextDecoder().decode(bytes), bytes};
}

/** A JSON answer, or null when the body is not JSON. */
export function parseJson(body) {
    try {
        return JSON.parse(body);
    } catch (e) {
        return null;
    }
}

/**
 * A streamed answer of one JSON object per line (Ollama's NDJSON), each
 * handed to `onObject` as it arrives. A line that is not JSON is skipped.
 *
 * @returns {Promise<number>} the status code
 */
export async function streamNdjson(session, method, url, {json = null, cancellable = null,
    onObject, maxLine = MiB, maxTotal = 4 * MiB} = {}) {
    const message = newMessage(method, url, {json});
    const stream = await session.send_async(message, GLib.PRIORITY_DEFAULT, cancellable);
    const status = message.status_code;
    const decoder = new TextDecoder();
    // Split on newline bytes, then decode whole lines (a UTF-8 character
    // may be split across reads).
    let pending = new Uint8Array(0);
    let total = 0;
    const take = line => {
        const text = decoder.decode(line);
        if (!text.trim())
            return;
        const object = parseJson(text);
        if (object !== null)
            onObject(object, status);
    };
    try {
        for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const bytes = await stream.read_bytes_async(CHUNK, GLib.PRIORITY_DEFAULT, cancellable);
            const size = bytes.get_size();
            if (!size)
                break;
            total += size;
            if (total > maxTotal)
                throw Object.assign(new Error('The answer is too large.'), {tooLarge: true});
            const chunk = bytes.toArray();
            const joined = new Uint8Array(pending.length + chunk.length);
            joined.set(pending);
            joined.set(chunk, pending.length);
            let start = 0;
            let newline;
            while ((newline = joined.indexOf(10, start)) >= 0) {
                take(joined.subarray(start, newline));
                start = newline + 1;
            }
            pending = joined.slice(start);
            if (pending.length > maxLine)
                throw Object.assign(new Error('The answer is too large.'), {tooLarge: true});
        }
        if (pending.length)
            take(pending);
    } finally {
        stream.close_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
    }
    return status;
}

/**
 * What kind of network failure `e` is: 'cancelled', 'timeout', 'refused'
 * (nothing listens there), 'too-large' or 'network'.
 */
export function networkFailure(e) {
    if (e?.tooLarge)
        return 'too-large';
    if (e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
        return 'cancelled';
    if (e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT))
        return 'timeout';
    if (e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CONNECTION_REFUSED))
        return 'refused';
    return 'network';
}

/**
 * Waits `ms`, or rejects at once (CANCELLED) when `cancellable` is
 * cancelled; the timeout source is removed either way.
 */
export function sleep(ms, cancellable = null) {
    return new Promise((resolve, reject) => {
        let cancelId = 0;
        const source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            if (cancelId)
                cancellable.disconnect(cancelId);
            resolve();
            return GLib.SOURCE_REMOVE;
        });
        if (cancellable) {
            cancelId = cancellable.connect(() => {
                GLib.source_remove(source);
                reject(new Gio.IOErrorEnum({code: Gio.IOErrorEnum.CANCELLED, message: 'Cancelled'}));
            });
        }
    });
}
