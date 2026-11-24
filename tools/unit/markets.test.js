// SPDX-License-Identifier: GPL-3.0-or-later
// Markets: Yahoo's and FRED's readers, the live streams' messages and
// connection, and the service's fallbacks with a fake fetch and fake
// streams (plain gjs, no network).

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {Emitter} from '../../froonty@catalin/core/emitter.js';
import {LiveStream} from '../../froonty@catalin/features/markets/live.js';
import {
    MAX_SYMBOLS, alpacaSymbol, anyMarketOpen, applyTick, chosenSymbols, expectedOpen, fredStartDate, fredUrl, isDue,
    liveAllowed, marketState, nextCheckDelay, parseFredObservations, parseYahooChart, streamRoute, tickReading,
    usRegularSession, yahooUrl,
} from '../../froonty@catalin/features/markets/sources.js';
import {MarketsService} from '../../froonty@catalin/features/markets/service.js';
import {
    alpacaProtocol, coinbaseProtocol, parseAlpaca, parseCoinbase,
} from '../../froonty@catalin/features/markets/streams.js';
import {done, eq, makeSettings, ok, sleep, test, waitFor} from './test.js';

// Shaped like Yahoo's answer for ^GSPTSE, range=1d, on 2026-11-20.
const yahooDay = (symbol = '^GSPTSE') => JSON.stringify({
    chart: {
        result: [{
            meta: {
                currency: 'CAD', symbol, shortName: 'S&P/TSX Composite index', range: '1d',
                regularMarketPrice: 33189.85, previousClose: 34028.73, chartPreviousClose: 34028.73,
                regularMarketTime: 1795209600, gmtoffset: -18000,
                currentTradingPeriod: {regular: {start: 1795185000, end: 1795208400}},
            },
            timestamp: [1795185000, 1795185300, 1795185600],
            indicators: {quote: [{close: [33820.98, null, 33189.85]}]},
        }],
        error: null,
    },
});

const yahooNotFound = JSON.stringify({
    chart: {result: null, error: {code: 'Not Found', description: 'No data found, symbol may be delisted'}},
});

const FRED = JSON.stringify({
    observations: [
        {date: '2026-11-17', value: '7340.53'},
        {date: '2026-11-18', value: '7323.63'},
        {date: '2026-11-19', value: '7175.83'},
        {date: '2026-11-20', value: '.'},
    ],
});

test('Yahoo: price, previous close, change, points without gaps, session', () => {
    const r = parseYahooChart(yahooDay());
    eq([r.symbol, r.name, r.currency, r.price, r.baseline], ['^GSPTSE', 'S&P/TSX Composite index', 'CAD', 33189.85, 34028.73]);
    eq(r.changePercent.toFixed(3), '-2.465');
    eq(r.points.map(p => p.v), [33820.98, 33189.85]);
    eq(r.points[0].t, 1795185000000);
    eq(r.session, {startMs: 1795185000000, endMs: 1795208400000});
    eq(r.source, 'yahoo');
});

test('Yahoo: a month of days ends at the live price; the change is over the month, as the graph', () => {
    const r = parseYahooChart(JSON.stringify({
        chart: {
            result: [{
                meta: {symbol: '^GSPC', range: '1mo', regularMarketPrice: 110, chartPreviousClose: 50, gmtoffset: -18000},
                // Days at 14:30 UTC (09:30 in New York).
                regularMarketTime: 1795208400,
                timestamp: [1795012200, 1795098600, 1795185000],
                indicators: {quote: [{close: [90, 100, null]}]},
            }],
        },
    }));
    eq(r.points.map(p => p.v), [90, 100, 110]);
    eq(r.baseline, 50);
    eq(r.changePercent, 120);
    const noPrevious = parseYahooChart(JSON.stringify({
        chart: {
            result: [{
                meta: {symbol: 'MU', range: '6mo', regularMarketPrice: 697.13},
                timestamp: [1795012200, 1795098600],
                indicators: {quote: [{close: [877.55, 594.51]}]},
            }],
        },
    }));
    eq(noPrevious.baseline, 877.55, 'without the close before the span, its first close');
});

test('Yahoo: its own message for an unknown symbol', () => {
    let message = '';
    try {
        parseYahooChart(yahooNotFound);
    } catch (e) {
        message = e.message;
    }
    eq(message, 'No data found, symbol may be delisted');
});

