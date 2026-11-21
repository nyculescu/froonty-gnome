// SPDX-License-Identifier: GPL-3.0-or-later
// Markets widget: Yahoo's and FRED's readers, and the service's fallbacks
// with a fake fetch (plain gjs, no network).

import {
    anyMarketOpen, fredStartDate, fredUrl, parseFredObservations, parseYahooChart, yahooUrl,
} from '../../froonty@catalin/features/widgets/markets/sources.js';
import {MarketsService} from '../../froonty@catalin/features/widgets/markets/service.js';
import {done, eq, makeSettings, ok, test, waitFor} from './test.js';

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
    eq([r.symbol, r.name, r.currency, r.price, r.previousClose], ['^GSPTSE', 'S&P/TSX Composite index', 'CAD', 33189.85, 34028.73]);
    eq(r.changePercent.toFixed(3), '-2.465');
    eq(r.points.map(p => p.v), [33820.98, 33189.85]);
    eq(r.points[0].t, 1795185000000);
    eq(r.session, {startMs: 1795185000000, endMs: 1795208400000});
    eq(r.source, 'yahoo');
});

test('Yahoo: a month of days ends at the live price, against the close the day before', () => {
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
    eq(r.previousClose, 100);
    eq(r.changePercent, 10);
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
    eq([r.name, r.price, r.previousClose, r.source], ['S&P 500', 7175.83, 7323.63, 'fred']);
    eq(r.timeMs, Date.parse('2026-11-19T00:00:00Z'));
    ok(r.changePercent < 0);
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

test('a market is open only inside its regular session', () => {
    const reading = {session: {startMs: 100, endMs: 200}};
    eq([anyMarketOpen([reading], 150), anyMarketOpen([reading], 200), anyMarketOpen([null], 150)], [true, false, false]);
});

function service(answers, key = 'test-key') {
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
    return {service: new MarketsService(settings, {fetch, lookupKey, cachePath: null}), urls, settings};
}

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
    await s.refresh();
    s.stop();
    eq(s.rows.map(r => [r.stale, Boolean(r.reading)]), [[true, true], [true, true], [true, true]]);
    ok(s.rows[1].error.includes('offline'));
});

test('service: a change of symbols refreshes with the new list', async () => {
    const {service: s, settings} = service(() => ({status: 200, text: yahooDay()}));
    s.start();
    ok(await waitFor(() => !s.refreshing && s.rows.length === 3), 'first refresh');
    settings.set_strv('widgets-markets-symbols', ['^GSPTSE']);
    ok(await waitFor(() => !s.refreshing && s.rows.length === 1), 'second refresh');
    s.stop();
});

await done();
