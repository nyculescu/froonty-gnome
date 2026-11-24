// SPDX-License-Identifier: GPL-3.0-or-later
// The live price streams' messages, as pure functions: what Froonty sends
// to Alpaca's and Coinbase's WebSockets and what it reads back (live.js
// carries them). Alpaca's free plan streams the trades on IEX, one US
// exchange, for up to 30 symbols, with a free account's keys. Coinbase's
// market data needs no key.
//
// A protocol: {name, url, hello: messages sent once connected,
// authenticates: whether to wait for an 'authenticated' event before
// subscribing, subscribe(symbols) and unsubscribe(symbols): messages,
// parse(text) → {ticks: [{symbol, price, timeMs}], events}}. An event is
// {type: 'authenticated'} or {type: 'error', code, message, close, fatal}:
// `close` ends the connection (to be opened again), `fatal` also stops
// further tries with the same keys.

export const ALPACA_URL = 'wss://stream.data.alpaca.markets/v2/iex';
export const COINBASE_URL = 'wss://advanced-trade-ws.coinbase.com';

export const ALPACA_MAX_SYMBOLS = 30;

// Alpaca's codes that end the connection: not authenticated, auth failed,
// auth timeout, connection limit (another client with the same keys),
// insufficient subscription.
const ALPACA_CLOSE = new Set([401, 402, 404, 406, 409]);
// Auth failed (wrong keys), insufficient subscription: the same keys will
// fail again.
const ALPACA_FATAL = new Set([402, 409]);

export function alpacaProtocol({key, secret}) {
    return {
        name: 'Alpaca',
        url: ALPACA_URL,
        hello: [JSON.stringify({action: 'auth', key, secret})],
        authenticates: true,
        subscribe: symbols => [JSON.stringify({action: 'subscribe', trades: symbols})],
        unsubscribe: symbols => [JSON.stringify({action: 'unsubscribe', trades: symbols})],
        parse: parseAlpaca,
    };
}

/** Alpaca sends arrays of messages: trades (T 't'), success and error. */
export function parseAlpaca(text) {
    const ticks = [];
    const events = [];
    const messages = JSON.parse(text);
    for (const m of Array.isArray(messages) ? messages : [messages]) {
        if (m?.T === 't') {
            const price = Number.parseFloat(m.p);
            const timeMs = Date.parse(m.t);
            if (typeof m.S === 'string' && Number.isFinite(price) && Number.isFinite(timeMs))
                ticks.push({symbol: m.S, price, timeMs});
        } else if (m?.T === 'success' && m.msg === 'authenticated') {
            events.push({type: 'authenticated'});
        } else if (m?.T === 'error') {
            events.push({
                type: 'error',
                code: m.code,
                message: m.msg ?? '',
                close: ALPACA_CLOSE.has(m.code),
                fatal: ALPACA_FATAL.has(m.code),
            });
        }
    }
    return {ticks, events};
}

export function coinbaseProtocol() {
    return {
        name: 'Coinbase',
        url: COINBASE_URL,
        // Coinbase closes a connection that subscribes to nothing within
        // seconds, and a quiet one; heartbeats come every second.
        hello: [JSON.stringify({type: 'subscribe', channel: 'heartbeats'})],
        authenticates: false,
        subscribe: ids => [JSON.stringify({type: 'subscribe', product_ids: ids, channel: 'ticker'})],
        unsubscribe: ids => [JSON.stringify({type: 'unsubscribe', product_ids: ids, channel: 'ticker'})],
        parse: parseCoinbase,
    };
}

/**
 * Coinbase's ticker channel: a snapshot, then an update per trade, the
 * price as a string. An unknown product is left out without an error.
 */
export function parseCoinbase(text) {
    const m = JSON.parse(text);
    const ticks = [];
    const events = [];
    if (m?.type === 'error')
        events.push({type: 'error', message: m.message ?? '', close: false, fatal: false});
    if (m?.channel === 'ticker') {
        const timeMs = Date.parse(m.timestamp);
        for (const event of m.events ?? []) {
            for (const t of event.tickers ?? []) {
                const price = Number.parseFloat(t.price);
                if (typeof t.product_id === 'string' && Number.isFinite(price) && Number.isFinite(timeMs))
                    ticks.push({symbol: t.product_id, price, timeMs});
            }
        }
    }
    return {ticks, events};
}