test('Yahoo: the address carries the range and its bar size', () => {
    eq(yahooUrl('^GSPC', '1d'), 'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=1d&interval=5m');
    eq(yahooUrl('^GSPC', '1y'), 'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=1y&interval=1d');
});

test('FRED: daily closes, empty days skipped, change against the day before', () => {
    const r = parseFredObservations('^GSPC', FRED);
    eq(r.points.length, 3);
    eq([r.name, r.price, r.baseline, r.source], ['S&P 500', 7175.83, 7323.63, 'fred']);
    eq(r.timeMs, Date.parse('2026-11-19T00:00:00Z'));
    ok(r.changePercent < 0);
    eq(parseFredObservations('^GSPC', FRED, '1mo').baseline, 7340.53, 'longer spans: from the first close');
});

test('FRED: its own message for a refusal; the key only in the address', () => {
    let message = '';
    try {
        parseFredObservations('^GSPC', JSON.stringify({error_code: 400, error_message: 'Bad Request.  The value for variable api_key is not registered.'}));
    } catch (e) {
        message = e.message;
    }
    eq(message, 'FRED: Bad Request.  The value for variable api_key is not registered.');
    eq(fredUrl('SP500', '2026-11-13', 'k&y'),
        'https://api.stlouisfed.org/fred/series/observations?series_id=SP500&observation_start=2026-11-13&file_type=json&api_key=k%26y');
});

test('FRED: at least a week back, so one day still has a close before it', () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    eq(fredStartDate('1d', now), '2026-11-13');
    eq(fredStartDate('1mo', now), '2026-10-20');
});

test('up to 30 symbols: trimmed, no empty or repeated ones (any case), the first 30 kept', () => {
    eq(MAX_SYMBOLS, 30);
    eq(chosenSymbols([' ^GSPC', '', '^gspc', 'AAPL ', '^GSPTSE']), ['^GSPC', 'AAPL', '^GSPTSE']);
    const forty = Array.from({length: 40}, (_, i) => `S${i}`);
    eq(chosenSymbols(forty), forty.slice(0, 30));
});

test('a market is open only inside its regular session', () => {
    const reading = {session: {startMs: 100, endMs: 200}};
    eq([anyMarketOpen([reading], 150), anyMarketOpen([reading], 200), anyMarketOpen([null], 150)], [true, false, false]);
});

// The fixture's session: Friday 2026-11-20, 14:30-21:00 UTC (9:30-16:00
// in Toronto); the next weekday's opening is Monday the 23rd at 14:30.
const OPEN = 1795185000000;
const CLOSE = 1795208400000;
const MONDAY = OPEN + 3 * 86400000;

test('open or closed by the session; nothing for FRED', () => {
    const reading = parseYahooChart(yahooDay());
    eq(reading.utcOffsetMs, -5 * 3600000);
    eq([marketState(reading, OPEN + 60000), marketState(reading, CLOSE), marketState(reading, OPEN - 1)],
        ['open', 'closed', 'closed']);
    eq(marketState({session: null}, OPEN), null);
});

test('expected opening: the session\'s start if ahead, else the next weekday\'s, a holiday skipped', () => {
    const reading = parseYahooChart(yahooDay());
    eq(expectedOpen(reading, OPEN - 3600000), OPEN, 'checked before it opened');
    eq(expectedOpen(reading, CLOSE + 60000), MONDAY, 'after Friday\'s close: Monday, not Saturday');
    eq(expectedOpen(reading, MONDAY + 5000), MONDAY + 86400000, 'still Friday\'s session on Monday: a holiday');
    eq(expectedOpen({session: null}), null);
});

test('due: while open, once after the close, then not until the expected opening', () => {
    const reading = parseYahooChart(yahooDay());
    const row = checkedMs => ({reading, error: '', checkedMs});
    eq(isDue(row(OPEN + 60000), OPEN + 400000), true, 'open');
    eq(isDue(row(CLOSE - 60000), CLOSE + 5000), true, 'the closing price');
    eq(isDue(row(CLOSE + 5000), CLOSE + 3600000), false, 'closed, checked after the close');
    eq(isDue(row(CLOSE + 5000), MONDAY + 5000), true, 'Monday\'s opening');
    eq([isDue({reading: null}, OPEN), isDue({reading, error: 'offline', checkedMs: CLOSE + 5000}, CLOSE + 60000),
        isDue({reading: {session: null}, error: ''}, CLOSE)], [true, true, true], 'no reading, an error, FRED');
});

