// SPDX-License-Identifier: GPL-3.0-or-later
// Fetches the Markets symbols and keeps their prices live. Each step
// stands in when the one before it fails: the live price (US stocks and
// ETFs from Alpaca with keys, crypto from Coinbase, while their market is
// open; streams.js, live.js), then Yahoo, then FRED for the US indexes it
// has (with a key in the keyring), then the last good reading. Yahoo gives
// every symbol its graph and the close its change is measured from; a live
// price goes on top of that reading.
// One request at a time, and only while something holds the service.
// While its market is open a symbol is fetched every minute, every 5 while
// its stream is live (for the graph), every 30 for a mutual fund (one
// price a day); not while it is closed (sources.js isDue); every 30 for
// FRED or after an error.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {Emitter} from '../../core/emitter.js';
import {lookupAlpacaKeys, lookupFredKey} from './keys.js';
import {LiveStream} from './live.js';
import {
    FRED_SERIES, YahooError, alpacaSymbol, applyTick, chosenSymbols, fredStartDate, fredUrl, isDue, liveAllowed,
    nextCheckDelay, parseFredObservations, parseYahooChart, streamRoute, tickReading, yahooUrl,
} from './sources.js';
import {ALPACA_MAX_SYMBOLS, alpacaProtocol, coinbaseProtocol} from './streams.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_async', 'replace_contents_finish');

export const OPEN_INTERVAL_S = 60;
export const STREAMED_INTERVAL_S = 5 * 60;
export const FUND_INTERVAL_S = 30 * 60;
export const CLOSED_INTERVAL_S = 30 * 60;
// Live prices reach the views at most this often ('live').
export const LIVE_FLUSH_MS = 1000;
const TIMEOUT_S = 15;

const ROUTES = ['alpaca', 'coinbase'];

// The stream's name for a Yahoo symbol.
const streamName = (route, symbol) => (route === 'alpaca' ? alpacaSymbol(symbol) : symbol.toUpperCase());

export class MarketsService extends Emitter {
    /**
     * @param {Gio.Settings} settings
     * @param {object} [options]
     * @param {Function} [options.fetch] (url, cancellable) → {status, text}
     * @param {Function} [options.lookupKey] → Promise of the FRED key or null
     * @param {Function} [options.lookupAlpaca] → Promise of {key, secret} or null
     * @param {Function} [options.makeStream] protocol → a LiveStream (or a fake)
     * @param {Function} [options.now] → ms
     * @param {string|null} [options.cachePath] null keeps nothing on disk
     */
    constructor(settings, {fetch, lookupKey, lookupAlpaca, makeStream, now, cachePath} = {}) {
        super();
        this._settings = settings;
        this._fetch = fetch ?? ((url, cancellable) => this._fetchDefault(url, cancellable));
        this._lookupKey = lookupKey ?? (() => lookupFredKey());
        this._lookupAlpaca = lookupAlpaca ?? (() => lookupAlpacaKeys());
        this._makeStream = makeStream ?? (protocol => new LiveStream(protocol));
        this._now = now ?? (() => Date.now());
        this._cachePath = cachePath !== undefined ? cachePath
            : GLib.build_filenamev([GLib.get_user_cache_dir(), 'froonty', 'markets.json']);
        this._rows = [];
        this._refreshing = false;
        this._pending = false;
        this._pendingAll = false;
        this._timerId = 0;
        this._settingsIds = [];
        this._cancellable = null;
        this._session = null;
        // Per route: the stream, what it was made with (the keys), its
        // signal ids, and stream name → Yahoo symbol.
        this._streams = {};
        this._names = {alpaca: new Map(), coinbase: new Map()};
        // Yahoo symbol → its route, and its last live price {price, timeMs, source}.
        this._routes = new Map();
        this._ticks = new Map();
        this._liveChanged = new Set();
        this._flushId = 0;
        this._syncSerial = 0;
    }

    /** [{symbol, reading: object|null, error: string, stale: bool}], in the settings' order. */
    get rows() {
        return this._rows;
    }

    get refreshing() {
        return this._refreshing;
    }

    /** The span the graphs show and the change is measured over. */
    get range() {
        return this._settings.get_string('widgets-markets-range');
    }

    /** Why a live stream is down ("Alpaca: auth failed"), or ''. */
    get liveProblem() {
        return Object.values(this._streams)
            .filter(({stream}) => ['retrying', 'failed'].includes(stream.state) && stream.error)
            .map(({stream}) => stream.error).join('; ');
    }

