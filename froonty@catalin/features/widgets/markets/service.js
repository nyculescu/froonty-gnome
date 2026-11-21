// SPDX-License-Identifier: GPL-3.0-or-later
// Fetches the Markets widget's indexes: Yahoo first, FRED for the US
// indexes it has when Yahoo fails (with a key in the keyring), the last
// good reading when both do.
// One request at a time, every 5 minutes while a market is open, every 30
// otherwise, and only while something holds the service.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {Emitter} from '../../../core/emitter.js';
import {lookupFredKey} from './fredKey.js';
import {
    FRED_SERIES, YahooError, anyMarketOpen, fredStartDate, fredUrl, parseFredObservations, parseYahooChart, yahooUrl,
} from './sources.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_async', 'replace_contents_finish');

export const OPEN_INTERVAL_S = 5 * 60;
export const CLOSED_INTERVAL_S = 30 * 60;
const TIMEOUT_S = 15;

export class MarketsService extends Emitter {
    /**
     * @param {Gio.Settings} settings
     * @param {object} [options]
     * @param {Function} [options.fetch] (url, cancellable) → {status, text}
     * @param {Function} [options.lookupKey] → Promise of the FRED key or null
     * @param {Function} [options.now] → ms
     * @param {string|null} [options.cachePath] null keeps nothing on disk
     */
    constructor(settings, {fetch, lookupKey, now, cachePath} = {}) {
        super();
        this._settings = settings;
        this._fetch = fetch ?? ((url, cancellable) => this._fetchDefault(url, cancellable));
        this._lookupKey = lookupKey ?? (() => lookupFredKey());
        this._now = now ?? (() => Date.now());
        this._cachePath = cachePath !== undefined ? cachePath
            : GLib.build_filenamev([GLib.get_user_cache_dir(), 'froonty', 'markets.json']);
        this._rows = [];
        this._refreshing = false;
        this._pending = false;
        this._timerId = 0;
        this._settingsIds = [];
        this._cancellable = null;
        this._session = null;
    }

    /** [{symbol, reading: object|null, error: string, stale: bool}], in the settings' order. */
    get rows() {
        return this._rows;
    }

    get refreshing() {
        return this._refreshing;
    }

    start() {
        this._cancellable = new Gio.Cancellable();
        this._settingsIds = ['widgets-markets-symbols', 'widgets-markets-range'].map(key =>
            this._settings.connect(`changed::${key}`, () => this.refresh()));
        this._loadCache().finally(() => this.refresh());
    }

    stop() {
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._cancellable?.cancel();
        this._cancellable = null;
        this._session?.abort();
        this._session = null;
        this._clearTimer();
    }

    // A refresh asked for during one runs once it ends, with the settings
    // as they are then.
    async refresh() {
        if (!this._cancellable)
            return;
        if (this._refreshing) {
            this._pending = true;
            return;
        }
        this._clearTimer();
        this._refreshing = true;
        this.emit('changed');
        const cancellable = this._cancellable;
        try {
            do {
                this._pending = false;
                // eslint-disable-next-line no-await-in-loop
                await this._refreshOnce(cancellable);
            } while (this._pending && !cancellable.is_cancelled());
        } finally {
            this._refreshing = false;
        }
        if (cancellable.is_cancelled())
            return;
        this.emit('changed');
        this._saveCache().catch(e => console.warn(`Froonty: Markets cache: ${e.message}`));
        const open = anyMarketOpen(this._rows.map(r => r.reading), this._now());
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            open ? OPEN_INTERVAL_S : CLOSED_INTERVAL_S, () => {
                this._timerId = 0;
                this.refresh();
                return GLib.SOURCE_REMOVE;
            });
    }

    async _refreshOnce(cancellable) {
        const symbols = this._symbols();
        const range = this._settings.get_string('widgets-markets-range');
        const previous = new Map(this._rows.map(r => [r.symbol, r]));
        // Looked up once a refresh, when first needed.
        let key;
        const fredKey = async () => {
            if (key === undefined)
                key = await this._lookupKey().catch(() => null);
            return key;
        };
        const rows = [];
        for (const symbol of symbols) {
            if (cancellable.is_cancelled())
                return;
            // eslint-disable-next-line no-await-in-loop
            rows.push(await this._readSymbol(symbol, range, previous.get(symbol), fredKey, cancellable));
        }
        if (!cancellable.is_cancelled())
            this._rows = rows;
    }

    async _readSymbol(symbol, range, previous, fredKey, cancellable) {
        let error;
        try {
            const {status, text} = await this._fetch(yahooUrl(symbol, range), cancellable);
            try {
                return {symbol, reading: parseYahooChart(text), error: '', stale: false};
            } catch (e) {
                throw status === 200 || e instanceof YahooError ? e : new Error(`Yahoo: HTTP ${status}`);
            }
        } catch (e) {
            error = e.message;
        }
        const series = FRED_SERIES[symbol];
        const apiKey = series ? await fredKey() : null;
        if (apiKey && !cancellable.is_cancelled()) {
            try {
                const {status, text} = await this._fetch(
                    fredUrl(series, fredStartDate(range, this._now()), apiKey), cancellable);
                // FRED explains a refusal in JSON, a bad key say.
                try {
                    return {symbol, reading: parseFredObservations(symbol, text), error: '', stale: false};
                } catch (e) {
                    throw status === 200 || e.message.startsWith('FRED:') ? e : new Error(`FRED: HTTP ${status}`);
                }
            } catch (e) {
                error = `${error}; ${e.message}`;
            }
        }
        return {symbol, reading: previous?.reading ?? null, error, stale: Boolean(previous?.reading)};
    }

    _symbols() {
        return this._settings.get_strv('widgets-markets-symbols')
            .map(s => s.trim()).filter(Boolean);
    }

    _clearTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }

    async _fetchDefault(url, cancellable) {
        this._session ??= new Soup.Session({timeout: TIMEOUT_S, user_agent: 'Froonty'});
        const message = Soup.Message.new('GET', url);
        const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
        return {status: message.get_status(), text: new TextDecoder().decode(bytes.toArray())};
    }

    // The last readings, shown until the first refresh ends (offline at
    // login, say). Only for the same range: another one would mislead.
    async _loadCache() {
        if (!this._cachePath)
            return;
        try {
            const [contents] = await Gio.File.new_for_path(this._cachePath)
                .load_contents_async(this._cancellable);
            const cache = JSON.parse(new TextDecoder().decode(contents));
            if (cache.range !== this._settings.get_string('widgets-markets-range'))
                return;
            const bySymbol = new Map(cache.rows.map(r => [r.symbol, r]));
            this._rows = this._symbols().filter(s => bySymbol.get(s)?.reading)
                .map(s => ({...bySymbol.get(s), error: '', stale: true}));
            this.emit('changed');
        } catch {}
    }

    async _saveCache() {
        if (!this._cachePath)
            return;
        const file = Gio.File.new_for_path(this._cachePath);
        GLib.mkdir_with_parents(file.get_parent().get_path(), 0o755);
        const cache = {
            range: this._settings.get_string('widgets-markets-range'),
            rows: this._rows.filter(r => r.reading).map(({symbol, reading}) => ({symbol, reading})),
        };
        await file.replace_contents_async(new TextEncoder().encode(JSON.stringify(cache)),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }
}
