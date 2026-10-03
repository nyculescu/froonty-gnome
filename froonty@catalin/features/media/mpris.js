// SPDX-License-Identifier: GPL-3.0-or-later
// MPRIS players on the session bus (docs/features/media.md), with
// Froonty's own asynchronous proxies. GNOME Shell's ui/mpris.js is not
// used: it has no teardown, hides missing data behind "Unknown title" and
// exposes no position or seeking (DESIGN.md §3).
//
//   MprisWatcher  NameOwnerChanged + ListNames: which players exist
//   MprisPlayer   one player: root and Player properties, Seeked, calls
//
// Each player is reached by its *unique* bus name (":1.42"), never its
// well-known name, so a command can never reach a later process that
// takes the name over. Proxies carry no interface info: wrong-typed
// properties of buggy players never raise GLib warnings; model.js checks
// every type instead. Everything is asynchronous and cancellable; stop()
// undoes everything. The bus is injectable (unit tests use a private
// dbus-daemon, never the real session bus).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Emitter} from '../../core/emitter.js';
import {decodeMetadata, decodePlayer, decodeRoot, glibTimers, isIgnored, PREFIX} from './model.js';

export const PATH = '/org/mpris/MediaPlayer2';
export const ROOT = 'org.mpris.MediaPlayer2';
export const PLAYER = 'org.mpris.MediaPlayer2.Player';
export const TRACKLIST = 'org.mpris.MediaPlayer2.TrackList';
export const MAX_PLAYERS = 16;
export const CALL_MS = 2000;
export const GET_MS = 1000;
const READY_MS = 1000;
const PROXY_FLAGS = Gio.DBusProxyFlags.DO_NOT_AUTO_START |
    Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES;

const isCancelled = e => e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ?? false;

/**
 * A D-Bus method call as a promise (callbacks, so no prototype is patched).
 *
 * @returns {Promise<GLib.Variant>} the reply
 */