test('next check: 5 min after the last fetch while open, just after the close, then the expected opening; 30 min without a session', () => {
    const reading = parseYahooChart(yahooDay());
    eq(nextCheckDelay([{reading, error: '', checkedMs: OPEN}], OPEN + 60000, 300, 1800), 240);
    eq(nextCheckDelay([{reading, error: '', checkedMs: CLOSE - 60000}], CLOSE - 60000, 300, 1800), 65);
    eq(nextCheckDelay([{reading, error: '', checkedMs: CLOSE + 5000}], CLOSE + 5000, 300, 1800),
        (MONDAY + 5000 - CLOSE - 5000) / 1000);
    eq(nextCheckDelay([{reading: {session: null}, error: ''}], CLOSE, 300, 1800), 1800);
    eq(nextCheckDelay([], CLOSE, 300, 1800), null);
});

// Stands in for live.js LiveStream: records its symbols, and is live
// once the test says so.
class FakeStream extends Emitter {
    constructor(protocol) {
        super();
        this.protocol = protocol;
        this.symbols = [];
        this.state = 'off';
        this.error = '';
        this.destroyed = false;
    }

    get name() {
        return this.protocol.name;
    }

    setSymbols(symbols) {
        this.symbols = symbols;
    }

    isLive(symbol) {
        return this.state === 'live' && this.symbols.includes(symbol);
    }

    goLive() {
        this.state = 'live';
        this.emit('state');
    }

    destroy() {
        this.destroyed = true;
    }
}

function service(answers, key = 'test-key', now = undefined, {alpaca = null} = {}) {
    const settings = makeSettings();
    settings.set_strv('widgets-markets-symbols', ['^GSPTSE', '^GSPC', '^NOPE']);
    settings.set_string('widgets-markets-range', '1d');
    const urls = [];
    const fetch = url => {
        urls.push(url);
        const answer = answers(url);
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    };
    const lookupKey = () => Promise.resolve(key);
    const lookupAlpaca = () => Promise.resolve(alpaca);
    const streams = [];
    const makeStream = protocol => {
        const stream = new FakeStream(protocol);
        streams.push(stream);
        return stream;
    };
    return {
        service: new MarketsService(settings, {fetch, lookupKey, lookupAlpaca, makeStream, now, cachePath: null}),
        urls, settings, streams,
    };
}

test('service: a timed refresh skips an index whose market is closed; a change of settings fetches all', async () => {
    let now = CLOSE + 60000;
    const {service: s, urls, settings} = service(url => (url.includes('%5EGSPTSE')
        ? {status: 200, text: yahooDay()} : new Error('offline')), null, () => now);
    s.start();
    ok(await waitFor(() => !s.refreshing && s.rows.length === 3), 'first refresh');
    const toronto = () => urls.filter(u => u.includes('%5EGSPTSE')).length;
    eq(toronto(), 1);
    now += 3600000;
    await s.refresh();
    eq(toronto(), 1, 'closed: not fetched again');
    eq(urls.filter(u => u.includes('%5EGSPC')).length, 2, 'the failed one is tried again');
    now = MONDAY + 5000;
    await s.refresh();
    eq(toronto(), 2, 'at Monday\'s opening');
    settings.set_string('widgets-markets-range', '5d');
    ok(await waitFor(() => !s.refreshing && toronto() === 3), 'another span: all again');
    s.stop();
});

test('service: Yahoo first; FRED for a US index Yahoo fails; the error for the rest', async () => {
    const {service: s, urls} = service(url => {
        if (url.includes('%5EGSPTSE'))
            return {status: 200, text: yahooDay()};
        if (url.includes('yahoo'))
            return url.includes('%5EGSPC') ? new Error('timed out') : {status: 404, text: yahooNotFound};
        return {status: 200, text: FRED};
    });
    s.start();
    ok(await waitFor(() => !s.refreshing && s.rows.length === 3), 'refreshed');
    s.stop();
    eq(s.rows.map(r => r.reading?.source ?? null), ['yahoo', 'fred', null]);
    eq(s.rows[2].error, 'No data found, symbol may be delisted');
    eq(urls.filter(u => u.includes('stlouisfed')).length, 1);
});

