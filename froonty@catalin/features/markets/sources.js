// SPDX-License-Identifier: GPL-3.0-or-later
// Where the Markets numbers come from, as pure functions: the request
// addresses, the readers of each answer, which live stream a symbol takes
// and how a live price changes a reading. Yahoo's chart endpoint is
// unofficial and keyless, and gives every symbol its graph. FRED's API is
// official and free with a key, but holds only US daily closes, so it
// stands in when Yahoo fails. (FRED's keyless CSV turns away clients that
// name themselves.) The live prices (streams.js) go on top of either.

const MINUTE_MS = 60000;

// The span shown, Yahoo's bar size for it, and that size in ms (a live
// price within the last bar moves it, a later one adds a point).
export const RANGES = {
    '1d': {interval: '5m', days: 1, barMs: 5 * MINUTE_MS},
    '5d': {interval: '30m', days: 5, barMs: 30 * MINUTE_MS},
    '1mo': {interval: '1d', days: 31, barMs: 1440 * MINUTE_MS},
    '6mo': {interval: '1d', days: 183, barMs: 1440 * MINUTE_MS},
    '1y': {interval: '1d', days: 366, barMs: 1440 * MINUTE_MS},
};

// The most symbols the card shows, as many as Alpaca's free plan streams;
// each is one Yahoo request when it is due.
export const MAX_SYMBOLS = 30;

/**
 * The symbols the card shows, from the setting: trimmed, no empty or
 * repeated ones (Yahoo ignores case), the first MAX_SYMBOLS.
 *
 * @param {string[]} list
 * @returns {string[]}
 */
export function chosenSymbols(list) {
    const seen = new Set();
    const chosen = [];
    for (const symbol of list.map(s => s.trim())) {
        const key = symbol.toUpperCase();
        if (!symbol || seen.has(key))
            continue;
        seen.add(key);
        chosen.push(symbol);
        if (chosen.length === MAX_SYMBOLS)
            break;
    }
    return chosen;
}

// Yahoo symbols FRED also has, as its series names.
export const FRED_SERIES = {
    '^GSPC': 'SP500',
    '^IXIC': 'NASDAQCOM',
    '^DJI': 'DJIA',
};

const FRED_NAMES = {
    '^GSPC': 'S&P 500',
    '^IXIC': 'NASDAQ Composite',
    '^DJI': 'Dow Jones Industrial Average',
};

// Yahoo's own explanation (an unknown symbol, say), worth showing as is.
export class YahooError extends Error {}

export function yahooUrl(symbol, range) {
    const {interval} = RANGES[range] ?? RANGES['1d'];
    return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
        `?range=${range}&interval=${interval}`;
}

export function quotePageUrl(symbol) {
    return `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`;
}

/**
 * A reading: {symbol, name, currency, price, baseline, changePercent,
 * timeMs, points: [{t, v}] (t in ms), session: {startMs, endMs} | null,
 * source: 'yahoo' | 'fred'}. The change is measured from `baseline`:
 * yesterday's close for one day, else the close just before the span the
 * graph shows, so the number and the graph tell the same story.
 *
 * @param {string} text Yahoo's JSON answer
 * @returns {object} the reading; throws with Yahoo's own message if none
 */