    start() {
        this._cancellable = new Gio.Cancellable();
        // Other symbols, another span, live prices on or off: every
        // symbol is fetched again.
        this._settingsIds = ['widgets-markets-symbols', 'widgets-markets-range', 'markets-live'].map(key =>
            this._settings.connect(`changed::${key}`, () => {
                this._ticks.clear();
                this.refresh({all: true});
            }));
        this._loadCache().finally(() => this.refresh({all: true}));
    }

    stop() {
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._cancellable?.cancel();
        this._cancellable = null;
        this._session?.abort();
        this._session = null;
        for (const route of ROUTES)
            this._dropStream(route);
        this._ticks.clear();
        if (this._flushId) {
            GLib.source_remove(this._flushId);
            this._flushId = 0;
        }
        this._clearTimer();
    }

    // A refresh asked for during one runs once it ends, with the settings
    // as they are then. A timed one fetches only the symbols that are due
    // (sources.js isDue: not while their market is closed); `all` fetches
    // every one.
    async refresh({all = false} = {}) {
        if (!this._cancellable)
            return;
        if (this._refreshing) {
            this._pending = true;
            this._pendingAll ||= all;
            return;
        }
        this._clearTimer();
        this._refreshing = true;
        this.emit('changed');
        const cancellable = this._cancellable;
        try {
            do {
                this._pending = false;
                const every = all || this._pendingAll;
                this._pendingAll = false;
                // eslint-disable-next-line no-await-in-loop
                await this._refreshOnce(cancellable, every);
            } while (this._pending && !cancellable.is_cancelled());
        } finally {
            this._refreshing = false;
        }
        if (cancellable.is_cancelled())
            return;
        this.emit('changed');
        this._saveCache().catch(e => console.warn(`Froonty: Markets cache: ${e.message}`));
        await this._syncStreams();
        this._schedule();
    }