test('service: no FRED key, no FRED request; Yahoo\'s error stays', async () => {
    const {service: s, urls} = service(url => (url.includes('%5EGSPTSE')
        ? {status: 200, text: yahooDay()} : new Error('timed out')), null);
    s.start();
    ok(await waitFor(() => !s.refreshing && s.rows.length === 3), 'refreshed');
    s.stop();
    eq(urls.filter(u => u.includes('stlouisfed')).length, 0);
    eq(s.rows[1].error, 'timed out');
});

test('service: when both fail, the last good reading stays, marked stale', async () => {
    let online = true;
    const {service: s} = service(url => {
        if (!online)
            return new Error('offline');
        return url.includes('yahoo') ? {status: 200, text: yahooDay()} : new Error('unused');
    });
    s.start();
    ok(await waitFor(() => !s.refreshing && s.rows.length === 3), 'first refresh');
    online = false;
    // Every index, closed markets too (a timed refresh skips them).
    await s.refresh({all: true});
    s.stop();
    eq(s.rows.map(r => [r.stale, Boolean(r.reading)]), [[true, true], [true, true], [true, true]]);
    ok(s.rows[1].error.includes('offline'));
});

test('service: 40 symbols in the setting, 30 fetched and shown', async () => {
    const {service: s, settings, urls} = service(() => ({status: 200, text: yahooDay()}));
    settings.set_strv('widgets-markets-symbols', Array.from({length: 40}, (_, i) => `^S${i}`));
    s.start();
    ok(await waitFor(() => !s.refreshing && s.rows.length === 30), 'refreshed');
    s.stop();
    eq(urls.filter(u => u.includes('yahoo')).length, 30);
    eq(s.rows.at(-1).symbol, '^S29');
});

test('service: a change of symbols refreshes with the new list', async () => {
    const {service: s, settings} = service(() => ({status: 200, text: yahooDay()}));
    s.start();
    ok(await waitFor(() => !s.refreshing && s.rows.length === 3), 'first refresh');
    settings.set_strv('widgets-markets-symbols', ['^GSPTSE']);
    ok(await waitFor(() => !s.refreshing && s.rows.length === 1), 'second refresh');
    s.stop();
});

// A US stock's day as Yahoo gives it: Friday's session (OPEN to CLOSE).
const yahooStock = (symbol = 'AAPL', {type = 'EQUITY', zone = 'America/New_York'} = {}) => JSON.stringify({
    chart: {
        result: [{
            meta: {
                currency: 'USD', symbol, shortName: `${symbol} Inc.`, range: '1d', instrumentType: type,
                exchangeTimezoneName: zone, regularMarketPrice: 100, previousClose: 98,
                regularMarketTime: OPEN / 1000 + 600, gmtoffset: -18000,
                currentTradingPeriod: {regular: {start: OPEN / 1000, end: CLOSE / 1000}},
            },
            timestamp: [OPEN / 1000, OPEN / 1000 + 300],
            indicators: {quote: [{close: [99, 100]}]},
        }],
    },
});

const yahooCrypto = (symbol = 'BTC-USD') => JSON.stringify({
    chart: {
        result: [{
            meta: {
                currency: 'USD', symbol, shortName: 'Bitcoin USD', range: '1d', instrumentType: 'CRYPTOCURRENCY',
                exchangeTimezoneName: 'UTC', regularMarketPrice: 61000, previousClose: 60000,
                regularMarketTime: OPEN / 1000, gmtoffset: 0,
                currentTradingPeriod: {regular: {start: OPEN / 1000 - 52200, end: OPEN / 1000 + 34140}},
            },
            timestamp: [OPEN / 1000 - 300],
            indicators: {quote: [{close: [60900]}]},
        }],
    },
});

