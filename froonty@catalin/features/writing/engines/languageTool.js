// SPDX-License-Identifier: GPL-3.0-or-later
// Writing engine: LanguageTool's free public service, grammar and spelling
// only (docs/features/writing.md §2). No account, no key. Its
// conditions (languagetool.org/http-api) are kept: one request per click,
// never while typing or retried by itself, at most 20 KB of text, at most
// 10 requests a minute from Froonty (the service allows 20 per IP), and a
// visible link to languagetool.org with every result.
//
// No St or Gtk.

import Gio from 'gi://Gio';

import {LIMITS} from '../actions.js';
import {WritingError} from '../errors.js';
import {networkFailure, newSession, parseJson, request} from '../http.js';
import {override} from '../paths.js';

export const ID = 'languagetool';
export const PUBLIC_URL = 'https://api.languagetool.org/v2/check';
export const ATTRIBUTION = {
    label: 'Checked by LanguageTool · languagetool.org',
    url: 'https://languagetool.org',
};
export const VARIANTS = /^[a-z]{2,3}-[A-Z]{2}(,[a-z]{2,3}-[A-Z]{2})*$/;
const TIMEOUT_S = 20;
const SHOWN_CHANGES = 20;

/** The form fields of one check: the text, auto language, preferred variants. */
export function formFields(text, variants) {
    const fields = {text, language: 'auto'};
    if (typeof variants === 'string' && VARIANTS.test(variants))
        fields.preferredVariants = variants;
    return fields;
}

/**
 * Froonty's own limit, a sliding window in memory: at most `maxRequests`
 * texts and `maxBytes` bytes per `windowMs`.
 */
export class RateLimiter {
    constructor({maxRequests = 10, maxBytes = 60000, windowMs = 60000, now = Date.now} = {}) {
        this._max = maxRequests;
        this._maxBytes = maxBytes;
        this._window = windowMs;
        this._now = now;
        this._sent = []; // {time, bytes}
    }

    /**
     * Whether `bytes` may go now: {seconds: 0, limit: null}, or the seconds
     * to wait and the limit that holds it back, 'texts' or 'bytes'.
     */
    check(bytes) {
        const now = this._now();
        this._sent = this._sent.filter(s => now - s.time < this._window);
        const used = this._sent.reduce((sum, s) => sum + s.bytes, 0);
        const textsFull = this._sent.length >= this._max;
        if (!textsFull && used + bytes <= this._maxBytes)
            return {seconds: 0, limit: null};
        const limit = textsFull ? 'texts' : 'bytes';
        // The earliest time enough of the window has passed.
        let freed = 0;
        let count = this._sent.length;
        for (const s of this._sent) {
            freed += s.bytes;
            count--;
            if (count < this._max && used - freed + bytes <= this._maxBytes)
                return {seconds: Math.max(1, Math.ceil((s.time + this._window - now) / 1000)), limit};
        }
        return {seconds: Math.ceil(this._window / 1000), limit};
    }

    /** 0 when `bytes` may go now; else the seconds to wait. */
    wait(bytes) {
        return this.check(bytes).seconds;
    }

    /** Why `check` held a text back, for the user. */
    describe(limit) {
        const windowS = Math.round(this._window / 1000);
        const per = windowS === 60 ? 'a minute' : `every ${windowS} s`;
        return limit === 'bytes'
            ? `Froonty sends LanguageTool at most ${Math.round(this._maxBytes / 1000)} KB of text ${per}.`
            : `Froonty sends LanguageTool at most ${this._max} texts ${per}.`;
    }

    record(bytes) {
        this._sent.push({time: this._now(), bytes});
    }
}

// One per Shell: Froonty's limit holds across screen locks.
const sharedLimiter = new RateLimiter();

/**
 * The text with LanguageTool's first suggestion for each match applied.
 * A match without a suggestion becomes a note; overlapping matches after
 * the first, and matches whose context does not fit the text, are left
 * out. Offsets are UTF-16 code units in LanguageTool and in JavaScript.
 *
 * @param {string} text
 * @param {object[]} matches LanguageTool's `matches`
 * @returns {{text: string, changes: object[], notes: object[]}}
 */