export function busCall(bus, {name, path, iface, method, params = null, replyType = null,
    timeout = CALL_MS, cancellable = null}) {
    return new Promise((resolve, reject) => {
        bus.call(name, path, iface, method, params,
            replyType ? new GLib.VariantType(replyType) : null,
            Gio.DBusCallFlags.NO_AUTO_START, timeout, cancellable, (connection, result) => {
                try {
                    resolve(connection.call_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

/** A proxy without interface info, on a unique name. */
export function newProxy(bus, owner, iface, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.DBusProxy.new(bus, PROXY_FLAGS, null, owner, PATH, iface, cancellable, (_object, result) => {
            try {
                resolve(Gio.DBusProxy.new_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

const busDaemon = (bus, method, params, replyType, timeout, cancellable) => busCall(bus, {
    name: 'org.freedesktop.DBus',
    path: '/org/freedesktop/DBus',
    iface: 'org.freedesktop.DBus',
    method,
    params,
    replyType,
    timeout,
    cancellable,
});

/** One player: one well-known name of one owner. */
export class MprisPlayer {
    constructor(bus, name, owner, now = () => GLib.get_monotonic_time()) {
        this._bus = bus;
        this._now = now;
        /** Well-known name ("org.mpris.MediaPlayer2.vlc"). */
        this.name = name;
        /** Unique name (":1.42"): where every call goes. */
        this.owner = owner;
        /** Process id, or null when the bus would not tell. */
        this.pid = null;
        this.root = decodeRoot(() => null);
        this.props = decodePlayer(() => null);
        this.track = null;
        /** Monotonic µs when it last started playing; null while not playing. */
        this.playingSinceUs = null;
        this.cancellable = new Gio.Cancellable();
        this.destroyed = false;
        this._proxies = [];
    }

    /**
     * Reads the process id and both interfaces' properties, then follows
     * them. Resolves false when the player cannot be read.
     *
     * @param {object} handlers {changed: (player), seeked: (player, us)}
     */
    async init({changed, seeked}) {
        const cancellable = this.cancellable;
        const pid = busDaemon(this._bus, 'GetConnectionUnixProcessID',
            new GLib.Variant('(s)', [this.owner]), '(u)', GET_MS, cancellable)
            .then(reply => reply.get_child_value(0).get_uint32())
            .catch(() => null);
        const [processId, root, player] = await Promise.all([
            pid,
            newProxy(this._bus, this.owner, ROOT, cancellable),
            newProxy(this._bus, this.owner, PLAYER, cancellable),
        ]);
        if (this.destroyed)
            return false;
        this.pid = Number.isInteger(processId) && processId > 0 ? processId : null;
        this._root = root;
        this._player = player;
        this._decodeRoot();
        this._decodePlayer();
        this._connect(root, 'g-properties-changed', () => {
            this._decodeRoot();
            changed(this);
        });
        this._connect(player, 'g-properties-changed', () => {
            this._decodePlayer();
            changed(this);
        });
        this._connect(player, 'g-signal', (_proxy, _sender, signal, params) => {
            if (signal !== 'Seeked' || params?.get_type_string() !== '(x)')
                return;
            seeked(this, Number(params.get_child_value(0).get_int64()));
            changed(this);
        });
        return true;
    }

    _connect(proxy, signal, handler) {
        this._proxies.push([proxy, proxy.connect(signal, handler)]);
    }

    _decodeRoot() {
        this.root = decodeRoot(name => this._root.get_cached_property(name));
    }

    _decodePlayer() {
        const props = decodePlayer(name => this._player.get_cached_property(name));
        if (!props.playing)
            this.playingSinceUs = null;
        else if (!this.props.playing || this.playingSinceUs === null)
            this.playingSinceUs = this._now();
        this.props = props;
        this.track = decodeMetadata(this._player.get_cached_property('Metadata'));
    }

    /**
     * Calls a method of the player's owner (never auto-started), 2 s at most.
     *
     * @param {string} method
     * @param {?GLib.Variant} [params]
     * @param {string} [iface]
     */
    call(method, params = null, iface = PLAYER) {
        return busCall(this._bus, {
            name: this.owner,
            path: PATH,
            iface,
            method,
            params,
            timeout: CALL_MS,
            cancellable: this.cancellable,
        });
    }

    /**
     * Reads one property afresh (Position is never taken from a proxy's
     * cache: players do not announce its changes), 1 s at most.
     *
     * @returns {Promise<GLib.Variant>} the value
     */
    async get(iface, property) {
        const reply = await busCall(this._bus, {
            name: this.owner,
            path: PATH,
            iface: 'org.freedesktop.DBus.Properties',
            method: 'Get',
            params: new GLib.Variant('(ss)', [iface, property]),
            replyType: '(v)',
            timeout: GET_MS,
            cancellable: this.cancellable,
        });
        return reply.get_child_value(0).get_variant();
    }

    destroy() {
        if (this.destroyed)
            return;
        this.destroyed = true;
        this.cancellable.cancel();
        for (const [proxy, id] of this._proxies)
            proxy.disconnect(id);
        this._proxies = [];
        this._root = null;
        this._player = null;
    }
}

/**
 * Which players exist. Emits 'changed' (at most once per idle), 'seeked'
 * (player, µs) and 'ready' (initial discovery settled, or 1 s passed).
 */
export class MprisWatcher extends Emitter {
    /**
     * @param {object} [options]
     * @param {Gio.DBusConnection} [options.bus] the session bus by default
     * @param {object} [options.timers] model.glibTimers or a fake
     */
    constructor({bus = null, timers = glibTimers} = {}) {
        super();
        this._busOption = bus;
        this._timers = timers;
        this._players = new Map(); // well-known name → MprisPlayer
        this._pending = new Set(); // MprisPlayer being read
        this._started = false;
        this._ready = false;
        this._warnedFull = false;
        this._subscription = 0;
        this._idleId = 0;
        this._readyId = 0;
        this._cancellable = null;
        this.bus = null;
    }

    get ready() {
        return this._ready;
    }

    /** Fully read players, by well-known name. */
    get players() {
        return this._players;
    }

    start() {
        if (this._started)
            return;
        this._started = true;
        this.bus = this._busOption ?? Gio.DBus.session;
        this._cancellable = new Gio.Cancellable();
        // First, so no player is missed between the steps below.
        this._subscription = this.bus.signal_subscribe('org.freedesktop.DBus',
            'org.freedesktop.DBus', 'NameOwnerChanged', '/org/freedesktop/DBus',
            'org.mpris.MediaPlayer2', Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
            (_connection, _sender, _path, _iface, _signal, params) =>
                this._onNameOwnerChanged(params));
        this._readyId = this._timers.add(READY_MS, () => {
            this._readyId = 0;
            this._setReady();
        });
        this._discover(this._cancellable);
    }

    stop() {
        if (!this._started)
            return;
        this._started = false;
        this.bus.signal_unsubscribe(this._subscription);
        this._subscription = 0;
        this._cancellable.cancel();
        this._cancellable = null;
        if (this._idleId)
            this._timers.remove(this._idleId);
        this._idleId = 0;
        if (this._readyId)
            this._timers.remove(this._readyId);
        this._readyId = 0;
        for (const player of [...this._players.values(), ...this._pending])
            player.destroy();
        this._players.clear();
        this._pending.clear();
        this._ready = false;
    }

    async _discover(cancellable) {
        try {
            const reply = await busDaemon(this.bus, 'ListNames', null, '(as)', CALL_MS, cancellable);
            const names = reply.get_child_value(0).get_strv().filter(name => !isIgnored(name));
            await Promise.allSettled(names.map(async name => {
                const owner = await busDaemon(this.bus, 'GetNameOwner',
                    new GLib.Variant('(s)', [name]), '(s)', GET_MS, cancellable);
                if (!cancellable.is_cancelled())
                    await this._add(name, owner.get_child_value(0).get_string()[0]);
            }));
        } catch (e) {
            if (!isCancelled(e))
                console.debug(`Froonty: listing media players failed: ${e.message}`);
        }
        if (!cancellable.is_cancelled())
            this._setReady();
    }

    _setReady() {
        if (this._ready || !this._started)
            return;
        this._ready = true;
        if (this._readyId)
            this._timers.remove(this._readyId);
        this._readyId = 0;
        this.emit('ready');
        this._queueChanged();
    }

    _onNameOwnerChanged(params) {
        if (!this._started || params?.get_type_string() !== '(sss)')
            return;
        const [name, oldOwner, newOwner] = params.deepUnpack();
        if (isIgnored(name))
            return;
        if (oldOwner) {
            for (const player of [...this._pending]) {
                if (player.name === name && player.owner === oldOwner) {
                    this._pending.delete(player);
                    player.destroy();
                }
            }
            const player = this._players.get(name);
            if (player?.owner === oldOwner) {
                this._players.delete(name);
                player.destroy();
                this._queueChanged();
            }
        }
        if (newOwner)
            this._add(name, newOwner);
    }

    async _add(name, owner) {
        if (!this._started || isIgnored(name) || !name.startsWith(PREFIX) || !owner)
            return;
        // (name, owner) is unique: the ListNames race gives duplicates.
        if (this._players.get(name)?.owner === owner ||
            [...this._pending].some(p => p.name === name && p.owner === owner))
            return;
        if (this._players.size + this._pending.size >= MAX_PLAYERS) {
            if (!this._warnedFull)
                console.warn(`Froonty: more than ${MAX_PLAYERS} media players; ignoring the rest`);
            this._warnedFull = true;
            return;
        }
        const player = new MprisPlayer(this.bus, name, owner, this._timers.now);
        this._pending.add(player);
        let ok = false;
        try {
            ok = await player.init({
                changed: () => this._queueChanged(),
                seeked: (p, us) => this.emit('seeked', p, us),
            });
        } catch (e) {
            if (!isCancelled(e))
                console.debug(`Froonty: media player ${name} could not be read: ${e.message}`);
        }
        // Gone meanwhile (owner left, or stop()).
        if (!this._pending.delete(player) || !ok || !this._started) {
            player.destroy();
            return;
        }
        this._players.get(name)?.destroy();
        this._players.set(name, player);
        this._queueChanged();
    }

    // One 'changed' per burst: some players emit many PropertiesChanged.
    _queueChanged() {
        if (this._idleId || !this._started)
            return;
        this._idleId = this._timers.idle(() => {
            this._idleId = 0;
            this.emit('changed');
        });
    }
}