test('routes: US stocks and ETFs to Alpaca, crypto pairs to Coinbase, the rest Yahoo only', () => {
    const stock = parseYahooChart(yahooStock());
    eq([streamRoute('AAPL', stock), streamRoute('SPY', parseYahooChart(yahooStock('SPY', {type: 'ETF'})))],
        ['alpaca', 'alpaca']);
    eq(streamRoute('SHOP.TO', parseYahooChart(yahooStock('SHOP.TO', {zone: 'America/Toronto'}))), null, 'Toronto');
    eq(streamRoute('VFIAX', parseYahooChart(yahooStock('VFIAX', {type: 'MUTUALFUND'}))), null, 'a mutual fund');
    eq(streamRoute('BTC-USD', parseYahooChart(yahooCrypto())), 'coinbase');
    eq(['brk-b', 'MSFT', 'eth-eur', 'VFIAX', '^GSPC', 'GC=F', 'EURUSD=X', 'VWCE.DE'].map(s => streamRoute(s, null)),
        ['alpaca', 'alpaca', 'coinbase', null, null, null, null, null], 'without a reading: by its shape');
    eq(streamRoute('^GSPC', parseFredObservations('^GSPC', FRED)), null);
    eq(alpacaSymbol('brk-b'), 'BRK.B');
});

test('crypto is always open and has no session; its graph is fetched as an open market\'s', () => {
    const reading = parseYahooChart(yahooCrypto());
    eq([reading.continuous, reading.session, marketState(reading, MONDAY - 86400000)], [true, null, 'open']);
    eq(nextCheckDelay([{reading, error: '', checkedMs: OPEN}], OPEN, 60, 1800), 60);
});

test('New York\'s regular hours: weekdays 9:30 to 16:00, daylight saving included', () => {
    eq([usRegularSession(OPEN), usRegularSession(OPEN - 60000), usRegularSession(CLOSE - 60000), usRegularSession(CLOSE)],
        [true, false, true, false]);
    eq(usRegularSession(OPEN + 86400000), false, 'Saturday');
    // Monday 2026-07-06, 9:30 EDT = 13:30 UTC.
    eq([usRegularSession(Date.parse('2026-07-06T13:30:00Z')), usRegularSession(Date.parse('2026-07-06T13:29:00Z'))],
        [true, false]);
});

test('a live price counts in the regular session only: Yahoo\'s while fresh, else New York\'s hours; crypto always', () => {
    const reading = parseYahooChart(yahooStock());
    const row = {symbol: 'AAPL', reading, error: '', stale: false};
    eq([liveAllowed(row, 'alpaca', OPEN + 60000), liveAllowed(row, 'alpaca', CLOSE + 60000)], [true, false]);
    // Monday: the stale reading still has Friday's session.
    eq(liveAllowed({...row, stale: true}, 'alpaca', MONDAY + 60000), true, 'stale: by the clock');
    eq(liveAllowed({symbol: 'AAPL', reading: null}, 'alpaca', MONDAY + 60000), true);
    eq(liveAllowed({symbol: 'BTC-USD', reading: null}, 'coinbase', OPEN + 86400000), true, 'crypto on a Saturday');
});

test('a live price: in the last bar it moves the last point, later it adds one; an older one changes nothing', () => {
    const reading = parseYahooChart(yahooStock());
    const moved = applyTick(reading, {price: 101, timeMs: OPEN + 660000}, '1d', 'alpaca');
    eq([moved.price, moved.live, moved.points.length, moved.points.at(-1)], [101, 'alpaca', 3, {t: OPEN + 660000, v: 101}]);
    eq(moved.changePercent.toFixed(3), (3 / 98 * 100).toFixed(3), 'from the same close');
    const same = applyTick(moved, {price: 102, timeMs: OPEN + 700000}, '1d', 'alpaca');
    eq([same.points.length, same.points.at(-1).v], [3, 102], 'same 5-minute bar');
    const later = applyTick(same, {price: 103, timeMs: OPEN + 960000}, '1d', 'alpaca');
    eq(later.points.length, 4, 'the next bar');
    eq(applyTick(later, {price: 1, timeMs: OPEN}, '1d', 'alpaca'), later, 'older than the reading');
    eq(reading.price, 100, 'the reading itself is left as it was');
});

test('a reading from a live price alone: no change, its own name', () => {
    const r = tickReading('ETH-EUR', {price: 1584, timeMs: OPEN}, 'coinbase');
    eq([r.name, r.currency, r.price, r.changePercent, r.continuous, r.live, r.points.length],
        ['ETH-EUR', 'EUR', 1584, null, true, 'coinbase', 1]);
});