export function applyMatches(text, matches) {
    const sorted = (Array.isArray(matches) ? matches : [])
        .filter(m => Number.isInteger(m?.offset) && Number.isInteger(m?.length) &&
            m.offset >= 0 && m.length >= 0 && m.offset + m.length <= text.length)
        .sort((a, b) => a.offset - b.offset);
    const applied = [];
    const notes = [];
    let end = -1;
    for (const match of sorted) {
        if (match.offset < end)
            continue;
        const span = text.substr(match.offset, match.length);
        const context = match.context;
        if (context && typeof context.text === 'string' &&
            context.text.substr(context.offset, context.length) !== span)
            continue;
        const message = String(match.message ?? match.shortMessage ?? '');
        const replacement = match.replacements?.[0]?.value;
        if (typeof replacement !== 'string') {
            notes.push({message, excerpt: span});
            continue;
        }
        applied.push({offset: match.offset, length: match.length, from: span, to: replacement,
            message});
        end = match.offset + match.length;
    }
    let result = text;
    for (const change of [...applied].reverse()) {
        result = result.slice(0, change.offset) + change.to +
            result.slice(change.offset + change.length);
    }
    return {
        text: result,
        changes: applied.map(({from, to, message}) => ({from, to, message})),
        notes,
    };
}

function serviceUrl() {
    return override('FROONTY_LANGUAGETOOL_URL') ?? PUBLIC_URL;
}

const isOnline = network => (network ?? Gio.NetworkMonitor.get_default()).connectivity ===
    Gio.NetworkConnectivity.FULL;

/**
 * One check. `cache` holds the engine's Soup session for the service's
 * lifetime (the service aborts it on stop).
 */
export async function run({action, text, settings, cancellable = null, network = null,
    cache = new Map(), deps = {}}) {
    const {limiter = sharedLimiter, url = serviceUrl()} = deps;
    if (action !== 'grammar')
        throw new WritingError('failed', 'LanguageTool only fixes grammar and spelling.');
    if (!isOnline(network))
        throw new WritingError('offline', 'No internet connection: LanguageTool cannot be reached.');
    const bytes = new TextEncoder().encode(text).length;
    const {seconds, limit} = limiter.check(bytes);
    if (seconds)
        throw new WritingError('rate-limited', `Wait ${seconds} s: ${limiter.describe(limit)}`);
    let session = cache.get('languagetool-session');
    if (!session) {
        session = newSession(TIMEOUT_S);
        cache.set('languagetool-session', session);
    }
    limiter.record(bytes);
    let answer;
    try {
        answer = await request(session, 'POST', url, {
            form: formFields(text, settings.get_string('writing-languagetool-variants')),
            cancellable,
        });
    } catch (e) {
        const failure = networkFailure(e);
        if (failure === 'cancelled')
            throw new WritingError('cancelled', 'Cancelled.');
        if (failure === 'timeout')
            throw new WritingError('timeout', 'LanguageTool did not answer in time.');
        if (failure === 'too-large')
            throw new WritingError('bad-output', 'LanguageTool answered with too much data.');
        throw new WritingError('offline', `Cannot reach LanguageTool: ${e.message}`);
    }
    const {status, body} = answer;
    if (status === 429) {
        throw new WritingError('rate-limited',
            'LanguageTool\'s free service is busy, or its limit of 20 a minute was reached. Try again in a minute.');
    }
    if (status === 413)
        throw new WritingError('too-long', 'The text is too long for LanguageTool\'s free service.');
    if (status >= 500)
        throw new WritingError('unavailable', `LanguageTool is unavailable right now (${status}).`);
    if (status !== 200) {
        const detail = body.trim().slice(0, 200);
        throw new WritingError('failed', detail || `LanguageTool answered ${status}.`);
    }
    const data = parseJson(body);
    if (!data || !Array.isArray(data.matches))
        throw new WritingError('bad-output', 'LanguageTool\'s answer could not be read.');
    const {text: corrected, changes, notes} = applyMatches(text, data.matches);
    return {
        text: corrected,
        changes: changes.slice(0, SHOWN_CHANGES),
        moreChanges: Math.max(0, changes.length - SHOWN_CHANGES),
        notes,
        attribution: ATTRIBUTION,
    };
}

export default {
    id: ID,
    title: 'LanguageTool',
    cloud: true,
    actions: ['grammar'],
    limit: LIMITS[ID],
    busyText: () => 'Checking with LanguageTool…',
    destination: () => 'Sends to LanguageTool (languagetool.org): grammar and spelling only',
    /** Ready while online; nothing is ever sent to find out. */
    availability({network = null} = {}) {
        return isOnline(network) ? {ready: true, reason: ''} : {ready: false, reason: 'offline'};
    },
    run,
};