export function parseYahooChart(text) {
    const chart = JSON.parse(text)?.chart;
    const result = chart?.result?.[0];
    if (chart?.error?.description)
        throw new YahooError(chart.error.description);
    if (!result)
        throw new Error('No data in Yahoo\'s answer');
    const meta = result.meta ?? {};
    const times = result.timestamp ?? [];
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const points = [];
    times.forEach((t, i) => {
        if (Number.isFinite(closes[i]))
            points.push({t: t * 1000, v: closes[i]});
    });
    const price = meta.regularMarketPrice ?? points.at(-1)?.v;
    if (!Number.isFinite(price))
        throw new Error('No price in Yahoo\'s answer');
    const timeMs = (meta.regularMarketTime ?? times.at(-1) ?? 0) * 1000;
    // Today's bar has no close until the session ends.
    if (!Number.isFinite(closes.at(-1)) && (!points.length || points.at(-1).t < timeMs))
        points.push({t: timeMs, v: price});
    const baseline = meta.range === '1d'
        ? meta.previousClose ?? meta.chartPreviousClose
        : meta.chartPreviousClose ?? points[0]?.v;
    // Crypto trades all week; Yahoo still gives it a day's session.
    const continuous = meta.instrumentType === 'CRYPTOCURRENCY';
    const regular = continuous ? null : meta.currentTradingPeriod?.regular;
    return {
        symbol: meta.symbol,
        name: meta.shortName || meta.longName || meta.symbol,
        currency: meta.currency ?? '',
        price,
        baseline: baseline ?? null,
        changePercent: changePercent(price, baseline),
        timeMs,
        points,
        session: regular ? {startMs: regular.start * 1000, endMs: regular.end * 1000} : null,
        continuous,
        // The exchange's offset from UTC, for its weekdays (expectedOpen).
        utcOffsetMs: (meta.gmtoffset ?? 0) * 1000,
        // EQUITY, ETF, MUTUALFUND, INDEX, FUTURE, CURRENCY, CRYPTOCURRENCY.
        instrumentType: meta.instrumentType ?? '',
        exchangeTimezone: meta.exchangeTimezoneName ?? '',
        source: 'yahoo',
    };
}

export function fredUrl(series, startDate, apiKey) {
    return 'https://api.stlouisfed.org/fred/series/observations' +
        `?series_id=${series}&observation_start=${startDate}&file_type=json&api_key=${encodeURIComponent(apiKey)}`;
}

/**
 * A reading from FRED's observations for one series (a day without a close
 * has the value '.').
 *
 * @param {string} symbol the Yahoo symbol it stands in for
 * @param {string} text FRED's JSON answer
 * @param {string} [range] one of RANGES: '1d' compares with the day before,
 *   longer ones with the first close (FRED is asked from the span's start)
 * @returns {object} the reading; throws with FRED's own message if none
 */
export function parseFredObservations(symbol, text, range = '1d') {
    const answer = JSON.parse(text);
    if (answer.error_message)
        throw new Error(`FRED: ${answer.error_message}`);
    const points = [];
    for (const {date, value} of answer.observations ?? []) {
        const v = Number.parseFloat(value);
        const t = Date.parse(`${date}T00:00:00Z`);
        if (Number.isFinite(v) && Number.isFinite(t))
            points.push({t, v});
    }
    if (!points.length)
        throw new Error('No closes in FRED\'s answer');
    const price = points.at(-1).v;
    const baseline = (range === '1d' ? points.at(-2)?.v : points[0].v) ?? null;
    return {
        symbol,
        name: FRED_NAMES[symbol] ?? symbol,
        currency: 'USD',
        price,
        baseline,
        changePercent: changePercent(price, baseline),
        timeMs: points.at(-1).t,
        points,
        session: null,
        source: 'fred',
    };
}

/** The FRED start date (YYYY-MM-DD) for a range, at least a week back. */
export function fredStartDate(range, nowMs) {
    const days = Math.max(7, (RANGES[range] ?? RANGES['1d']).days);
    return new Date(nowMs - days * 86400000).toISOString().slice(0, 10);
}

/** Whether any reading's regular session is under way. */
export function anyMarketOpen(readings, nowMs) {
    return readings.some(r => marketState(r, nowMs) === 'open');
}

/**
 * 'open' or 'closed' by the reading's regular session (Yahoo's
 * currentTradingPeriod), always 'open' for crypto, or null without a
 * session (FRED's daily closes).
 */
export function marketState(reading, nowMs) {
    if (reading?.continuous)
        return 'open';
    const session = reading?.session;
    if (!session)
        return null;
    return nowMs >= session.startMs && nowMs < session.endMs ? 'open' : 'closed';
}

const DAY_MS = 86400000;
// After a session ends or starts, for Yahoo to have the new state.
const SETTLE_MS = 5000;

