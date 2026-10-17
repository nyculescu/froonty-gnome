// SPDX-License-Identifier: GPL-3.0-or-later
// Fan settings (docs/features/fan.md): the cooling pad's state and the CPU
// and GPU temperatures, read while Settings → Fan is on screen. The same
// Sampler as Btop is used, so a sleeping NVIDIA GPU is not woken up.
//
// Pad commands run one at a time (pad.js spawns llano.py). A new speed
// replaces one still waiting, so dragging the slider sends only the
// latest; a status poll only runs when nothing waits.
//
// The recommended speed comes from llano-v12-linux's fan_lut.json (lut.js),
// read on each settings-page visit, so a new sweep shows without a restart.
//
// The laptop's own fans, profile and curves (asus.js, through asusd) are
// read with the temperatures, so a tick ends in one 'changed'.
//
// Emits 'changed' after each sample or command, and when the settings
// change. No St.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Emitter} from '../../core/emitter.js';
import {SYSTEM_IO} from '../sysmon/io.js';
import {Sampler} from '../sysmon/sampler.js';
import {AsusFans} from './asus.js';
import {parseLut, recommend} from './lut.js';
import * as Pad from './pad.js';

const INTERVAL_KEY = 'fan-interval';
const SCRIPT_KEY = 'fan-llano-path';
const LUT_KEY = 'fan-lut-path';

export class FanService extends Emitter {
    /** @param {Gio.Settings} settings */
    constructor(settings) {
        super();
        this._settings = settings;
        this._sampler = new Sampler(SYSTEM_IO);
        this._active = false;
        this._timerId = 0;
        this._cancellable = null;
        this._sampling = false;
        this._busy = false;
        this._pending = null;
        this._released = false;
        this._settingsIds = [];

        /** The pad's last state (pad.js parseStatus), or null. */
        this.status = null;
        /** Why the last command failed (pad.js failureKind), or null. */
        this.error = null;
        this.errorMessage = '';
        /** Active units that drive the pad by themselves (pad.js CONTROLLER_UNITS). */
        this.controllers = [];
        /** The panic lock's record (pad.js parseLock), or null when unlocked. */
        this.lock = null;
        /** The speed's rpm, dB at the ears and band (pad.js parseNoise), or null. */
        this.noise = null;
        /** Latest temperatures in °C: {cpu, gpu} (the hottest GPU), each null when unknown. */
        this.temps = null;
        /** fan_lut.json (lut.js parseLut), or null; lutError 'missing' or 'invalid' then. */
        this.lut = null;
        this.lutError = null;
        /** {fan, device, temp} from the LUT and the latest temperatures, or null. */
        this.recommendation = null;
        /** The laptop's fans, platform profile and curves (asus.js). */
        this.laptop = new AsusFans(SYSTEM_IO);
        /** Whether a laptop profile or curve change is under way. */
        this.laptopBusy = false;
        this._readSettings();
    }

    start() {
        this._settingsIds = [INTERVAL_KEY, SCRIPT_KEY, LUT_KEY].map(key =>
            this._settings.connect(`changed::${key}`, () => this._onSettingsChanged(key)));
    }

    stop() {
        this.setActive(false);
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
    }

    setActive(active) {
        if (active === this._active)
            return;
        this._active = active;
        if (active) {
            this._cancellable = new Gio.Cancellable();
            this._sampler.reset();
            this.laptop.reset();
            this._loadLut();
            this._schedule();
            this._tick();
        } else {
            this._unschedule();
            this._cancellable.cancel();
            this._cancellable = null;
        }
    }

    /** The control shown: 'software', 'pad', 'released' (see release()) or null. */
    get control() {
        if (!this.status)
            return null;
        if (this.status.control === 'software' && this._released && !this.controllers.length)
            return 'released';
        return this.status.control;
    }

    /** Whether a command runs or waits (the view leaves the slider alone meanwhile). */
    get busy() {
        return this._busy || this._pending !== null;
    }

    /**
     * Takes software control and sets the fan to `percent` (0-100), the pad on
     * and its lights too: at 0 % the fan still turns at its slowest (off()
     * stops it). A speed the pad already has under software control is not
     * sent again.
     */
    setSpeed(percent) {
        const speed = Math.round(Math.min(100, Math.max(0, percent)));
        if (!this.busy && this.control === 'software' && !this.status.off && this.status.speed === speed)
            return;
        this._released = false;
        this._queue({args: ['speed', String(speed)]});
    }

    /**
     * The whole pad off, fan and lights (llano.py off): the pad cannot stop
     * its fan and keep its lights on. Any speed switches it on again. Sent
     * even when it seems off already: llano.py then switches it on and off
     * (a short flash), which also ends a fan left on with the lights dark.
     */
    off() {
        this._released = false;
        this._queue({args: ['off']});
    }

    /**
     * Hands speed control back to the pad's roller. The pad keeps its speed,
     * and its status still says software until the roller is next turned
     * (llano-v12-linux README), so the Fan page says "released" until then.
     */
    release() {
        this._queue({args: ['release'], released: true});
    }

