// SPDX-License-Identifier: GPL-3.0-or-later
// The laptop's own fans on an ASUS ROG / TUF laptop (docs/features/fan.md):
// their speeds from the `asus` hwmon device, and the platform profile and
// custom fan curves through asusd, asusctl's daemon (third_party/asusctl,
// 6.x: xyz.ljones.Asusd on the system bus). asusd lets the users, sudo,
// adm and wheel groups call it without a password (its data/asusd.conf).
//
// Kept cheap, as the tab polls every few seconds: a tick reads the fans'
// rpm files and platform_profile, nothing else, and asusd is not woken.
// What does not change while the tab is on screen (the hwmon device, the
// fan names, the profile choices, whether asusd is there) is read once per
// visit, the curves when the profile changes or after a change from here.
// A curve edited elsewhere (asusctl fan-curve) shows on the next visit.
//
// platform_profile, not asusd's change signal, says which profile is on:
// the signal misses a switch made elsewhere (GNOME's power menu, through
// power-profiles-daemon); asusd itself follows such a switch and applies
// that profile's curves. Only profiles platform_profile_choices also lists
// are offered: asusd 6.3.6 adds Low power where the firmware has none.
//
// Emits nothing: FanService refreshes it with its own ticks. No St.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.DBusConnection.prototype, 'call');

const NAME = 'xyz.ljones.Asusd';
const PATH = '/xyz/ljones';
const PLATFORM = 'xyz.ljones.Platform';
const FAN_CURVES = 'xyz.ljones.FanCurves';
const TIMEOUT_MS = 2000;

/** asusd's PlatformProfile numbers and the platform_profile names they write. */
export const PROFILES = {
    0: 'balanced',
    1: 'performance',
    2: 'quiet',
    3: 'low-power',
    4: 'custom',
};
const BY_NAME = Object.fromEntries(Object.entries(PROFILES).map(([n, name]) => [name, Number(n)]));
// Quietest first, as the buttons are laid out.
const ORDER = ['low-power', 'quiet', 'balanced', 'performance', 'custom'];

export const PATHS = {
    hwmon: '/sys/class/hwmon',
    profile: '/sys/firmware/acpi/platform_profile',
    choices: '/sys/firmware/acpi/platform_profile_choices',
    model: '/sys/class/dmi/id/product_name',
};

/** asusd's number for platform_profile's text ('performance\n' to 1), or null. */
export function profileNumber(text) {
    return BY_NAME[text?.trim()] ?? null;
}

/**
 * The profiles to offer, quietest first: asusd's choices that the firmware
 * also lists (`choicesText`, platform_profile_choices); all of asusd's when
 * that file cannot be read.
 * @param {number[]} choices asusd's PlatformProfileChoices
 * @param {?string} choicesText
 * @returns {number[]}
 */
export function offeredProfiles(choices, choicesText) {
    const firmware = choicesText === null ? null : new Set(choicesText.trim().split(/\s+/));
    return [...new Set(choices)]
        .filter(p => PROFILES[p] && (!firmware || firmware.has(PROFILES[p])))
        .sort((a, b) => ORDER.indexOf(PROFILES[a]) - ORDER.indexOf(PROFILES[b]));
}

/**
 * FanCurveData's answer, a(s(yyyyyyyy)(yyyyyyyy)b) unpacked: per fan its
 * eight points (°C, % of full speed from the 0-255 PWM) and whether it is on.
 * @returns {{fan: string, points: number[][], enabled: boolean}[]}
 */
export function parseCurves(curves) {
    return (curves ?? []).map(([fan, pwm, temp, enabled]) => ({
        fan: fan.toLowerCase(),
        points: temp.map((t, i) => [t, Math.round(pwm[i] / 255 * 100)]),
        enabled,
    }));
}

/** 'all', 'some' or 'none' of the curves are on (an empty list is 'none'). */
export function curvesState(curves) {
    const on = curves.filter(curve => curve.enabled).length;
    return on === 0 ? 'none' : on === curves.length ? 'all' : 'some';
}

/** "ROG Strix G634JZ" from DMI's "ROG Strix G634JZ_G634JZ". */
export function modelName(text) {
    return (text ?? '').trim().replace(/_.*$/, '') || null;
}

