// SPDX-License-Identifier: GPL-3.0-or-later
// GNOME's notifications, as GNOME's message tray holds them, for the
// Notifications tab (docs/features/notifications.md).
//
// PRIVATE / INTERNAL API. This is the only code in
// Froonty that reads or writes GNOME's notification objects (ui/
// messageTray.js, verified against GNOME Shell 50.1):
//
//   tray      Main.messageTray: getSources(), 'source-added',
//             'source-removed' (also when an app is switched off in
//             Settings, without a destroy)
//   Source    notifications (oldest first), title, icon,
//             'notification-added', 'notification-removed' (emitted from
//             inside the notification's own 'destroy')
//   Notification  title, body, use-body-markup, gicon, datetime, urgency,
//             acknowledged (GNOME's "seen"), actions[].label, notify,
//             'action-added', 'action-removed'; activate(),
//             actions[i].activate(), destroy(reason)
//
// It keeps no copy: the list is GNOME's objects, sorted. It watches them
// only between watch() and unwatch(), and writes only when asked to by an
// explicit user act (acknowledgeAll, activate, activateAction, dismiss,
// clear), with the very calls GNOME's own list makes. Each listed one has
// a version, bumped whenever what it shows changes or it comes back
// unseen (an app updating it in place), so "Clear all" never dismisses
// content the user was not shown when they asked.
//
// Shell-free on purpose (only core/emitter.js), so plain gjs can test it
// with fakes. The Shell's enum values come in through the constructor.

import {Emitter} from '../core/emitter.js';

/** GNOME's list shows at most this many action buttons (messageList.js). */
export const MAX_ACTIONS = 3;

/**
 * Sort order: urgent first, then newest first (a notification without a
 * time after every timed one), then the later arrival first.
 *
 * @param {{urgent: boolean, time: ?number, seq: number}} a
 * @param {{urgent: boolean, time: ?number, seq: number}} b
 * @returns {number}
 */
export function compareEntries(a, b) {
    if (a.urgent !== b.urgent)
        return a.urgent ? -1 : 1;
    if (a.time !== b.time) {
        if (a.time === null)
            return 1;
        if (b.time === null)
            return -1;
        return b.time - a.time;
    }
    return b.seq - a.seq;
}

/**
 * Emits 'changed' when the list (or its order) changes, and
 * 'notification-changed' (notification) when what one of them shows
 * changed: its text, icon, actions, app, seen state, time or urgency (the
 * last two also change the order).
 */
export class NotificationStore extends Emitter {
    /**
     * @param {object} tray GNOME's message tray (Main.messageTray)
     * @param {object} values the Shell's enum values, and GNOME's queue
     * @param {number} values.critical MessageTray.Urgency.CRITICAL
     * @param {number} values.dismissed
     *   MessageTray.NotificationDestroyedReason.DISMISSED
     * @param {Function} [values.waitingForBanner] (notification) → whether
     *   it waits in GNOME's banner queue (its banner will mark it seen)
     * @param {object} [options]
     * @param {?Function} options.filter source → whether to follow it; a
     *   source it turns down gets no handler at all (the Claude attention
     *   bar follows only the Claude app and web browsers)
     */
    constructor(tray, {critical, dismissed, waitingForBanner = () => false}, {filter = null} = {}) {
        super();
        this._tray = tray;
        this._critical = critical;
        this._dismissed = dismissed;
        this._waitingForBanner = waitingForBanner;
        this._filter = filter;
        this._watching = false;
        this._trayIds = [];
        /** @type {Map<object, number[]>} source → its handler ids */
        this._sources = new Map();
        /** @type {Map<object, object>} notification → {source, seq, version, urgent, time, ids} */
        this._entries = new Map();
        this._unseen = new Set();
        this._seq = 0;
        // Versions are unique across entries: one listed again (its app
        // switched off and on) never matches an older snapshot.
        this._versions = 0;
        this._sorted = null;
        this._batch = 0;
        this._pending = false;
    }

    get watching() {
        return this._watching;
    }

    /** Starts following GNOME's notifications; emits 'changed' once. */
    watch() {
        if (this._watching)
            return;
        this._watching = true;

        this._trayIds = [
            this._tray.connect('source-added', (_tray, source) => {
                this._addSource(source);
                this._changed();
            }),
            this._tray.connect('source-removed', (_tray, source) => {
                this._removeSource(source);
                this._changed();
            }),
        ];
        for (const source of this._tray.getSources())
            this._addSource(source);
        this._changed();
    }

