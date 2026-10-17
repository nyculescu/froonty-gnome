// SPDX-License-Identifier: GPL-3.0-or-later
// GNOME's notifications, as GNOME's message tray holds them, for the
// Claude attention bar (docs/features/claude-attention.md).
//
// PRIVATE / INTERNAL API. This is the only code in
// Froonty that reads or writes GNOME's notification objects (ui/
// messageTray.js, verified against GNOME Shell 50.1):
//
//   tray      Main.messageTray: getSources(), 'source-added',
//             'source-removed' (also when an app is switched off in
//             Settings, without a destroy)
//   Source    notifications (oldest first), title, app,
//             'notification-added', 'notification-removed' (emitted from
//             inside the notification's own 'destroy')
//   Notification  title, body, use-body-markup, datetime, urgency, notify;
//             activate(), destroy(reason)
//
// It keeps no copy: the list is GNOME's objects, sorted. It watches them
// only between watch() and unwatch(), and writes only when asked to by an
// explicit user act (activate, dismiss), with the very calls GNOME's own
// list makes.
//
// Shell-free on purpose (only core/emitter.js), so plain gjs can test it
// with fakes. The Shell's enum values come in through the constructor.

import {Emitter} from '../core/emitter.js';

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
 * Emits 'changed' when the list (or its order: a new time or urgency)
 * changes, and 'notification-changed' (notification) when its text or
 * app changed.
 */
export class NotificationStore extends Emitter {
    /**
     * @param {object} tray GNOME's message tray (Main.messageTray)
     * @param {object} values the Shell's enum values
     * @param {number} values.critical MessageTray.Urgency.CRITICAL
     * @param {number} values.dismissed
     *   MessageTray.NotificationDestroyedReason.DISMISSED
     * @param {object} [options]
     * @param {?Function} options.filter source → whether to follow it; a
     *   source it turns down gets no handler at all
     */
    constructor(tray, {critical, dismissed}, {filter = null} = {}) {
        super();
        this._tray = tray;
        this._critical = critical;
        this._dismissed = dismissed;
        this._filter = filter;
        this._watching = false;
        this._trayIds = [];
        /** @type {Map<object, number[]>} source → its handler ids */
        this._sources = new Map();
        /** @type {Map<object, object>} notification → {source, seq, urgent, time, ids} */
        this._entries = new Map();
        this._seq = 0;
        this._sorted = null;
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
        this._sorted = null;
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

    /**
     * What the bar shows of it, as plain values: nothing in it is a
     * notification, so the bar never reads one.
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
            title: notification.title ?? '',
            body: notification.body ?? '',
            useMarkup: !!notification.useBodyMarkup,
            time: notification.datetime ?? null,
        };
    }

    // ------------------------------------------------------------ writes
    // Only on an explicit user act, and only the calls GNOME's own list
    // makes (messageList.js NotificationMessage, NotificationMessageGroup).

    /** A click on it: GNOME's activate() (it removes it unless resident). */
    activate(notification) {
        if (!this.has(notification))
            return false;
        notification.activate();
        return true;
    }

    /** × or Delete: GNOME's destroy(DISMISSED), as its close button. */
    dismiss(notification) {
        if (!this.has(notification))
            return false;
        notification.destroy(this._dismissed);
        return true;
    }

    // ------------------------------------------------------------ following

    _changed() {
        this._sorted = null;
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
        const entry = {source, seq: ++this._seq, urgent: false, time: null, ids: []};
        this._read(notification, entry);
        entry.ids = [
            notification.connect('notify', (_n, pspec) => this._onNotify(notification, entry, pspec.name)),
        ];
        this._entries.set(notification, entry);
    }

    /** @returns {boolean} whether it was listed */
    _removeNotification(notification) {
        const entry = this._entries.get(notification);
        if (!entry)
            return false;
        for (const id of entry.ids)
            notification.disconnect(id);
        this._entries.delete(notification);
        return true;
    }

    _read(notification, entry) {
        entry.urgent = notification.urgency === this._critical;
        entry.time = notification.datetime?.to_unix_usec() ?? null;
    }

    _onNotify(notification, entry, name) {
        switch (name) {
        // The order changes.
        case 'datetime':
        case 'urgency':
            this._read(notification, entry);
            this._changed();
            break;
        case 'title':
        case 'body':
        case 'use-body-markup':
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