/**
 * The fans of an `asus` hwmon folder: {fan1_input: '2500', fan1_label:
 * 'cpu_fan', ...} to [{n: 1, id: 'cpu', rpm: 2500}], in fan number order. A
 * fan without a label is named by its number.
 */
export function parseFans(files) {
    const fans = [];
    for (const [name, value] of Object.entries(files)) {
        const match = /^fan(\d+)_input$/.exec(name);
        const rpm = Number.parseInt(value ?? '', 10);
        if (!match || Number.isNaN(rpm))
            continue;
        const label = files[`fan${match[1]}_label`]?.trim().replace(/_fan$/, '');
        fans.push({n: Number(match[1]), id: label || `fan${match[1]}`, rpm});
    }
    return fans.sort((a, b) => a.n - b.n);
}

// The D-Bus errors that mean asusd is not there or not a 6.x one.
const ABSENT = [Gio.DBusError.SERVICE_UNKNOWN, Gio.DBusError.NAME_HAS_NO_OWNER,
    Gio.DBusError.UNKNOWN_OBJECT, Gio.DBusError.UNKNOWN_INTERFACE, Gio.DBusError.UNKNOWN_METHOD];

// asusd's own message, without the D-Bus error name GIO puts before it.
function errorText(e) {
    if (e instanceof GLib.Error)
        Gio.DBusError.strip_remote_error(e);
    return e.message;
}

export class AsusFans {
    /**
     * @param {object} io sysmon/io.js's shape (read, list)
     * @param {object} [options] for tests: `bus` (a Gio.DBusConnection,
     *   the system bus by default)
     */
    constructor(io, {bus = null} = {}) {
        this._io = io;
        this._bus = bus;
        /** Where the hwmon devices, the profile and its choices and the model are (PATHS). */
        this.paths = {...PATHS};
        this._visited = false;
        this._hwmon = null;
        // The profile this.curves belong to; null to read them again.
        this._curvesFor = null;
        this._refreshing = false;

        /** The laptop's model name, or null. */
        this.model = null;
        /** [{n, id: 'cpu' | 'gpu' | 'mid' | 'fanN', rpm}], [] without an `asus` hwmon. */
        this.fans = [];
        /** Whether asusd answers (null before the first refresh). */
        this.daemon = null;
        /** The platform profile (PROFILES' numbers), or null. */
        this.profile = null;
        /** The profiles to offer, quietest first. */
        this.profiles = [];
        /** The active profile's curves (parseCurves), [] without fan curve support. */
        this.curves = [];
        /** Why the last change failed, or ''. */
        this.error = '';
        /** Why asusd could not be read (it is there but refused), or ''. */
        this.readError = '';
    }

    /** Whether there is anything to show: an `asus` hwmon device or asusd. */
    get present() {
        return this.fans.length > 0 || Boolean(this.daemon);
    }

    /** A new visit: the next refresh reads the once-per-visit things again. */
    reset() {
        this._visited = false;
    }

    /** Reads the fans' rpm and the profile (and on a new visit, the rest). */
    async refresh(cancellable = null) {
        if (this._refreshing)
            return;
        this._refreshing = true;
        try {
            if (!this._visited)
                this._visited = await this._startVisit(cancellable);
            await Promise.all([this._readFans(cancellable), this._readProfile(cancellable)]);
        } finally {
            this._refreshing = false;
        }
    }

    /** Switches the platform profile (asusd also applies its curves). */
    async setProfile(profile) {
        await this._change(() => this._call('org.freedesktop.DBus.Properties', 'Set',
            new GLib.Variant('(ssv)', [PLATFORM, 'PlatformProfile', new GLib.Variant('u', profile)])));
    }

    /** Turns every custom curve of the active profile on or off (off: the firmware's own). */
    async setCurvesEnabled(enabled) {
        if (this.profile === null)
            return;
        const profile = this.profile;
        await this._change(() => this._call(FAN_CURVES, 'SetFanCurvesEnabled',
            new GLib.Variant('(ub)', [profile, enabled])));
    }