    /**
     * Stops following them: no handler is left on the tray, a source or a
     * notification. Every object it disconnects from is alive: a destroyed
     * notification or source was already forgotten from inside its own
     * 'destroy' emission.
     */
    unwatch() {
        if (!this._watching)
            return;
        this._watching = false;

        for (const id of this._trayIds)
            this._tray.disconnect(id);
        this._trayIds = [];
        for (const [notification, entry] of this._entries) {
            for (const id of entry.ids)
                notification.disconnect(id);
        }
        for (const [source, ids] of this._sources) {
            for (const id of ids)
                source.disconnect(id);
        }
        this._entries.clear();
        this._sources.clear();
        this._unseen.clear();
        this._sorted = null;
        this._pending = false;
    }

    /** GNOME's notifications, sorted (compareEntries); [] while not watching. */
    get notifications() {
        if (!this._sorted) {
            this._sorted = Object.freeze([...this._entries]
                .sort(([, a], [, b]) => compareEntries(a, b))
                .map(([notification]) => notification));
        }
        return this._sorted;
    }

    /** Whether it is listed (watched and not destroyed). */
    has(notification) {
        return this._entries.has(notification);
    }

    /** How many listed notifications GNOME counts as not seen. */
    get unseenCount() {
        return this._unseen.size;
    }

    /**
     * What a row shows, as plain values: nothing in it is a notification,
     * so a row never reads one.
     *
     * @param {object} notification
     * @returns {?object} null when not listed
     */
    describe(notification) {
        const entry = this._entries.get(notification);
        if (!entry)
            return null;
        return {
            appName: entry.source.title || null,
            // The source's app (FdoNotificationDaemonSource only).
            appId: entry.source.app?.get_id?.() ?? null,
            appIcon: entry.source.icon ?? null,
            title: notification.title ?? '',
            body: notification.body ?? '',
            useMarkup: !!notification.useBodyMarkup,
            icon: notification.gicon ?? null,
            time: notification.datetime ?? null,
            urgent: entry.urgent,
            unseen: !notification.acknowledged,
            actions: (notification.actions ?? []).slice(0, MAX_ACTIONS).map(action => action.label),
        };
    }

    // ------------------------------------------------------------ writes
    // Only on an explicit user act, and only the calls GNOME's own list
    // makes (messageList.js NotificationMessage, NotificationMessageGroup).

    /**
     * Marks every listed notification seen (GNOME's `acknowledged`), as
     * GNOME's list does when it is shown, except one still waiting in
     * GNOME's banner queue: its banner shows once banners are no longer
     * held, and marks it seen then. (GNOME's dot counts unseen minus
     * queued, and drops seen ones from the queue only while banners are
     * not held; one marked seen in the queue would be subtracted twice,
     * and a later unseen one would light no dot.) Nothing is removed.
     *
     * @returns {number} how many were marked
     */
    acknowledgeAll() {
        let count = 0;
        for (const notification of [...this._unseen]) {
            if (!this._entries.has(notification) || this._waitingForBanner(notification))
                continue;
            notification.acknowledged = true;
            count++;
        }
        return count;
    }

    /** A click on it: GNOME's activate() (it removes it unless resident). */
    activate(notification) {
        if (!this.has(notification))
            return false;
        notification.activate();
        return true;
    }

    /** One of its first MAX_ACTIONS buttons: GNOME's Action.activate(). */
    activateAction(notification, index) {
        if (!this.has(notification) || !Number.isInteger(index) ||
            index < 0 || index >= MAX_ACTIONS)
            return false;
        const action = notification.actions?.[index];
        if (!action)
            return false;
        action.activate();
        return true;
    }

    /** × or Delete: GNOME's destroy(DISMISSED), as its close button. */
    dismiss(notification) {
        if (!this.has(notification))
            return false;
        notification.destroy(this._dismissed);
        return true;
    }

    /**
     * What "Clear all" asks to clear: each listed notification and its
     * version. Holds no handler; only this store's own map is read later.
     *
     * @returns {Map<object, number>}
     */
    snapshot() {
        return new Map([...this._entries].map(([notification, entry]) =>
            [notification, entry.version]));
    }

    /**
     * How many of `snapshot` are still listed, unchanged: what clear()
     * would dismiss now.
     *
     * @param {Map<object, number>} snapshot from snapshot()
     * @returns {number}
     */
    countUnchanged(snapshot) {
        let count = 0;
        for (const [notification, version] of snapshot) {
            if (this._entries.get(notification)?.version === version)
                count++;
        }
        return count;
    }

