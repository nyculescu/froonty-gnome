// SPDX-License-Identifier: GPL-3.0-or-later
// Low power, for the Claude tab's refresh setting (docs/features/claude.md): Power
// Saver mode, or the battery below 20% while it runs the laptop (user
// request). Read from UPower's display device and power-profiles-daemon on
// the system bus, the sources GNOME's own power menu uses. No St;
// lowPowerReason() is unit-tested with plain gjs.
//
// Emits 'changed' when the reason changes.

import Gio from 'gi://Gio';

import {Emitter} from '../../core/emitter.js';

Gio._promisify(Gio.DBusProxy, 'new_for_bus');

// Below this, on battery, counts as low power (user request: "under 20%").
export const LOW_BATTERY_PERCENT = 20;

// UPower: Type 2 is a battery; states 2 (discharging), 3 (empty) and 6
// (pending discharge) mean it runs the laptop. Charging or plugged in, a
// low battery is not low power.
const UPOWER_BATTERY = 2;
const ON_BATTERY = new Set([2, 3, 6]);

/**
 * @param {object} state
 * @param {?string} state.profile power-profiles-daemon's ActiveProfile
 * @param {?object} state.battery UPower's display device:
 *   {present, type, state, percentage}
 * @returns {?string} 'power-saver', 'battery', or null when not low power
 */
export function lowPowerReason({profile = null, battery = null} = {}) {
    if (profile === 'power-saver')
        return 'power-saver';
    if (battery?.present && battery.type === UPOWER_BATTERY && ON_BATTERY.has(battery.state) &&
        typeof battery.percentage === 'number' && battery.percentage < LOW_BATTERY_PERCENT)
        return 'battery';
    return null;
}

// power-profiles-daemon 0.20+ took UPower's name; older ones only have
// the original one.
const PROFILES = [
    ['org.freedesktop.UPower.PowerProfiles', '/org/freedesktop/UPower/PowerProfiles'],
    ['net.hadess.PowerProfiles', '/net/hadess/PowerProfiles'],
];

export class PowerMonitor extends Emitter {
    constructor() {
        super();
        /** 'power-saver', 'battery' or null; null until ready. */
        this.reason = null;
        /**
         * Whether `reason` comes from a readable state: false before start,
         * with neither service on the bus, or while one that was there is
         * gone (e.g. restarting); `reason` then keeps its last value.
         */
        this.known = false;
        this._proxies = [];
        this._battery = this._profiles = null;
        // The services on the bus at start; null until start() has them.
        this._expected = null;
        this._cancellable = null;
        this._ready = null;
    }

    /** Starts watching; resolves once the current state is known. */
    start() {
        if (this._ready)
            return this._ready;
        this._cancellable = new Gio.Cancellable();
        const cancellable = this._cancellable;
        this._ready = (async () => {
            const battery = await this._proxy('org.freedesktop.UPower',
                '/org/freedesktop/UPower/devices/DisplayDevice', 'org.freedesktop.UPower.Device',
                cancellable);
            let profiles = null;
            for (const [name, path] of PROFILES) {
                // eslint-disable-next-line no-await-in-loop
                profiles = await this._proxy(name, path, name, cancellable);
                if (profiles?.g_name_owner)
                    break;
            }
            if (cancellable.is_cancelled())
                return;
            this._battery = battery;
            this._profiles = profiles;
            // What was on the bus at start; one that comes later is welcome,
            // one that leaves makes the state unknown until it is back.
            this._expected = [battery, profiles].filter(p => p?.g_name_owner);
            this._sync();
        })();
        return this._ready;
    }

    stop() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._proxies.forEach(({proxy, id}) => proxy.disconnect(id));
        this._proxies = [];
        this._battery = this._profiles = null;
        this._expected = null;
        this._ready = null;
        this.reason = null;
        this.known = false;
    }

    // A proxy, or null without that service (e.g. a desktop without
    // power-profiles-daemon). Properties arrive with it and stay current.
    async _proxy(name, path, iface, cancellable) {
        try {
            const proxy = await Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM,
                Gio.DBusProxyFlags.DO_NOT_AUTO_START, null, name, path, iface, cancellable);
            if (cancellable.is_cancelled())
                return null;
            for (const signal of ['g-properties-changed', 'notify::g-name-owner'])
                this._proxies.push({proxy, id: proxy.connect(signal, () => this._sync())});
            return proxy;
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`Froonty: no ${name}: ${e.message}`);
            return null;
        }
    }

    _sync() {
        // A proxy can signal before start() has them all; start() syncs
        // once it does.
        if (!this._expected)
            return;
        const owned = proxy => Boolean(proxy?.g_name_owner);
        const known = this._expected.every(owned) &&
            (owned(this._battery) || owned(this._profiles));
        if (!known) {
            if (this.known) {
                this.known = false;
                this.emit('changed');
            }
            return;
        }
        const get = (proxy, property) => owned(proxy)
            ? proxy.get_cached_property(property)?.unpack() ?? null : null;
        const reason = lowPowerReason({
            profile: get(this._profiles, 'ActiveProfile'),
            battery: this._battery ? {
                present: get(this._battery, 'IsPresent'),
                type: get(this._battery, 'Type'),
                state: get(this._battery, 'State'),
                percentage: get(this._battery, 'Percentage'),
            } : null,
        });
        if (reason === this.reason && this.known)
            return;
        this.reason = reason;
        this.known = true;
        this.emit('changed');
    }
}
