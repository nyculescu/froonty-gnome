// SPDX-License-Identifier: GPL-3.0-or-later
// livenerf service: fetches livenerf's README and hero chart from GitHub
// and parses them (livenerf.js). No St; unit-tested with plain gjs and a
// fake fetch.
//
// The only network requests Froonty makes for the Claude tab (user
// request, 2026-09-30): plain GETs of two public files, no sign-in, no
// token. They run only when ClaudeService asks, that is when the tab comes
// on screen while online, and at most once an hour: livenerf updates once
// a day.
//
// Emits 'changed' when the result or the error changes.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {Emitter} from '../../core/emitter.js';
import {CHART_PATH, README_PATH, benchmarkFromReadme, chartFromSvg, urlFor} from './livenerf.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');

// After a good reading, the next visit within this long does not fetch.
export const MIN_FETCH_INTERVAL_MS = 3600 * 1000;
// The README is about 22 kB, the chart 6 kB; anything much larger is not them.
const MAX_SIZE = 1 << 20;
const TIMEOUT_S = 20;

export class LivenerfService extends Emitter {
    /**
     * @param {object} [options]
     * @param {Function} [options.fetch] (path, cancellable) →
     *   Promise<string>, a file of livenerf's repository (tests). By default
     *   from $FROONTY_LIVENERF_DIR, a local copy (the headless tests), or
     *   from GitHub.
     */
    constructor({fetch = null} = {}) {
        super();
        this._fetch = fetch ?? ((path, cancellable) => this._fetchDefault(path, cancellable));

        /** {progress, result, chart} (livenerf.js; each may be null), or null. */
        this.benchmark = null;
        /** 'unreadable' (both files failed, or nothing known in them), or null. */
        this.error = null;
        /** False until the first fetch has finished. */
        this.loaded = false;
        /** When the last good reading was fetched, ms since the epoch. */
        this.fetchedAt = null;

        this._fetching = null;
        this._warned = '';
        this._cancellable = null;
        this._session = null;
    }

    start() {
        this._cancellable = new Gio.Cancellable();
    }

    stop() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._session?.abort();
        this._session = null;
    }

    /**
     * Fetches the README unless a good reading is under an hour old.
     *
     * @returns {Promise} resolves when done (for tests)
     */
    refresh() {
        if (this._fetching)
            return this._fetching;
        if (!this._cancellable ||
            (this.fetchedAt !== null && Date.now() - this.fetchedAt < MIN_FETCH_INTERVAL_MS))
            return Promise.resolve();
        this._fetching = this._load().finally(() => {
            this._fetching = null;
        });
        return this._fetching;
    }

    async _load() {
        const [readme, chart] = await Promise.allSettled([
            this._fetch(README_PATH, this._cancellable).then(text => {
                const parsed = benchmarkFromReadme(text);
                if (!parsed)
                    throw new Error('no progress line and no results in the README');
                return parsed;
            }),
            this._fetch(CHART_PATH, this._cancellable).then(text => {
                const parsed = chartFromSvg(text);
                if (!parsed)
                    throw new Error(`no daily scores in ${CHART_PATH}`);
                return parsed;
            }),
        ]);
        const failures = [readme, chart].filter(r => r.status === 'rejected').map(r => r.reason);
        if (failures.some(e => e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
            return;
        // A file that failed keeps its last good reading, if any.
        const last = this.benchmark ?? {progress: null, result: null, chart: null};
        let benchmark = {
            ...readme.status === 'fulfilled' ? readme.value : {progress: last.progress, result: last.result},
            chart: chart.status === 'fulfilled' ? chart.value : last.chart,
        };
        let error = null;
        if (!benchmark.progress && !benchmark.result && !benchmark.chart) {
            benchmark = null;
            error = 'unreadable';
        }
        // Each new failure once, not on every visit that retries it.
        const warning = failures.map(e => e.message).join('; ');
        if (warning && warning !== this._warned)
            console.warn(`Froonty: cannot read livenerf's results: ${warning}`);
        this._warned = warning;
        if (!failures.length)
            this.fetchedAt = Date.now();
        if (this.loaded &&
            JSON.stringify([benchmark, error]) === JSON.stringify([this.benchmark, this.error]))
            return;
        this.loaded = true;
        this.benchmark = benchmark;
        this.error = error;
        this.emit('changed');
    }

    async _fetchDefault(path, cancellable) {
        const dir = GLib.getenv('FROONTY_LIVENERF_DIR');
        let bytes;
        if (dir) {
            [bytes] = await Gio.File.new_for_path(GLib.build_filenamev([dir, path]))
                .load_contents_async(cancellable);
        } else {
            const url = urlFor(path);
            this._session ??= new Soup.Session({timeout: TIMEOUT_S, user_agent: 'Froonty'});
            const message = Soup.Message.new('GET', url);
            const body = await this._session.send_and_read_async(message,
                GLib.PRIORITY_DEFAULT, cancellable);
            if (message.get_status() !== Soup.Status.OK)
                throw new Error(`HTTP ${message.get_status()} from ${url}`);
            bytes = body.toArray();
        }
        if (bytes.length > MAX_SIZE)
            throw new Error(`larger than ${MAX_SIZE} bytes`);
        return new TextDecoder().decode(bytes);
    }
}