    /**
     * "Clear all", confirmed: dismisses those of `snapshot` (what was listed
     * when it was asked for) that are still listed and unchanged, and emits
     * one 'changed'. One updated meanwhile (new text, a new time, unseen
     * again) stays: the user was not shown that content when they asked.
     * A source that empties destroys itself on the way (GNOME's rule); that
     * is followed through the tray, so later ones are simply skipped.
     *
     * @param {Map<object, number>} snapshot from snapshot()
     * @returns {number} how many were dismissed
     */
    clear(snapshot) {
        let count = 0;
        this._batch++;
        try {
            for (const [notification, version] of snapshot) {
                // A destroyed one is not listed; it is never read here.
                if (this._entries.get(notification)?.version !== version)
                    continue;
                notification.destroy(this._dismissed);
                count++;
            }
        } finally {
            this._batch--;
            if (this._batch === 0 && this._pending) {
                this._pending = false;
                this.emit('changed');
            }
        }
        return count;
    }

    // ------------------------------------------------------------ following

    _changed() {
        this._sorted = null;
        if (this._batch > 0)
            this._pending = true;
        else
            this.emit('changed');
    }

    _addSource(source) {
        if (this._sources.has(source) || (this._filter && !this._filter(source)))
            return;
        this._sources.set(source, [
            source.connect('notification-added', (_source, notification) => {
                this._addNotification(notification, source);
                this._changed();
            }),
            // From inside the notification's 'destroy' emission, before
            // GNOME disposes it.
            source.connect('notification-removed', (_source, notification) => {
                if (this._removeNotification(notification))
                    this._changed();
            }),
            source.connect('notify::title', () => this._sourceChanged(source)),
            source.connect('notify::icon', () => this._sourceChanged(source)),
        ]);
        for (const notification of source.notifications ?? [])
            this._addNotification(notification, source);
    }

    // From inside the source's 'destroy' emission (the tray's own handler),
    // after GNOME destroyed its notifications; or when its app is switched
    // off in Settings, when it and its notifications stay alive. Either
    // way it is still alive here. Its notifications are found in the
    // entries, never through source.notifications.
    _removeSource(source) {
        for (const [notification, entry] of this._entries) {
            if (entry.source === source)
                this._removeNotification(notification);
        }
        for (const id of this._sources.get(source) ?? [])
            source.disconnect(id);
        this._sources.delete(source);
    }

    _addNotification(notification, source) {
        if (this._entries.has(notification))
            return;
        const entry = {source, seq: ++this._seq, version: ++this._versions, urgent: false, time: null, ids: []};
        this._read(notification, entry);
        const actionsChanged = () => {
            entry.version = ++this._versions;
            this.emit('notification-changed', notification);
        };
        entry.ids = [
            notification.connect('notify', (_n, pspec) => this._onNotify(notification, entry, pspec.name)),
            notification.connect('action-added', actionsChanged),
            notification.connect('action-removed', actionsChanged),
        ];
        this._entries.set(notification, entry);
        if (!notification.acknowledged)
            this._unseen.add(notification);
    }

    /** @returns {boolean} whether it was listed */
    _removeNotification(notification) {
        const entry = this._entries.get(notification);
        if (!entry)
            return false;
        for (const id of entry.ids)
            notification.disconnect(id);
        this._entries.delete(notification);
        this._unseen.delete(notification);
        return true;
    }

    _read(notification, entry) {
        entry.urgent = notification.urgency === this._critical;
        entry.time = notification.datetime?.to_unix_usec() ?? null;
    }

    // What its row shows changed: a new version. Being marked seen is not
    // a change of content; coming back unseen (an app updating it in
    // place sets acknowledged to false, even when it already was) is.
    _onNotify(notification, entry, name) {
        switch (name) {
        // The order changes, and so does what its row shows (its age, the
        // urgent outline).
        case 'datetime':
        case 'urgency':
            entry.version = ++this._versions;
            this._read(notification, entry);
            this._changed();
            this.emit('notification-changed', notification);
            break;
        case 'acknowledged':
            if (notification.acknowledged) {
                this._unseen.delete(notification);
            } else {
                entry.version = ++this._versions;
                this._unseen.add(notification);
            }
            this.emit('notification-changed', notification);
            break;
        case 'title':
        case 'body':
        case 'use-body-markup':
        case 'gicon':
            entry.version = ++this._versions;
            this.emit('notification-changed', notification);
            break;
        }
    }

    _sourceChanged(source) {
        for (const [notification, entry] of this._entries) {
            if (entry.source === source)
                this.emit('notification-changed', notification);
        }
    }
}