    /** The panic lock: fan off and llano.py refusing every write, or back. */
    setLocked(locked) {
        this._released = false;
        this._queue({args: [locked ? 'lock' : 'unlock']});
    }

    /** Switches the laptop's platform profile (asus.js PROFILES' numbers). */
    setLaptopProfile(profile) {
        this._laptopChange(() => this.laptop.setProfile(profile));
    }

    /** Turns the laptop's custom fan curves for the active profile on or off. */
    setLaptopCurves(enabled) {
        this._laptopChange(() => this.laptop.setCurvesEnabled(enabled));
    }

    async _laptopChange(change) {
        if (this.laptopBusy)
            return;
        this.laptopBusy = true;
        this.emit('changed');
        try {
            await change();
        } finally {
            this.laptopBusy = false;
        }
        this.emit('changed');
    }

    async stopController(unit) {
        await Pad.stopUnit(unit);
        this._released = true;
        this.controllers = await Pad.controllers();
        this._queue({args: ['status']});
    }

    _readSettings() {
        this._interval = this._settings.get_int(INTERVAL_KEY);
        this._script = this._settings.get_string(SCRIPT_KEY);
        this._lutPath = this._settings.get_string(LUT_KEY);
    }

    _onSettingsChanged(key) {
        this._readSettings();
        if (this._active && key === INTERVAL_KEY)
            this._schedule();
        if (this._active && key === SCRIPT_KEY)
            this._queue({args: ['status']}, {poll: true});
        if (this._active && key === LUT_KEY)
            this._loadLut();
        this.emit('changed');
    }

    _schedule() {
        this._unschedule();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._interval, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _unschedule() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = 0;
    }

    async _readLock() {
        this.lock = Pad.parseLock(await SYSTEM_IO.read(`${Pad.stateDir()}/lock`, this._cancellable));
    }

    _tick() {
        this._queue({args: ['status']}, {poll: true});
        Pad.controllers(this._cancellable).then(units => {
            this.controllers = units;
        }).catch(() => {});
        this._sample();
    }

    // A poll never replaces a command the user asked for.
    _queue(command, {poll = false} = {}) {
        if (poll && this.busy)
            return;
        this._pending = command;
        this._drain();
    }

    async _drain() {
        if (this._busy || !this._pending)
            return;
        const command = this._pending;
        this._pending = null;
        this._busy = true;
        try {
            const {status, noise, error, message} = await Pad.llano(this._script, command.args);
            // A write refused by the lock leaves the pad as it was.
            this.status = status ?? (error === 'locked' ? this.status : null);
            this.noise = status ? noise : error === 'locked' ? this.noise : null;
            this.error = error;
            this.errorMessage = message;
            if (command.released)
                this._released = true;
            // Turning the roller after a release: the pad is in charge again.
            if (status?.control === 'pad')
                this._released = false;
            // Before the command counts as done, so no poll slips in between.
            await this._readLock();
        } catch (e) {
            this.status = null;
            this.error = 'failed';
            this.errorMessage = e.message;
        } finally {
            this._busy = false;
        }
        this.emit('changed');
        this._drain();
    }

    async _loadLut() {
        // setActive(false) drops this._cancellable, so keep this read's own.
        const cancellable = this._cancellable;
        const text = await SYSTEM_IO.read(this._lutPath, cancellable);
        if (cancellable.is_cancelled())
            return;
        this.lut = text === null ? null : parseLut(text);
        this.lutError = text === null ? 'missing' : this.lut ? null : 'invalid';
        this._recommend();
        this.emit('changed');
    }

    _recommend() {
        this.recommendation = this.lut && this.temps ? recommend(this.lut, this.temps) : null;
    }

    async _sample() {
        // A slow nvidia-smi never piles up behind itself.
        if (this._sampling)
            return;
        this._sampling = true;
        const cancellable = this._cancellable;
        try {
            const [snapshot] = await Promise.all([
                this._sampler.sample(['cpu', 'gpu'], {now: GLib.get_monotonic_time() / 1e6, cancellable}),
                this.laptop.refresh(cancellable).catch(e =>
                    console.warn(`Froonty: Fan settings laptop read failed: ${e.message}`)),
            ]);
            if (!snapshot || cancellable?.is_cancelled())
                return;
            this._record(snapshot);
            this.emit('changed');
        } catch (e) {
            console.warn(`Froonty: Fan settings sample failed: ${e.message}`);
        } finally {
            this._sampling = false;
        }
    }

    // The NVIDIA (or hottest) GPU stands for 'gpu', as in the sweep.
    _record(snapshot) {
        const gpuTemps = (snapshot.gpus ?? []).map(gpu => gpu.temp).filter(t => t !== null && t !== undefined);
        this.temps = {cpu: snapshot.cpu?.temp ?? null, gpu: gpuTemps.length ? Math.max(...gpuTemps) : null};
        this._recommend();
    }
}