test('due while open: once the interval passed since the last fetch, a tenth early', () => {
    const reading = parseYahooChart(yahooStock());
    const row = {reading, error: '', checkedMs: OPEN + 600000};
    eq([isDue(row, OPEN + 630000, 60), isDue(row, OPEN + 654000, 60), isDue(row, OPEN + 654000, 300)],
        [false, true, false]);
    eq(nextCheckDelay([{...row, symbol: 'A'}, {...row, symbol: 'B'}], OPEN + 600000,
        r => (r.symbol === 'A' ? 300 : 60), 1800), 60, 'the soonest row');
});

test('Alpaca: auth, then trades; errors that end the connection, and those that end the tries', () => {
    const protocol = alpacaProtocol({key: 'PK1', secret: 's'});
    eq(JSON.parse(protocol.hello[0]), {action: 'auth', key: 'PK1', secret: 's'});
    eq(JSON.parse(protocol.subscribe(['AAPL', 'BRK.B'])[0]), {action: 'subscribe', trades: ['AAPL', 'BRK.B']});
    eq(parseAlpaca('[{"T":"success","msg":"connected"}]'), {ticks: [], events: []});
    eq(parseAlpaca('[{"T":"success","msg":"authenticated"}]').events, [{type: 'authenticated'}]);
    const trades = parseAlpaca(JSON.stringify([
        {T: 't', S: 'AAPL', i: 1, x: 'V', p: 126.55, s: 1, t: '2026-11-20T15:51:44.208123456Z', z: 'C'},
        {T: 'q', S: 'AAPL', bp: 126.5},
        {T: 't', S: 'MSFT', p: 'x', t: '2026-11-20T15:51:44Z'},
    ]));
    eq(trades.ticks, [{symbol: 'AAPL', price: 126.55, timeMs: Date.parse('2026-11-20T15:51:44.208Z')}]);
    const [failed] = parseAlpaca('[{"T":"error","code":402,"msg":"auth failed"}]').events;
    eq([failed.message, failed.close, failed.fatal], ['auth failed', true, true]);
    const [limit] = parseAlpaca('[{"T":"error","code":406,"msg":"connection limit exceeded"}]').events;
    eq([limit.close, limit.fatal], [true, false]);
    const [symbols] = parseAlpaca('[{"T":"error","code":405,"msg":"symbol limit exceeded"}]').events;
    eq([symbols.close, symbols.fatal], [false, false]);
});

test('Coinbase: heartbeats on connect, the ticker\'s snapshot and updates as prices', () => {
    const protocol = coinbaseProtocol();
    eq(JSON.parse(protocol.hello[0]), {type: 'subscribe', channel: 'heartbeats'});
    eq(JSON.parse(protocol.subscribe(['BTC-USD'])[0]), {type: 'subscribe', product_ids: ['BTC-USD'], channel: 'ticker'});
    // As Coinbase sent it on 2026-11-23.
    const snapshot = parseCoinbase(JSON.stringify({
        channel: 'ticker', timestamp: '2026-11-23T20:30:25.115408461Z', sequence_num: 0,
        events: [{type: 'snapshot', tickers: [{type: 'ticker', product_id: 'BTC-USD', price: '61193.93'}]}],
    }));
    eq(snapshot.ticks, [{symbol: 'BTC-USD', price: 61193.93, timeMs: Date.parse('2026-11-23T20:30:25.115Z')}]);
    eq(parseCoinbase(JSON.stringify({channel: 'subscriptions', events: [{subscriptions: {ticker: ['BTC-USD']}}]})),
        {ticks: [], events: []});
    eq(parseCoinbase('{"type":"error","message":"failure to subscribe"}').events[0].message, 'failure to subscribe');
});

// Stands in for a Soup.WebsocketConnection.
class FakeSocket extends Emitter {
    constructor() {
        super();
        this.sent = [];
        this.state = Soup.WebsocketState.OPEN;
    }

    send_text(text) {
        this.sent.push(JSON.parse(text));
    }

    close() {
        this.state = Soup.WebsocketState.CLOSED;
    }

    receive(message) {
        this.emit('message', Soup.WebsocketDataType.TEXT, new GLib.Bytes(new TextEncoder().encode(JSON.stringify(message))));
    }

    drop() {
        this.state = Soup.WebsocketState.CLOSED;
        this.emit('closed');
    }
}

