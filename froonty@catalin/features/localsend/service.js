// SPDX-License-Identifier: GPL-3.0-or-later
// The LocalSend tab's state (docs/features/localsend.md), made from the
// helper's events. One per Shell (shared.js): it runs while the tab is
// enabled and "Visible" is on, whether the tab was opened or not, so the
// iPhone can send at any time. GNOME's parts (notifications, settings)
// are passed in, so it also runs in plain gjs unit tests.

import GLib from 'gi://GLib';

import {Emitter} from '../../core/emitter.js';

// After the helper stops by itself: try again this much later, at most
// RESTARTS times in a row (a fatal event, e.g. the port is taken, ends it).
const RESTART_DELAY_S = 5;
const RESTARTS = 3;
const RECENT = 8;
const WARNINGS = 3;

export const DEFAULT_PORT = 53317;

/** Where received files go when localsend-folder is empty. */
export function defaultFolder(downloads = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD)) {
    return GLib.build_filenamev([downloads || GLib.build_filenamev([GLib.get_home_dir(), 'Downloads']),
        'LocalSend']);
}

/** The trusted devices, {fingerprint: name}. */
export function trustedDevices(settings) {
    return settings.get_value('localsend-trusted').deepUnpack();
}

/** The trusted networks, {NetworkManager connection UUID: name}. */
export function trustedNetworks(settings) {
    return settings.get_value('localsend-trusted-networks').deepUnpack();
}

// Settings the helper takes while it runs ({cmd: 'update'}); a change
// to any of them is sent, never a restart (shared.js).
export const LIVE_KEYS = ['localsend-folder', 'localsend-devices', 'localsend-trusted',
    'localsend-trusted-networks', 'localsend-only-trusted-networks', 'localsend-pin-first'];

/** The part of the helper's configuration that can change while it runs. */
export function liveConfig(settings, {downloads} = {}) {
    return {
        folder: settings.get_string('localsend-folder').trim() || defaultFolder(downloads),
        manual: settings.get_strv('localsend-devices'),
        trusted: Object.keys(trustedDevices(settings)),
        trustedNetworks: Object.keys(trustedNetworks(settings)),
        onlyTrusted: settings.get_boolean('localsend-only-trusted-networks'),
        pinFirst: settings.get_boolean('localsend-pin-first'),
    };
}

/** The helper's configuration from the settings and GLib's folders. */
export function helperConfig(settings, {hostName = GLib.get_host_name(), downloads} = {}) {
    const alias = settings.get_string('localsend-alias').trim() || `Froonty (${hostName})`;
    return {
        alias: alias.slice(0, 64),
        port: settings.get_int('localsend-port') || DEFAULT_PORT,
        zerotier: settings.get_boolean('localsend-zerotier'),
        ...liveConfig(settings, {downloads}),
    };
}

const setDict = (settings, key, dict) => settings.set_value(key, new GLib.Variant('a{ss}', dict));

/**
 * What the service keeps in the settings: trusted devices (by the PIN, or
 * the first transfer accepted by hand), trusted networks, devices added
 * by address, the folder.
 */
