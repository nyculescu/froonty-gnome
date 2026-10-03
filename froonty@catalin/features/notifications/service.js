// SPDX-License-Identifier: GPL-3.0-or-later
// Notifications tab service (docs/features/notifications.md): GNOME's own
// notifications and Do Not Disturb, only while the tab is on screen.
//
// No St here (plain gjs tests it). GNOME's notifications come in as
// ctx.notifications (shell/messageTray.js), whose store is the only code
// touching GNOME's notification objects. Do Not Disturb is GNOME's own
// key, org.gnome.desktop.notifications show-banners (inverted), the one
// Quick Settings' toggle is bound to.

import Gio from 'gi://Gio';

import {Emitter} from '../../core/emitter.js';

const NOTIFICATIONS_SCHEMA = 'org.gnome.desktop.notifications';
const SHOW_BANNERS = 'show-banners';

/**
 * Emits 'changed' (the list), 'notification-changed' (notification) and
 * 'dnd-changed', only while active.
 */
export class NotificationsService extends Emitter {
    /**
     * @param {?object} gnome ctx.notifications, or null without GNOME's tray
     * @param {object} [options]
     * @param {?Gio.Settings} [options.notificationSettings] GNOME's
     *   notification settings (tests pass one on a memory backend)
     */
    constructor(gnome, {notificationSettings = null} = {}) {
        super();
        this._gnome = gnome ?? null;
        this._givenSettings = notificationSettings;
        this._store = null;
        this._storeIds = [];
        this._dnd = null;
        this._dndIds = [];
        this._active = false;
    }

    /** Nothing to start: nothing is watched until the tab is on screen. */
    start() {
    }

    stop() {
        this.setActive(false);
        // Left to the garbage collector, as ClockService's settings.
        this._store = null;
        this._dnd = null;
    }

    /** On screen: follow GNOME's notifications and Do Not Disturb. */
    setActive(active) {
        if (active === this._active)
            return;
        this._active = active;

        if (active) {
            this._store ??= this._gnome?.createStore() ?? null;
            if (this._store) {
                this._storeIds = [
                    this._store.connect('changed', () => this.emit('changed')),
                    this._store.connect('notification-changed',
                        (_store, notification) => this.emit('notification-changed', notification)),
                ];
                this._store.watch();
            }
            this._dnd ??= this._givenSettings ??
                new Gio.Settings({schema_id: NOTIFICATIONS_SCHEMA});
            this._dndIds = [
                this._dnd.connect(`changed::${SHOW_BANNERS}`, () => this.emit('dnd-changed')),
                this._dnd.connect(`writable-changed::${SHOW_BANNERS}`, () => this.emit('dnd-changed')),
            ];
            this.emit('dnd-changed');
            return;
        }

        for (const id of this._storeIds)
            this._store.disconnect(id);
        this._storeIds = [];
        this._store?.unwatch();
        for (const id of this._dndIds)
            this._dnd.disconnect(id);
        this._dndIds = [];
    }

    get active() {
        return this._active;
    }

    /** Whether this Shell has GNOME's message tray. */
    get available() {
        return this._gnome !== null;
    }

    /** The listed notifications (opaque keys), sorted; [] while inactive. */
    get items() {
        return this._active ? this._store?.notifications ?? [] : [];
    }

    get doNotDisturb() {
        return this._dnd ? !this._dnd.get_boolean(SHOW_BANNERS) : false;
    }

    get canChangeDoNotDisturb() {
        return this._dnd?.is_writable(SHOW_BANNERS) ?? false;
    }

    /** What a row shows (plain values), or null. */
    describe(notification) {
        return this._active ? this._store?.describe(notification) ?? null : null;
    }

    /** The user opened or touched the tab on purpose: GNOME's "seen". */
    markSeen() {
        return this._active ? this._store?.acknowledgeAll() ?? 0 : 0;
    }

    activate(notification) {
        return this._active ? this._store?.activate(notification) ?? false : false;
    }

    activateAction(notification, index) {
        return this._active ? this._store?.activateAction(notification, index) ?? false : false;
    }

    dismiss(notification) {
        return this._active ? this._store?.dismiss(notification) ?? false : false;
    }

    /**
     * What "Clear all" would clear, as listed now: each one and its
     * version (NotificationStore.snapshot); empty while inactive.
     *
     * @returns {Map<object, number>}
     */
    snapshot() {
        return this._active ? this._store?.snapshot() ?? new Map() : new Map();
    }

    /**
     * How many of `snapshot` are still listed and unchanged (what clear()
     * would dismiss); 0 while inactive.
     *
     * @param {Map<object, number>} snapshot
     */
    countClearable(snapshot) {
        return this._active ? this._store?.countUnchanged(snapshot) ?? 0 : 0;
    }

    /** @param {Map<object, number>} snapshot from snapshot(), at the first click */
    clear(snapshot) {
        return this._active ? this._store?.clear(snapshot) ?? 0 : 0;
    }

    /** Writes GNOME's own key, as Quick Settings' toggle does. */
    setDoNotDisturb(on) {
        if (!this._active || !this.canChangeDoNotDisturb)
            return false;
        this._dnd.set_boolean(SHOW_BANNERS, !on);
        return true;
    }
}
