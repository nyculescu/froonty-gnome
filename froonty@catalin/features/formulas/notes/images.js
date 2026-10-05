// SPDX-License-Identifier: GPL-3.0-or-later
// The pictures of the formulas in a note (docs/features/notes.md,
// "Formulas"), for both editors: the island's (island.js) and the All
// notes window's (window.js). Each editor asks for the formulas of its
// note after every restyle (want()); new ones are sent to the process's
// shared renderer (renderer/shared.js) after a pause in typing, never
// waited for. When answers come, the editor is told once per batch and
// restyles. GLib only, no St or Gtk.
//
// A formula's state: 'pending' (asked for, drawn as dimmed source),
// 'ready' (result: the PNG and its size), 'error' (MathJax refused it;
// message is MathJax's), 'plain' (no picture can be had: MathJax is not
// fetched, or the helper cannot run or failed; the source shows as text,
// and it is asked for again a while later).

import GLib from 'gi://GLib';

import {defaultMathJaxDir, isMathJaxFetched} from '../renderer/client.js';
import {acquireRenderer, releaseRenderer} from '../renderer/shared.js';

// Logical px of 1em at scale 1 (renderer/mathjax.js EM_PX).
export const EM_PX = 16;
// The pause in typing before new formulas are sent.
export const REQUEST_DELAY_MS = 250;
// How long a formula stays plain text after the renderer failed.
export const RETRY_MS = 30000;
// States kept for formulas no longer in the note (the renderer's cache
// keeps their pictures too).
const KEEP = 300;

const keyOf = ({tex, display, color, scale}) => JSON.stringify([tex, Boolean(display), color, scale]);

export class FormulaImages {
    /**
     * @param {Function} onChange called (from the main loop) when answers
     *   came; not after destroy()
     * @param {object} [options]
     * @param {MathRenderClient} [options.client] instead of the shared one
     *   (tests); the caller destroys it
     * @param {Function} [options.isFetched] → Promise<boolean>, whether
     *   MathJax is there
     * @param {number} [options.delayMs]
     */
    constructor(onChange, {client = null, isFetched = null, delayMs = REQUEST_DELAY_MS} = {}) {
        this._onChange = onChange;
        this._shared = client === null;
        this._client = client ?? acquireRenderer();
        this._isFetched = isFetched ?? (() =>
            isMathJaxFetched(GLib.getenv('FROONTY_MATHJAX_DIR') || defaultMathJaxDir()));
        this._delayMs = delayMs;
        this._entries = new Map(); // key → {request, state, sent, result, message, retryAt}
        this._timerId = 0;
        this._changedId = 0;
        this._destroyed = false;
    }

    /**
     * The state of one formula's picture, or null when it was never wanted.
     *
     * @param {{tex: string, display: boolean, color: string, scale: number}} request
     */
    get(request) {
        return this._entries.get(keyOf(request)) ?? null;
    }

    /**
     * The formulas the editor shows now; the new ones are sent after a
     * pause in typing (each new call starts the pause again).
     */
    want(requests) {
        if (this._destroyed)
            return;
        const now = GLib.get_monotonic_time();
        const wanted = new Set();
        let fresh = false;
        for (const request of requests) {
            const key = keyOf(request);
            if (wanted.has(key))
                continue;
            wanted.add(key);
            let entry = this._entries.get(key);
            if (entry) {
                this._entries.delete(key); // most recently wanted last
            } else {
                entry = {request, state: 'pending', sent: false};
            }
            if (entry.state === 'plain' && entry.retryAt <= now)
                Object.assign(entry, {state: 'pending', sent: false});
            this._entries.set(key, entry);
            fresh ||= entry.state === 'pending' && !entry.sent;
        }
        for (const [key, entry] of this._entries) {
            if (this._entries.size <= KEEP)
                break;
            if (!wanted.has(key) && !(entry.state === 'pending' && entry.sent))
                this._entries.delete(key);
        }
        if (!fresh)
            return;
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._delayMs, () => {
            this._timerId = 0;
            this._send().catch(e => console.warn(`Froonty: formulas in notes: ${e.message}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Stops asking; the shared renderer is let go. */
    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        if (this._timerId)
            GLib.source_remove(this._timerId);
        if (this._changedId)
            GLib.source_remove(this._changedId);
        this._timerId = this._changedId = 0;
        this._entries.clear();
        if (this._shared)
            releaseRenderer();
        this._client = null;
    }

    async _send() {
        const pending = [...this._entries.values()].filter(e => e.state === 'pending' && !e.sent);
        if (!pending.length)
            return;
        for (const entry of pending)
            entry.sent = true;
        let available = false;
        try {
            available = await this._isFetched();
        } catch {}
        if (this._destroyed)
            return;
        if (!available) {
            for (const entry of pending)
                this._fail(entry, 'MathJax is not fetched');
            this._changed();
            return;
        }
        for (const entry of pending) {
            this._client.render(entry.request).then(result => {
                if (this._destroyed)
                    return;
                Object.assign(entry, {state: 'ready', result});
                this._changed();
            }, e => {
                if (this._destroyed)
                    return;
                if (e.kind === 'tex')
                    Object.assign(entry, {state: 'error', message: e.message});
                else
                    this._fail(entry, e.message);
                this._changed();
            });
        }
    }

    // No picture to be had for now: the source shows as text.
    _fail(entry, message) {
        Object.assign(entry, {state: 'plain', message, retryAt: GLib.get_monotonic_time() + RETRY_MS * 1000});
    }

    // Answers that come together make one restyle.
    _changed() {
        if (this._changedId)
            return;
        this._changedId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._changedId = 0;
            this._onChange();
            return GLib.SOURCE_REMOVE;
        });
    }
}
