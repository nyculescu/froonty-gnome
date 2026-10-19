// SPDX-License-Identifier: GPL-3.0-or-later
// What tells the Break tab you are busy at the computer without typing
// (docs/features/break.md, "Busy"). Each source is an event; nothing is
// polled:
//
//   fullscreen     global.display 'in-fullscreen-changed' and
//                  get_monitor_in_fullscreen() (Mutter)
//   screen-share   the remote access controller's handles, sharing or
//                  recording, as ui/status/remoteAccess.js follows them;
//                  only handles that start while this runs are seen
//   microphone     the Shell's own mixer control (shell/mixer.js): an app
//                  records sound, with GNOME's own exceptions (the volume
//                  control apps' level meters)
//   dnd            org.gnome.desktop.notifications show-banners off
//   watching       org.gnome.SessionManager's idle inhibitors (flag 8: a
//                  video keeps the screen awake), followed through its
//                  InhibitorAdded / InhibitorRemoved signals; each one's
//                  app id and reason are read once, to show who
//
// Emits 'changed'. Made only while the Break tab's "Notice when you are
// busy" is on (features/break/shared.js).

import Gio from 'gi://Gio';

import {Emitter} from '../core/emitter.js';
import {getMixer} from './mixer.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call');

const SESSION = 'org.gnome.SessionManager';
const SESSION_PATH = '/org/gnome/SessionManager';
const INHIBITOR_IFACE = 'org.gnome.SessionManager.Inhibitor';
// GsmInhibitorFlag: 8 is "idle" (4 suspend, 2 switch user, 1 logout).
const INHIBIT_IDLE = 8;
// GNOME's microphone indicator ignores these: they show an input level,
// not a recording (ui/status/volume.js _maybeShowInput, 50.1).
const LEVEL_METER_APPS = ['org.gnome.VolumeControl', 'org.PulseAudio.pavucontrol'];

export class BusySignals extends Emitter {
    constructor() {
        super();
        this._started = false;
        this._ids = [];
        this._handles = new Map();
        this._inhibitors = new Map();
        this._busSubs = [];
        this._cancellable = null;
        this._generation = 0;
        this._reads = 0;
        this._fullscreen = false;
        this._microphone = false;
        this._dnd = false;
    }

    start() {
        if (this._started)
            return;
        this._started = true;
        this._cancellable = new Gio.Cancellable();

        const display = global.display;
        this._ids.push([display, display.connect('in-fullscreen-changed', () => this._syncFullscreen())]);
        this._syncFullscreen(false);

        const controller = global.backend.get_remote_access_controller?.() ?? null;
        if (controller)
            this._ids.push([controller, controller.connect('new-handle', (_c, handle) => this._onHandle(handle))]);

        this._mixer = getMixer();
        for (const signal of ['stream-added', 'stream-removed', 'state-changed'])
            this._ids.push([this._mixer, this._mixer.connect(signal, () => this._syncMicrophone())]);
        this._syncMicrophone(false);

        this._notifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._ids.push([this._notifications,
            this._notifications.connect('changed::show-banners', () => this._syncDnd())]);
        this._syncDnd(false);

        for (const signal of ['InhibitorAdded', 'InhibitorRemoved']) {
            this._busSubs.push(Gio.DBus.session.signal_subscribe(SESSION, SESSION, signal,
                SESSION_PATH, null, Gio.DBusSignalFlags.NONE, () => this._readInhibitors()));
        }
        this._readInhibitors();
    }

    stop() {
        if (!this._started)
            return;
        this._started = false;
        this._generation++;
        this._cancellable.cancel();
        this._cancellable = null;
        for (const [object, id] of this._ids)
            object.disconnect(id);
        this._ids = [];
        for (const [handle, id] of this._handles)
            handle.disconnect(id);
        this._handles.clear();
        for (const id of this._busSubs)
            Gio.DBus.session.signal_unsubscribe(id);
        this._busSubs = [];
        this._inhibitors.clear();
        this._mixer = null;
        this._notifications = null;
    }

    /**
     * What is on now.
     *
     * @returns {{fullscreen: boolean, 'screen-share': boolean, microphone: boolean,
     *   dnd: boolean, watching: {app: string, reason: string}[]}}
     */
    get active() {
        return {
            'fullscreen': this._fullscreen,
            'screen-share': this._handles.size > 0,
            'microphone': this._microphone,
            'dnd': this._dnd,
            'watching': [...this._inhibitors.values()].filter(i => i.flags & INHIBIT_IDLE)
                .map(({app, reason}) => ({app, reason})),
        };
    }

    _set(field, value, emit = true) {
        if (this[field] === value)
            return;
        this[field] = value;
        if (emit)
            this.emit('changed');
    }

    _syncFullscreen(emit = true) {
        const display = global.display;
        let any = false;
        for (let i = 0; i < display.get_n_monitors(); i++)
            any ||= display.get_monitor_in_fullscreen(i);
        this._set('_fullscreen', any, emit);
    }

    _onHandle(handle) {
        if (this._handles.has(handle))
            return;
        this._handles.set(handle, handle.connect('stopped', () => {
            handle.disconnect(this._handles.get(handle));
            this._handles.delete(handle);
            this.emit('changed');
        }));
        this.emit('changed');
    }

    _syncMicrophone(emit = true) {
        const outputs = this._mixer?.get_source_outputs() ?? [];
        this._set('_microphone', outputs.some(o => !LEVEL_METER_APPS.includes(o.get_application_id())), emit);
    }

    _syncDnd(emit = true) {
        this._set('_dnd', !this._notifications.get_boolean('show-banners'), emit);
    }

    // The inhibitors now; each one's details are read once (an object path
    // is not reused while the session runs).
    async _readInhibitors() {
        const generation = this._generation;
        // Signals can start reads that overlap: only the latest counts.
        const read = ++this._reads;
        const cancellable = this._cancellable;
        try {
            const [paths] = (await Gio.DBus.session.call(SESSION, SESSION_PATH, SESSION, 'GetInhibitors',
                null, null, Gio.DBusCallFlags.NONE, -1, cancellable)).deepUnpack();
            const known = new Map();
            await Promise.all(paths.map(async path => {
                known.set(path, this._inhibitors.get(path) ?? await this._inhibitor(path, cancellable));
            }));
            if (generation !== this._generation || read !== this._reads)
                return;
            const before = JSON.stringify(this.active.watching);
            this._inhibitors = new Map([...known].filter(([, i]) => i));
            if (JSON.stringify(this.active.watching) !== before)
                this.emit('changed');
        } catch (e) {
            // No GNOME session manager (another session), or stopped.
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`Froonty: break busy: inhibitors: ${e.message}`);
        }
    }

    async _inhibitor(path, cancellable) {
        const get = async method => (await Gio.DBus.session.call(SESSION, path, INHIBITOR_IFACE, method,
            null, null, Gio.DBusCallFlags.NONE, -1, cancellable)).deepUnpack()[0];
        try {
            const [app, reason, flags] = await Promise.all(['GetAppId', 'GetReason', 'GetFlags'].map(get));
            return {app, reason, flags};
        } catch (e) {
            // Gone meanwhile.
            return null;
        }
    }
}