/**
 * When a closed market should open next, as far as its reading tells: the
 * session's start if it is still ahead of the last check (`checkedMs`),
 * else the same time on the next weekday, in the exchange's time zone,
 * after both the session's end and the last check (on a holiday Yahoo
 * still gives the last session, so the day after is tried). Null without a
 * session (FRED). A daylight-saving change may make it an hour off; the
 * check then finds the session Yahoo gives.
 */
export function expectedOpen(reading, checkedMs = 0) {
    const session = reading?.session;
    if (!session)
        return null;
    if (checkedMs < session.startMs)
        return session.startMs;
    const after = Math.max(session.endMs, checkedMs);
    const weekend = t => [0, 6].includes(new Date(t + (reading.utcOffsetMs ?? 0)).getUTCDay());
    let start = session.startMs;
    while (start <= after || weekend(start))
        start += DAY_MS;
    return start;
}

/**
 * Whether a row's symbol is fetched on a timed refresh (owner's request
 * 2026-11-23: no refresh while its market is closed): while its market is
 * open, once `openS` passed since the last fetch (a tenth early, so the
 * rows one refresh fetched one after another stay together); once just
 * after it closes, for the closing price; when it should have opened
 * again (expectedOpen); and always without a reading, after an error, or
 * without a session (FRED).
 *
 * @param {{reading, error, checkedMs}} row checkedMs: when it was last fetched
 * @param {number} nowMs
 * @param {number} [openS] 0: every timed refresh while open
 */
export function isDue(row, nowMs, openS = 0) {
    const reading = row?.reading;
    if (!reading || row.error)
        return true;
    const state = marketState(reading, nowMs);
    if (state === 'open')
        return nowMs - (row.checkedMs ?? 0) >= openS * 900;
    if (state !== 'closed')
        return true;
    const checkedMs = row.checkedMs ?? 0;
    if (checkedMs < reading.session.endMs && nowMs >= reading.session.endMs)
        return true;
    return nowMs >= expectedOpen(reading, checkedMs);
}

/**
 * Seconds to the next timed refresh: `openS` after the last fetch while a
 * market is open (and just after its close; so a reschedule when a stream
 * comes or goes does not put it off), the expected opening of a closed one, `closedS`
 * for rows without a session or with an error; at least a minute. Null
 * without rows.
 *
 * @param {object[]} rows
 * @param {number} nowMs
 * @param {number|Function} openS seconds, or row → seconds (service.js
 *   polls a streamed symbol less often)
 * @param {number} closedS
 */
export function nextCheckDelay(rows, nowMs, openS, closedS) {
    const openFor = typeof openS === 'function' ? openS : () => openS;
    let next = Infinity;
    for (const row of rows) {
        const reading = row.reading;
        const state = row.error ? null : marketState(reading, nowMs);
        if (state === 'open')
            next = Math.min(next, (row.checkedMs ?? nowMs) + openFor(row) * 1000,
                (reading.session?.endMs ?? Infinity) + SETTLE_MS);
        else if (state === 'closed')
            next = Math.min(next, isDue(row, nowMs) ? nowMs : expectedOpen(reading, row.checkedMs ?? 0) + SETTLE_MS);
        else
            next = Math.min(next, nowMs + closedS * 1000);
    }
    return Number.isFinite(next) ? Math.max(60, Math.ceil((next - nowMs) / 1000)) : null;
}

// Yahoo's crypto pairs, also Coinbase's product IDs (BTC-USD, ETH-EUR).
const CRYPTO_RE = /^[A-Z0-9]{2,10}-(USD|USDC|USDT|EUR|GBP|BTC|ETH)$/;
// A US ticker, a share class after a hyphen as Yahoo writes it (BRK-B).
const US_TICKER_RE = /^[A-Z]{1,5}(-[A-Z])?$/;
// US mutual funds: five letters ending in X; one price a day, not on IEX.
const FUND_RE = /^[A-Z]{4}X$/;