function liveStream(protocol) {
    const sockets = [];
    const stream = new LiveStream(protocol, {
        retryFirstMs: 30,
        openSocket: () => {
            const socket = new FakeSocket();
            sockets.push(socket);
            return Promise.resolve(socket);
        },
    });
    const ticks = [];
    stream.connect('ticks', (_stream, batch) => ticks.push(...batch));
    return {stream, sockets, ticks};
}

test('stream: authenticates, then subscribes; prices come; another list changes the subscription', async () => {
    const {stream, sockets, ticks} = liveStream(alpacaProtocol({key: 'PK1', secret: 's'}));
    stream.setSymbols(['AAPL', 'MSFT']);
    ok(await waitFor(() => sockets[0]?.sent.length === 1), 'connected');
    eq(sockets[0].sent, [{action: 'auth', key: 'PK1', secret: 's'}], 'nothing else before the answer');
    eq(stream.isLive('AAPL'), false);
    sockets[0].receive([{T: 'success', msg: 'authenticated'}]);
    eq(sockets[0].sent[1], {action: 'subscribe', trades: ['AAPL', 'MSFT']});
    eq([stream.state, stream.isLive('AAPL')], ['live', true]);
    sockets[0].receive([{T: 't', S: 'AAPL', p: 101, t: '2026-11-20T15:00:00Z'}]);
    eq(ticks.map(t => t.price), [101]);
    stream.setSymbols(['MSFT', 'NVDA']);
    eq(sockets[0].sent.slice(2), [{action: 'unsubscribe', trades: ['AAPL']}, {action: 'subscribe', trades: ['NVDA']}]);
    stream.setSymbols([]);
    eq([stream.state, sockets[0].state], ['off', Soup.WebsocketState.CLOSED], 'no symbols: closed');
    stream.destroy();
});

test('stream: a drop opens it again after a wait; wrong keys stop it', async () => {
    const {stream, sockets} = liveStream(alpacaProtocol({key: 'PK1', secret: 's'}));
    stream.setSymbols(['AAPL']);
    ok(await waitFor(() => sockets[0]?.sent.length === 1), 'connected');
    sockets[0].receive([{T: 'success', msg: 'authenticated'}]);
    sockets[0].drop();
    eq([stream.state, stream.isLive('AAPL')], ['retrying', false]);
    ok(await waitFor(() => sockets[1]?.sent.length === 1), 'opened again');
    sockets[1].receive([{T: 'error', code: 402, msg: 'auth failed'}]);
    eq([stream.state, stream.error, sockets[1].state], ['failed', 'Alpaca: auth failed', Soup.WebsocketState.CLOSED]);
    await sleep(150);
    eq(sockets.length, 2, 'not tried again with the same keys');
    stream.setSymbols(['AAPL', 'MSFT']);
    eq(sockets.length, 2);
    stream.destroy();
});

test('stream: Coinbase needs no answer before it subscribes', async () => {
    const {stream, sockets, ticks} = liveStream(coinbaseProtocol());
    stream.setSymbols(['BTC-USD']);
    ok(await waitFor(() => sockets[0]?.sent.length === 2), 'connected');
    eq(sockets[0].sent, [{type: 'subscribe', channel: 'heartbeats'},
        {type: 'subscribe', product_ids: ['BTC-USD'], channel: 'ticker'}]);
    sockets[0].receive({channel: 'ticker', timestamp: '2026-11-23T20:30:25Z',
        events: [{type: 'update', tickers: [{product_id: 'BTC-USD', price: '61000.5'}]}]});
    eq(ticks.map(t => [t.symbol, t.price]), [['BTC-USD', 61000.5]]);
    stream.destroy();
});

function liveService({alpaca = {key: 'PK1', secret: 's'}, now = OPEN + 3600000} = {}) {
    const clock = typeof now === 'function' ? now : () => now;
    const made = service(url => {
        if (url.includes('BTC-USD'))
            return {status: 200, text: yahooCrypto()};
        if (url.includes('AAPL'))
            return {status: 200, text: yahooStock()};
        return {status: 200, text: yahooDay()};
    }, null, clock, {alpaca});
    made.settings.set_strv('widgets-markets-symbols', ['AAPL', 'BTC-USD', '^GSPTSE']);
    return made;
}