export function settingsStore(settings) {
    return {
        /** Whether accepting by hand makes a device trusted (auto-accept is on). */
        trusts: () => settings.get_boolean('localsend-auto-accept'),
        /** A trusted device, over ZeroTier or a trusted network: no question. */
        autoAccepts: (fingerprint, trustedNetwork) => Boolean(fingerprint) && trustedNetwork &&
            settings.get_boolean('localsend-auto-accept') && fingerprint in trustedDevices(settings),
        trust(fingerprint, name) {
            if (!fingerprint)
                return;
            const devices = trustedDevices(settings);
            if (devices[fingerprint] === name)
                return;
            devices[fingerprint] = name;
            setDict(settings, 'localsend-trusted', devices);
        },
        trustNetwork(uuid, name) {
            if (uuid)
                setDict(settings, 'localsend-trusted-networks', {...trustedNetworks(settings), [uuid]: name});
        },
        untrustNetwork(uuid) {
            const networks = trustedNetworks(settings);
            delete networks[uuid];
            setDict(settings, 'localsend-trusted-networks', networks);
        },
        addDevice(address) {
            const devices = settings.get_strv('localsend-devices');
            if (!devices.includes(address))
                settings.set_strv('localsend-devices', [...devices, address]);
        },
        forgetDevice(address) {
            settings.set_strv('localsend-devices',
                settings.get_strv('localsend-devices').filter(a => a !== address));
        },
        devices: () => settings.get_strv('localsend-devices'),
        setFolder: path => settings.set_string('localsend-folder', path),
    };
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export const isIpv4 = text => IPV4.test(text);

/** "1.4 MB" and the like (decimal units, as GNOME's Files shows). */
export function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0)
        return '';
    const units = ['B', 'kB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit++;
    }
    return unit === 0 ? `${bytes} B` : `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export class LocalSendService extends Emitter {
    /**
     * @param {object} o
     * @param {() => object} o.config the helper's configuration
     * @param {Function} o.start startHelper (run.js) or a fake
     * @param {?object} [o.notifier] notify.js's, or null
     * @param {?object} [o.store] settingsStore(), or null (nothing trusted
     *   or kept)
     * @param {Function} [o.later] (seconds, fn) => cancel function
     */
    constructor({config, start, notifier = null, store = null, later = defaultLater}) {
        super();
        this._config = config;
        this._store = store;
        this._start = start;
        this._notifier = notifier;
        this._later = later;
        this._helper = null;
        this._restarts = 0;
        this._cancelRestart = null;
        this.state = freshState();
    }

    get running() {
        return Boolean(this._helper);
    }

    start() {
        if (this._helper)
            return;
        this._cancelRestart?.();
        this._cancelRestart = null;
        const config = this._config();
        this.state = {...freshState(), status: 'starting', alias: config.alias, folder: config.folder,
            port: config.port, zerotier: config.zerotier, recent: this.state.recent};
        let helper = null;
        helper = this._start(config, event => {
            if (this._helper === helper)
                this._onEvent(event);
        }, status => {
            if (this._helper === helper)
                this._onExit(status);
        });
        this._helper = helper;
        this.emit('changed');
    }

    /** Stops the helper; `status` is what the tab shows meanwhile. */
    stop(status = 'off') {
        this._cancelRestart?.();
        this._cancelRestart = null;
        const helper = this._helper;
        this._helper = null;
        helper?.stop();
        this._dropQuestions();
        this.state = {...freshState(), status, recent: this.state.recent};
        this.emit('changed');
    }

    _dropQuestions() {
        for (const offer of this.state.offers)
            this._notifier?.offerGone(offer.id);
        for (const pin of this.state.pins)
            this._notifier?.pinGone(pin.ip);
    }

    /** Sends the settings that changed (liveConfig()) to the helper. */
    update(fields) {
        this._helper?.send({cmd: 'update', ...fields});
    }

    restart() {
        this.stop();
        this._restarts = 0;
        this.start();
    }

    destroy() {
        this.stop();
        this._notifier?.destroy?.();
    }

    accept(id) {
        this._decide(id, true);
    }

    decline(id) {
        this._decide(id, false);
    }

    scan() {
        this._helper?.send({cmd: 'scan'});
    }

    /** Adds a device by address (kept); false when it is not an IPv4 address. */
    addDevice(address) {
        address = String(address).trim();
        if (!isIpv4(address))
            return false;
        this._store?.addDevice(address);
        this._helper?.send({cmd: 'add', address});
        return true;
    }

    forgetDevice(address) {
        this._store?.forgetDevice(address);
    }

    trustNetwork(uuid, name) {
        this._store?.trustNetwork(uuid, name);
    }

    untrustNetwork(uuid) {
        this._store?.untrustNetwork(uuid);
    }

    setFolder(path) {
        this._store?.setFolder(path);
    }

    sendTo(fingerprint, paths) {
        if (!this._helper || !paths.length || this.state.sending)
            return;
        const peer = this.state.peers.find(p => p.fingerprint === fingerprint);
        this.state = {...this.state, sendResult: null,
            sending: {to: peer?.alias ?? '', sent: 0, total: 0, waiting: true}};
        this.emit('changed');
        this._helper.send({cmd: 'send', to: fingerprint, paths});
    }

    cancelSend() {
        this._helper?.send({cmd: 'cancel-send'});
    }

    dismissResult() {
        this.state = {...this.state, sendResult: null};
        this.emit('changed');
    }

    _decide(id, accepted) {
        const offer = this.state.offers.find(o => o.id === id);
        if (!offer)
            return;
        this._helper?.send({cmd: accepted ? 'accept' : 'decline', id});
        if (accepted && this._store?.trusts())
            this._store.trust(offer.fingerprint, offer.sender);
        this._notifier?.offerGone(id);
        this.state = {...this.state, offers: this.state.offers.filter(o => o.id !== id)};
        this.emit('changed');
    }

    _onEvent(event) {
        const s = this.state;
        switch (event.event) {
        case 'ready':
            this._restarts = 0;
            this.state = {...s, status: 'ready', error: null,
                alias: String(event.alias ?? s.alias), port: event.port ?? s.port,
                folder: String(event.folder ?? s.folder),
                fingerprint: String(event.fingerprint ?? ''),
                addresses: Array.isArray(event.addresses) ? event.addresses : []};
            break;
        case 'peers':
            this.state = {...s, peers: Array.isArray(event.peers) ? event.peers : []};
            break;
        case 'offer': {
            const offer = {
                id: String(event.id),
                sender: String(event.sender ?? ''),
                ip: String(event.ip ?? ''),
                fingerprint: String(event.fingerprint ?? ''),
                message: typeof event.message === 'string' ? event.message : null,
                files: Array.isArray(event.files) ? event.files : [],
            };
            // The PIN shown here was entered there: the user is at both
            // ends, so it is accepted, and the device trusted from now on.
            if (event.pinVerified) {
                this._store?.trust(offer.fingerprint, offer.sender);
                this._helper?.send({cmd: 'accept', id: offer.id});
                return;
            }
            // A trusted device over ZeroTier or a trusted network: no
            // question asked (files still notify when in, a message shows).
            if (this._store?.autoAccepts(offer.fingerprint, Boolean(event.trustedNetwork))) {
                this._helper?.send({cmd: 'accept', id: offer.id});
                return;
            }
            this.state = {...s, offers: [...s.offers, offer]};
            this._notifier?.offer(offer, {
                accept: () => this.accept(offer.id),
                decline: () => this.decline(offer.id),
            }, Boolean(offer.fingerprint && this._store?.trusts()));
            break;
        }
        case 'offer-gone': {
            // Timed out, or the sender gave up before (or as) it was
            // answered: nothing is coming.
            const id = String(event.id);
            const known = s.offers.some(o => o.id === id);
            this._notifier?.offerGone(id);
            if (event.reason === 'sender')
                this._notifier?.interrupted(String(event.sender ?? ''), 'sender', 0);
            if (!known && event.reason !== 'sender')
                return;
            this.state = {...s, offers: s.offers.filter(o => o.id !== id), receiving: null};
            break;
        }
        case 'pin': {
            const pin = {ip: String(event.ip ?? ''), sender: String(event.sender ?? ''),
                pin: String(event.pin ?? '')};
            this.state = {...s, pins: [...s.pins.filter(p => p.ip !== pin.ip), pin]};
            this._notifier?.pin(pin);
            break;
        }
        case 'pin-gone':
            this._notifier?.pinGone(String(event.ip ?? ''));
            this.state = {...s, pins: s.pins.filter(p => p.ip !== String(event.ip ?? ''))};
            break;
        case 'progress':
            this.state = {...s, receiving: {sender: String(event.sender ?? ''),
                received: Number(event.received) || 0, total: Number(event.total) || 0}};
            break;
        case 'received': {
            const item = {sender: String(event.sender ?? ''), paths: event.paths ?? [], time: Date.now()};
            this.state = {...s, receiving: null, recent: [item, ...s.recent].slice(0, RECENT)};
            this._notifier?.received(item, this.state.folder);
            break;
        }
        case 'cancelled': {
            const paths = event.paths ?? [];
            const recent = paths.length
                ? [{sender: String(event.sender ?? ''), paths, time: Date.now()}, ...s.recent].slice(0, RECENT)
                : s.recent;
            this.state = {...s, receiving: null, recent};
            this._notifier?.interrupted(String(event.sender ?? ''), String(event.reason ?? ''), paths.length);
            break;
        }
        case 'message':
            this._notifier?.message(String(event.sender ?? ''), String(event.text ?? ''));
            break;
        case 'send-progress':
            this.state = {...s, sending: {to: String(event.to ?? ''), sent: Number(event.sent) || 0,
                total: Number(event.total) || 0, waiting: Boolean(event.waiting)}};
            break;
        case 'send-done':
            this.state = {...s, sending: null,
                sendResult: {ok: true, to: String(event.to ?? s.sending?.to ?? ''), count: event.count ?? 0}};
            break;
        case 'send-failed':
            this.state = {...s, sending: null,
                sendResult: {ok: false, to: s.sending?.to ?? '', reason: String(event.reason ?? 'refused')}};
            break;
        case 'warning':
            this.state = {...s, warnings: [String(event.message ?? ''), ...s.warnings].slice(0, WARNINGS)};
            break;
        case 'fatal':
            this.state = {...s, status: 'failed',
                error: {reason: String(event.reason ?? 'other'), port: event.port ?? s.port,
                    message: String(event.message ?? '')}};
            this._restarts = RESTARTS; // no retry: it would fail the same way
            break;
        default:
            return;
        }
        this.emit('changed');
    }

    _onExit(status) {
        const failed = this.state.status === 'failed';
        this._helper = null;
        this._dropQuestions();
        this.state = {...this.state, offers: [], pins: [], receiving: null, sending: null, peers: [],
            status: 'failed',
            error: failed ? this.state.error : {reason: status === null ? 'no-python' : 'stopped',
                message: status === null ? '' : `exit status ${status}`}};
        if (!failed && status !== null && this._restarts < RESTARTS) {
            this._restarts++;
            this._cancelRestart = this._later(RESTART_DELAY_S, () => {
                this._cancelRestart = null;
                this.start();
            });
        }
        this.emit('changed');
    }
}

function freshState() {
    return {
        /** 'off' (tab off), 'hidden' (Visible off), 'starting', 'ready', 'failed' */
        status: 'off',
        error: null,
        alias: '',
        folder: '',
        port: DEFAULT_PORT,
        zerotier: false,
        fingerprint: '',
        addresses: [],
        peers: [],
        offers: [],
        /** PINs to enter on the devices asking: {ip, sender, pin} */
        pins: [],
        receiving: null,
        sending: null,
        sendResult: null,
        recent: [],
        warnings: [],
    };
}

function defaultLater(seconds, fn) {
    let id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
        id = 0;
        fn();
        return GLib.SOURCE_REMOVE;
    });
    return () => {
        if (id)
            GLib.source_remove(id);
        id = 0;
    };
}