    async _change(call) {
        try {
            await call();
            this.error = '';
        } catch (e) {
            this.error = errorText(e);
        }
        this._curvesFor = null;
        await this.refresh();
    }

    get _connection() {
        return this._bus ?? Gio.DBus.system;
    }

    async _call(iface, method, params, cancellable = null) {
        const reply = await this._connection.call(NAME, PATH, iface, method, params, null,
            Gio.DBusCallFlags.NO_AUTO_START, TIMEOUT_MS, cancellable);
        return reply.deepUnpack();
    }

    async _property(name, cancellable) {
        const [value] = await this._call('org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [PLATFORM, name]), cancellable);
        return value.deepUnpack();
    }

    // Once per visit: the fans and their names, the model, asusd and the
    // profiles it offers. False when cancelled (then again next time).
    async _startVisit(cancellable) {
        const [, model, choicesText] = await Promise.all([
            this._findFans(cancellable),
            this.model === null ? this._io.read(this.paths.model, cancellable) : null,
            this._io.read(this.paths.choices, cancellable),
        ]);
        if (model !== null)
            this.model = modelName(model);
        try {
            const choices = await this._property('PlatformProfileChoices', cancellable);
            this.daemon = true;
            this.readError = '';
            this.profiles = offeredProfiles(choices, choicesText);
        } catch (e) {
            if (cancelled(e))
                return false;
            this._lost(e);
        }
        this._curvesFor = null;
        return !cancellable?.is_cancelled();
    }

    // asusd failed to answer: gone (an older asusctl counts as gone) or refusing.
    _lost(e) {
        this.daemon = !ABSENT.some(code => e.matches?.(Gio.DBusError, code));
        this.readError = this.daemon ? errorText(e) : '';
        this.profile = null;
        this.profiles = [];
        this.curves = [];
    }

    // The profile from platform_profile (from asusd when that cannot be
    // read), and its curves when it is not the one they were read for.
    async _readProfile(cancellable) {
        if (!this.daemon)
            return;
        try {
            const text = await this._io.read(this.paths.profile, cancellable);
            this.profile = text === null
                ? await this._property('PlatformProfile', cancellable) : profileNumber(text);
            if (this.profile === null || this.profile === this._curvesFor)
                return;
            const profile = this.profile;
            let curves = [];
            try {
                [curves] = await this._call(FAN_CURVES, 'FanCurveData',
                    new GLib.Variant('(u)', [profile]), cancellable);
            } catch (e) {
                if (cancelled(e))
                    return;
                // No fan curve support on this laptop (asusd then has no FanCurves).
            }
            this.curves = parseCurves(curves);
            this._curvesFor = profile;
        } catch (e) {
            if (!cancelled(e))
                this._lost(e);
        }
    }

    // The `asus` hwmon folder (asus-nb-wmi's fans) and its fans' names.
    async _findFans(cancellable) {
        const root = this.paths.hwmon;
        const dirs = await this._io.list(root, cancellable);
        const names = await Promise.all(dirs.map(dir => this._io.read(`${root}/${dir}/name`, cancellable)));
        const i = names.findIndex(name => name?.trim() === 'asus');
        this._hwmon = i < 0 ? null : `${root}/${dirs[i]}`;
        if (!this._hwmon) {
            this.fans = [];
            return;
        }
        const files = (await this._io.list(this._hwmon, cancellable))
            .filter(name => /^fan\d+_(input|label)$/.test(name));
        const values = await Promise.all(files.map(name => this._io.read(`${this._hwmon}/${name}`, cancellable)));
        this.fans = parseFans(Object.fromEntries(files.map((name, j) => [name, values[j]])));
    }

    // Each tick: only the rpm files of the fans found on this visit.
    async _readFans(cancellable) {
        if (!this._hwmon || !this.fans.length)
            return;
        const values = await Promise.all(this.fans.map(fan =>
            this._io.read(`${this._hwmon}/fan${fan.n}_input`, cancellable)));
        this.fans = this.fans.map((fan, i) => {
            const rpm = Number.parseInt(values[i] ?? '', 10);
            return Number.isNaN(rpm) ? fan : {...fan, rpm};
        });
    }
}

const cancelled = e => Boolean(e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED));