test('service: US stocks stream from Alpaca and crypto from Coinbase while open; prices reach the rows', async () => {
    const {service: s, streams} = liveService();
    const live = [];
    s.connect('live', (_s, symbols) => live.push(...symbols));
    s.start();
    ok(await waitFor(() => !s.refreshing && streams.length === 2), 'both streams');
    const [coinbase, alpaca] = [streams.find(t => t.name === 'Coinbase'), streams.find(t => t.name === 'Alpaca')];
    eq([alpaca.symbols, coinbase.symbols], [['AAPL'], ['BTC-USD']]);
    alpaca.emit('ticks', [{symbol: 'AAPL', price: 105, timeMs: OPEN + 3600000}]);
    coinbase.emit('ticks', [{symbol: 'BTC-USD', price: 62000, timeMs: OPEN + 3600000}]);
    ok(await waitFor(() => live.length === 2), 'one live signal for both, within a second');
    const row = symbol => s.rows.find(r => r.symbol === symbol).reading;
    eq([row('AAPL').price, row('AAPL').live, row('BTC-USD').price, row('BTC-USD').live],
        [105, 'alpaca', 62000, 'coinbase']);
    eq(row('^GSPTSE').live, undefined, 'an index stays Yahoo\'s');
    s.stop();
    eq(streams.every(t => t.destroyed), true);
});

test('service: Yahoo again keeps a newer live price; a streamed symbol is fetched every 5 minutes, else every minute', async () => {
    let now = OPEN + 3600000;
    const {service: s, streams, urls} = liveService({now: () => now});
    s.start();
    ok(await waitFor(() => !s.refreshing && streams.length === 2), 'streams');
    const alpaca = streams.find(t => t.name === 'Alpaca');
    alpaca.goLive();
    alpaca.emit('ticks', [{symbol: 'AAPL', price: 105, timeMs: now}]);
    const fetches = symbol => urls.filter(u => u.includes(symbol)).length;
    now += 61000;
    await s.refresh();
    eq([fetches('AAPL'), fetches('%5EGSPTSE')], [1, 2], 'only the one without a stream');
    eq(s.rows.find(r => r.symbol === 'AAPL').reading.price, 105);
    now += 300000;
    await s.refresh();
    eq(fetches('AAPL'), 2, 'the graph, after 5 minutes');
    eq(s.rows.find(r => r.symbol === 'AAPL').reading.price, 105, 'Yahoo\'s older price does not replace it');
    s.stop();
});

test('service: no Alpaca keys, or a closed market, or live prices off: no Alpaca stream', async () => {
    const noKeys = liveService({alpaca: null});
    noKeys.service.start();
    ok(await waitFor(() => !noKeys.service.refreshing && noKeys.streams.length === 1), 'refreshed');
    eq(noKeys.streams.map(t => t.name), ['Coinbase']);
    noKeys.service.stop();

    const closed = liveService({now: CLOSE + 3600000});
    closed.service.start();
    ok(await waitFor(() => !closed.service.refreshing && closed.streams.length === 1), 'refreshed');
    eq(closed.streams.map(t => t.name), ['Coinbase'], 'crypto still streams');
    closed.service.stop();

    const off = liveService();
    off.settings.set_boolean('markets-live', false);
    off.service.start();
    ok(await waitFor(() => !off.service.refreshing && off.service.rows.length === 3), 'refreshed');
    await sleep(50);
    eq(off.streams.length, 0);
    off.service.stop();
});

test('service: Yahoo fails for a stock without a reading: the live price alone shows; a failed stream says why', async () => {
    const {service: s, streams, settings} = service(() => new Error('offline'), null, () => OPEN + 3600000,
        {alpaca: {key: 'PK1', secret: 's'}});
    settings.set_strv('widgets-markets-symbols', ['AAPL']);
    s.start();
    ok(await waitFor(() => !s.refreshing && streams.length === 1), 'streamed by its shape');
    streams[0].emit('ticks', [{symbol: 'AAPL', price: 105, timeMs: OPEN + 3600000}]);
    ok(await waitFor(() => s.rows[0].reading?.price === 105), 'shown');
    eq([s.rows[0].reading.source, s.rows[0].reading.changePercent], ['alpaca', null]);
    streams[0].state = 'failed';
    streams[0].error = 'Alpaca: auth failed';
    streams[0].emit('state');
    eq(s.liveProblem, 'Alpaca: auth failed');
    s.stop();
});

await done();