/**
 * The live stream for a symbol: 'alpaca' for a stock or ETF listed in the
 * US, 'coinbase' for a crypto pair, null for the rest (Yahoo only). By
 * Yahoo's instrument type and exchange when its reading has them, else by
 * the symbol's shape.
 *
 * @param {string} symbol Yahoo's
 * @param {object|null} reading
 * @returns {'alpaca'|'coinbase'|null}
 */
export function streamRoute(symbol, reading) {
    const upper = symbol.toUpperCase();
    const type = reading?.source === 'yahoo' ? reading.instrumentType : '';
    if (type) {
        if (type === 'CRYPTOCURRENCY')
            return CRYPTO_RE.test(upper) ? 'coinbase' : null;
        const usListed = ['EQUITY', 'ETF'].includes(type) && reading.exchangeTimezone === 'America/New_York';
        return usListed && US_TICKER_RE.test(upper) ? 'alpaca' : null;
    }
    if (CRYPTO_RE.test(upper))
        return 'coinbase';
    return US_TICKER_RE.test(upper) && !FUND_RE.test(upper) ? 'alpaca' : null;
}

/** Alpaca's name for a Yahoo symbol: BRK-B is BRK.B there. */
export function alpacaSymbol(symbol) {
    return symbol.toUpperCase().replace('-', '.');
}

const NEW_YORK = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** Whether it is 9:30 to 16:00 on a weekday in New York (holidays unknown). */
export function usRegularSession(nowMs) {
    const parts = Object.fromEntries(NEW_YORK.formatToParts(new Date(nowMs)).map(p => [p.type, p.value]));
    if (['Sat', 'Sun'].includes(parts.weekday))
        return false;
    const minutes = Number(parts.hour) * 60 + Number(parts.minute);
    return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

/**
 * Whether a live price counts for a row now: crypto always; a US stock
 * only in its regular session, so the after-hours trades IEX also sends do
 * not pass for the close. The session is Yahoo's while its reading is
 * fresh (it knows holidays and early closes), else New York's hours.
 */
export function liveAllowed(row, route, nowMs) {
    if (route === 'coinbase')
        return true;
    const reading = row?.reading;
    if (reading?.source === 'yahoo' && reading.session && !row.stale && !row.error)
        return marketState(reading, nowMs) === 'open';
    return usRegularSession(nowMs);
}

/**
 * The reading with a live price: the price, its time and the change
 * from the same baseline; on the graph it moves the last point when in the
 * same bar, else adds one. A price older than the reading changes nothing.
 *
 * @param {object} reading
 * @param {{price: number, timeMs: number}} tick
 * @param {string} range one of RANGES
 * @param {'alpaca'|'coinbase'} source
 */
export function applyTick(reading, {price, timeMs}, range, source) {
    if (!Number.isFinite(price) || !Number.isFinite(timeMs) || timeMs < reading.timeMs)
        return reading;
    const {barMs} = RANGES[range] ?? RANGES['1d'];
    const points = reading.points.slice();
    const last = points.at(-1);
    if (last && Math.floor(last.t / barMs) === Math.floor(timeMs / barMs))
        points[points.length - 1] = {t: Math.max(last.t, timeMs), v: price};
    else
        points.push({t: timeMs, v: price});
    return {...reading, price, timeMs, changePercent: changePercent(price, reading.baseline), points, live: source};
}

/**
 * A reading from a live price alone, while neither Yahoo nor the cache has
 * one: the price without a change, its own name, no session.
 */
export function tickReading(symbol, {price, timeMs}, source) {
    return {
        symbol,
        name: symbol,
        currency: source === 'coinbase' ? symbol.split('-')[1] : 'USD',
        price,
        baseline: null,
        changePercent: null,
        timeMs,
        points: [{t: timeMs, v: price}],
        session: null,
        continuous: source === 'coinbase',
        utcOffsetMs: 0,
        instrumentType: '',
        exchangeTimezone: '',
        source,
        live: source,
    };
}

function changePercent(price, baseline) {
    if (!Number.isFinite(baseline) || baseline === 0)
        return null;
    return (price - baseline) / baseline * 100;
}