    async _refreshOnce(cancellable, all) {
        const symbols = this._symbols();
        const range = this.range;
        const previous = new Map(this._rows.map(r => [r.symbol, r]));
        // Looked up once a refresh, when first needed.
        let key;
        const fredKey = async () => {
            if (key === undefined)
                key = await this._lookupKey().catch(() => null);
            return key;
        };
        const fetched = new Map();
        for (const symbol of symbols) {
            if (cancellable.is_cancelled())
                return;
            const before = previous.get(symbol);
            if (!all && before && !isDue(before, this._now(), this._openS(before)))
                continue;
            const checkedMs = this._now();
            // eslint-disable-next-line no-await-in-loop
            const row = await this._readSymbol(symbol, range, before, fredKey, cancellable);
            fetched.set(symbol, this._withTick({...row, checkedMs}));
        }
        if (cancellable.is_cancelled())
            return;
        // The rows not fetched keep the live prices that came meanwhile.
        const current = new Map(this._rows.map(r => [r.symbol, r]));
        this._rows = symbols.map(s => fetched.get(s) ?? current.get(s) ?? previous.get(s));
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
                    return {symbol, reading: parseFredObservations(symbol, text, range), error: '', stale: false};
                } catch (e) {
                    throw status === 200 || e.message.startsWith('FRED:') ? e : new Error(`FRED: HTTP ${status}`);
                }
            } catch (e) {
                error = `${error}; ${e.message}`;
            }
        }
        return {symbol, reading: previous?.reading ?? null, error, stale: Boolean(previous?.reading)};
    }

    // The row with its last live price, if that is newer and counts now;
    // without a reading, one made from the price alone.
    _withTick(row) {
        const tick = this._ticks.get(row.symbol);
        if (!tick || !liveAllowed(row, tick.source, this._now()))
            return row;
        const reading = row.reading
            ? applyTick(row.reading, tick, this.range, tick.source)
            : tickReading(row.symbol, tick, tick.source);
        return reading === row.reading ? row : {...row, reading};
    }

    // Seconds between fetches while the symbol's market is open.
    _openS(row) {
        if (row.reading?.instrumentType === 'MUTUALFUND')
            return FUND_INTERVAL_S;
        const route = this._routes.get(row.symbol);
        const stream = route && this._streams[route]?.stream;
        return stream?.isLive(streamName(route, row.symbol)) ? STREAMED_INTERVAL_S : OPEN_INTERVAL_S;
    }

    // Each stream gets the symbols that take it and whose market is open
    // now; one without any closes. Alpaca needs keys: without them, or
    // with others than its stream has, it is (made again and) given none.
    async _syncStreams() {
        const serial = ++this._syncSerial;
        const live = this._settings.get_boolean('markets-live');
        const now = this._now();
        const wanted = {alpaca: [], coinbase: []};
        const names = {alpaca: new Map(), coinbase: new Map()};
        const routes = new Map();
        for (const row of this._rows) {
            const route = streamRoute(row.symbol, row.reading);
            if (!route)
                continue;
            routes.set(row.symbol, route);
            const name = streamName(route, row.symbol);
            names[route].set(name, row.symbol);
            if (live && liveAllowed(row, route, now))
                wanted[route].push(name);
        }
        wanted.alpaca = wanted.alpaca.slice(0, ALPACA_MAX_SYMBOLS);
        this._routes = routes;
        this._names = names;

        this._useStream('coinbase', 'coinbase', () => coinbaseProtocol(), wanted.coinbase);
        const keys = wanted.alpaca.length ? await this._lookupAlpaca().catch(() => null) : null;
        if (serial !== this._syncSerial || !this._cancellable)
            return;
        if (keys)
            this._useStream('alpaca', `${keys.key}\n${keys.secret}`, () => alpacaProtocol(keys), wanted.alpaca);
        else
            this._dropStream('alpaca');
    }

    _useStream(route, identity, protocol, symbols) {
        if (this._streams[route] && this._streams[route].identity !== identity)
            this._dropStream(route);
        if (!this._streams[route]) {
            if (!symbols.length)
                return;
            const stream = this._makeStream(protocol());
            const ids = [
                stream.connect('ticks', (_stream, ticks) => this._onTicks(route, ticks)),
                stream.connect('state', () => this._onStreamState()),
            ];
            this._streams[route] = {stream, identity, ids};
        }
        this._streams[route].stream.setSymbols(symbols);
    }

    _dropStream(route) {
        const held = this._streams[route];
        if (!held)
            return;
        delete this._streams[route];
        for (const id of held.ids)
            held.stream.disconnect(id);
        held.stream.destroy();
        this._onStreamState();
    }

    // A stream that went live polls its symbols less often; one that
    // dropped, more often again.
    _onStreamState() {
        if (!this._cancellable)
            return;
        if (!this._refreshing)
            this._schedule();
        this.emit('changed');
    }

    _onTicks(route, ticks) {
        if (!this._cancellable)
            return;
        const now = this._now();
        const range = this.range;
        for (const tick of ticks) {
            const symbol = this._names[route].get(tick.symbol);
            const index = this._rows.findIndex(r => r.symbol === symbol);
            if (index < 0 || !liveAllowed(this._rows[index], route, now))
                continue;
            const price = {price: tick.price, timeMs: tick.timeMs, source: route};
            this._ticks.set(symbol, price);
            const row = this._rows[index];
            const reading = row.reading ? applyTick(row.reading, price, range, route) : tickReading(symbol, price, route);
            if (reading === row.reading)
                continue;
            this._rows[index] = {...row, reading};
            this._liveChanged.add(symbol);
        }
        if (!this._liveChanged.size || this._flushId)
            return;
        this._flushId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LIVE_FLUSH_MS, () => {
            this._flushId = 0;
            const symbols = [...this._liveChanged];
            this._liveChanged.clear();
            this.emit('live', symbols);
            return GLib.SOURCE_REMOVE;
        });
    }

    _schedule() {
        this._clearTimer();
        if (!this._cancellable)
            return;
        const delay = nextCheckDelay(this._rows, this._now(), row => this._openS(row), CLOSED_INTERVAL_S);
        if (delay === null)
            return;
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timerId = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _symbols() {
        return chosenSymbols(this._settings.get_strv('widgets-markets-symbols'));
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
            if (cache.range !== this.range)
                return;
            const bySymbol = new Map(cache.rows.map(r => [r.symbol, r]));
            this._rows = this._symbols().filter(s => bySymbol.get(s)?.reading)
                .map(s => ({...bySymbol.get(s), error: '', stale: true}));
            this.emit('changed');
        } catch {}
    }

    // Without the live mark: at the next start the price is not live.
    async _saveCache() {
        if (!this._cachePath)
            return;
        const file = Gio.File.new_for_path(this._cachePath);
        GLib.mkdir_with_parents(file.get_parent().get_path(), 0o755);
        const cache = {
            range: this.range,
            rows: this._rows.filter(r => r.reading)
                .map(({symbol, reading}) => ({symbol, reading: {...reading, live: undefined}})),
        };
        await file.replace_contents_async(new TextEncoder().encode(JSON.stringify(cache)),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }
}
