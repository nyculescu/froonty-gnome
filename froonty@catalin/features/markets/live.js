// SPDX-License-Identifier: GPL-3.0-or-later
// One live price stream: a WebSocket that speaks a streams.js protocol,
// open while it has symbols, subscribed to them as they change. After a
// drop it opens again, later each time (2 s, doubling up to 5 min, back
// to 2 s once prices arrive). An answer the same keys cannot cure (wrong
// keys) stops it until it is made again.
//
// Signals: 'ticks' (ticks: [{symbol, price, timeMs}]), 'state'.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {Emitter} from '../../core/emitter.js';

const RETRY_FIRST_MS = 2000;
const RETRY_MAX_MS = 5 * 60000;
// Soup pings this often and drops a connection that answers none in
// PONG_TIMEOUT_S, so a dead network is noticed without trades.
const KEEPALIVE_S = 20;
const PONG_TIMEOUT_S = 30;
const CONNECT_TIMEOUT_S = 15;

export class LiveStream extends Emitter {
    /**
     * @param {object} protocol streams.js alpacaProtocol() or coinbaseProtocol()
     * @param {object} [options]
     * @param {Function} [options.openSocket] (url, cancellable) → Promise of
     *   a Soup.WebsocketConnection or a fake with its send_text, close,
     *   state and 'message', 'closed', 'error' signals
     * @param {number} [options.retryFirstMs]
     */
    constructor(protocol, {openSocket, retryFirstMs = RETRY_FIRST_MS} = {}) {
        super();
        this._protocol = protocol;
        this._openSocket = openSocket ?? ((url, cancellable) => this._openDefault(url, cancellable));
        this._retryFirstMs = retryFirstMs;
        this._wanted = [];
        this._subscribed = new Set();
        this._socket = null;
        this._socketIds = [];
        this._ready = false;
        // off, connecting, live, retrying or failed.
        this._state = 'off';
        this._error = '';
        this._retryMs = 0;
        this._retryId = 0;
        this._cancellable = null;
        this._session = null;
    }

    get name() {
        return this._protocol.name;
    }

    get state() {
        return this._state;
    }

    /** Why it is retrying or failed, with the stream's name; else ''. */
    get error() {
        return this._error;
    }

    /** Whether prices for `symbol` come as they happen. */
    isLive(symbol) {
        return this._ready && this._subscribed.has(symbol);
    }

    /** The symbols to stream, in the protocol's names; none closes it. */
    setSymbols(symbols) {
        this._wanted = [...new Set(symbols)];
        if (this._state === 'failed')
            return;
        if (!this._wanted.length)
            this._close('off');
        else if (this._ready)
            this._resubscribe();
        else if (this._state === 'off')
            this._connect();
    }

    destroy() {
        this._wanted = [];
        this._close('off');
        this._session?.abort();
        this._session = null;
    }

    async _connect() {
        this._setState('connecting');
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        let socket;
        try {
            socket = await this._openSocket(this._protocol.url, cancellable);
        } catch (e) {
            if (!cancellable.is_cancelled())
                this._retry(e.message);
            return;
        }
        if (cancellable.is_cancelled()) {
            closeSocket(socket);
            return;
        }
        this._cancellable = null;
        this._socket = socket;
        this._socketIds = [
            socket.connect('message', (_socket, _type, bytes) => this._onMessage(bytes)),
            socket.connect('error', (_socket, error) => {
                this._error = `${this.name}: ${error.message}`;
            }),
            socket.connect('closed', () => this._retry(this._error || `${this.name}: connection closed`)),
        ];
        for (const text of this._protocol.hello)
            socket.send_text(text);
        if (!this._protocol.authenticates)
            this._onReady();
    }

    _onMessage(bytes) {
        let parsed;
        try {
            parsed = this._protocol.parse(new TextDecoder().decode(bytes.toArray()));
        } catch {
            return;
        }
        for (const event of parsed.events) {
            if (event.type === 'authenticated') {
                this._onReady();
            } else if (event.type === 'error') {
                this._error = `${this.name}: ${event.message}`;
                if (event.fatal) {
                    this._close('failed');
                    return;
                }
                if (event.close) {
                    this._retry(this._error);
                    return;
                }
                this.emit('state');
            }
        }
        if (parsed.ticks.length && this._ready) {
            this._retryMs = 0;
            this.emit('ticks', parsed.ticks);
        }
    }

    _onReady() {
        this._ready = true;
        this._subscribed = new Set();
        this._error = '';
        this._resubscribe();
        this._setState('live');
    }

    _resubscribe() {
        const wanted = new Set(this._wanted);
        const add = this._wanted.filter(s => !this._subscribed.has(s));
        const remove = [...this._subscribed].filter(s => !wanted.has(s));
        if (remove.length) {
            for (const text of this._protocol.unsubscribe(remove))
                this._socket.send_text(text);
        }
        if (add.length) {
            for (const text of this._protocol.subscribe(add))
                this._socket.send_text(text);
        }
        this._subscribed = wanted;
        if (add.length || remove.length)
            this.emit('state');
    }

    // Opened again after a wait, if it still has symbols then.
    _retry(message) {
        this._detach();
        this._error = message;
        this._retryMs = this._retryMs ? Math.min(this._retryMs * 2, RETRY_MAX_MS) : this._retryFirstMs;
        this._setState('retrying');
        this._retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._retryMs, () => {
            this._retryId = 0;
            if (this._wanted.length)
                this._connect();
            else
                this._setState('off');
            return GLib.SOURCE_REMOVE;
        });
    }

    _close(state) {
        this._detach();
        if (state === 'off')
            this._error = '';
        this._setState(state);
    }

    _detach() {
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._retryId) {
            GLib.source_remove(this._retryId);
            this._retryId = 0;
        }
        const socket = this._socket;
        this._socket = null;
        if (socket) {
            for (const id of this._socketIds)
                socket.disconnect(id);
            closeSocket(socket);
        }
        this._socketIds = [];
        this._ready = false;
        this._subscribed = new Set();
    }

    _setState(state) {
        if (state === this._state)
            return;
        this._state = state;
        this.emit('state');
    }

    _openDefault(url, cancellable) {
        this._session ??= new Soup.Session({user_agent: 'Froonty', timeout: CONNECT_TIMEOUT_S});
        const message = Soup.Message.new('GET', url);
        return new Promise((resolve, reject) => {
            this._session.websocket_connect_async(message, null, null, GLib.PRIORITY_DEFAULT, cancellable,
                (session, result) => {
                    try {
                        const socket = session.websocket_connect_finish(result);
                        socket.keepalive_interval = KEEPALIVE_S;
                        socket.keepalive_pong_timeout = PONG_TIMEOUT_S;
                        resolve(socket);
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }
}

// Soup complains when a closing connection is closed again.
function closeSocket(socket) {
    if (socket.state === Soup.WebsocketState.OPEN)
        socket.close(Soup.WebsocketCloseCode.NORMAL, null);
}
