// SPDX-License-Identifier: GPL-3.0-or-later
// Where the Markets widget's numbers come from, as pure functions: the
// request addresses and the readers of each answer. Yahoo's chart endpoint
// is unofficial and keyless. FRED's API is official and free with a key,
// but holds only US daily closes, so it stands in when Yahoo fails. (FRED's
// keyless CSV turns away clients that name themselves.)

// The span shown, and Yahoo's bar size for it.
export const RANGES = {
    '1d': {interval: '5m', days: 1},
    '5d': {interval: '30m', days: 5},
    '1mo': {interval: '1d', days: 31},
    '6mo': {interval: '1d', days: 183},
    '1y': {interval: '1d', days: 366},
};

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
 * A reading: {symbol, name, currency, price, previousClose, changePercent,
 * timeMs, points: [{t, v}] (t in ms), session: {startMs, endMs} | null,
 * source: 'yahoo' | 'fred'}.
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
    // For one day the chart's own previous close is yesterday's; for longer
    // spans it is the close before the span, so the change is against the
    // last close before the price's day.
    const previousClose = meta.range === '1d'
        ? meta.previousClose ?? meta.chartPreviousClose
        : meta.previousClose ?? closeBeforeDay(points, timeMs, (meta.gmtoffset ?? 0) * 1000);
    const regular = meta.currentTradingPeriod?.regular;
    return {
        symbol: meta.symbol,
        name: meta.shortName || meta.longName || meta.symbol,
        currency: meta.currency ?? '',
        price,
        previousClose: previousClose ?? null,
        changePercent: changePercent(price, previousClose),
        timeMs,
        points,
        session: regular ? {startMs: regular.start * 1000, endMs: regular.end * 1000} : null,
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
 * @returns {object} the reading; throws with FRED's own message if none
 */
export function parseFredObservations(symbol, text) {
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
    const previousClose = points.at(-2)?.v ?? null;
    return {
        symbol,
        name: FRED_NAMES[symbol] ?? symbol,
        currency: 'USD',
        price,
        previousClose,
        changePercent: changePercent(price, previousClose),
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
    return readings.some(r => r?.session && nowMs >= r.session.startMs && nowMs < r.session.endMs);
}

function changePercent(price, previousClose) {
    if (!Number.isFinite(previousClose) || previousClose === 0)
        return null;
    return (price - previousClose) / previousClose * 100;
}

// The last close on a day before the day of timeMs, days taken in the
// exchange's time zone (offsetMs from UTC).
function closeBeforeDay(points, timeMs, offsetMs) {
    const day = t => Math.floor((t + offsetMs) / 86400000);
    const today = day(timeMs);
    for (let i = points.length - 1; i >= 0; i--) {
        if (day(points[i].t) < today)
            return points[i].v;
    }
    return null;
}
