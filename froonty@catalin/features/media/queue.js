// SPDX-License-Identifier: GPL-3.0-or-later
// "Up next" (docs/features/media.md §Up next): the songs after the current
// one in the shown player's MPRIS TrackList, only while the panel is open.
// Few players have a TrackList, so "unsupported" is the common state.
//
// Its signals are followed through one subscription on the player's
// unique name, made when the panel opens and removed when it closes (a
// proxy would keep its match rules until garbage collection). "Play now"
// is GoTo(id); it counts only once the player's current song is that one
// (within 1.5 s), else the panel says so.
//
// state: 'unsupported', 'loading', 'empty', 'ready' or 'failed'.
// Emits 'changed'. No St.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Emitter} from '../../core/emitter.js';
import {isCancelled} from './fetch.js';
import {queueRows, upcomingIds} from './lyrics.js';
import {PATH, TRACKLIST} from './mpris.js';
import {OneShot, decodeMetadata, glibTimers} from './model.js';

const SIGNALS = ['TrackListReplaced', 'TrackAdded', 'TrackRemoved', 'TrackMetadataChanged'];
const VERIFY_MS = 1500;

export class QueueClient extends Emitter {
    /**
     * @param {object} options
     * @param {MediaService} options.media
     * @param {object} [options.timers]
     */
    constructor({media, timers = glibTimers}) {
        super();
        this._media = media;
        this._timers = timers;
        this._open = false;
        this._subscription = 0;
        this._subscribedTo = null;
        this._mediaId = 0;
        this._idleId = 0;
        this._token = 0;
        this._goal = null;
        this._verify = new OneShot(timers, () => {
            if (this._goal) {
                this._goal = null;
                this.notice = 'did-not-switch';
                this.emit('changed');
            }
        });
        this.state = 'unsupported';
        this.rows = [];
        /** 'did-not-switch' after a "Play now" that did not take, else null. */
        this.notice = null;
    }

    /** True while the TrackList's signals are followed (tests). */
    get subscribed() {
        return this._subscription !== 0;
    }

    setOpen(open) {
        if (open === this._open)
            return;
        this._open = open;
        if (open) {
            this._mediaId = this._media.connect('changed', () => this._onMediaChanged());
            this._onMediaChanged();
            this.refresh();
        } else {
            this._media.disconnect(this._mediaId);
            this._mediaId = 0;
            this._unsubscribe();
            this._verify.stop();
            this._goal = null;
            this.notice = null;
            this._token++;
            if (this._idleId)
                this._timers.remove(this._idleId);
            this._idleId = 0;
        }
    }

    destroy() {
        this.setOpen(false);
    }

    _supported() {
        const playback = this._media.playback;
        return Boolean(playback?.hasTrackList && this._media.player);
    }

    _onMediaChanged() {
        const player = this._supported() ? this._media.player : null;
        const target = player ? `${player.owner}` : null;
        if (target !== this._subscribedTo) {
            this._unsubscribe();
            if (player)
                this._subscribe(player);
            this._queueRefresh();
        }
        const current = this._media.playback?.track.trackId ?? null;
        if (this._goal && current === this._goal) {
            this._goal = null;
            this._verify.stop();
            this._queueRefresh();
        } else if (current !== this._current) {
            this._queueRefresh();
        }
        this._current = current;
    }

    _subscribe(player) {
        const bus = this._media.watcher.bus;
        this._bus = bus;
        this._subscribedTo = player.owner;
        this._subscription = bus.signal_subscribe(player.owner, TRACKLIST, null, PATH, null,
            Gio.DBusSignalFlags.NONE, (_connection, _sender, _path, _iface, signal) => {
                if (SIGNALS.includes(signal))
                    this._queueRefresh();
            });
    }

    _unsubscribe() {
        if (this._subscription)
            this._bus.signal_unsubscribe(this._subscription);
        this._subscription = 0;
        this._subscribedTo = null;
    }

    _queueRefresh() {
        if (this._idleId || !this._open)
            return;
        this._idleId = this._timers.idle(() => {
            this._idleId = 0;
            this.refresh();
        });
    }

    _set(state, rows = []) {
        this.state = state;
        this.rows = rows;
        this.emit('changed');
    }

    /** Reads the upcoming songs again. */
    async refresh() {
        if (!this._open)
            return;
        const token = ++this._token;
        const playback = this._media.playback;
        const player = this._supported() ? this._media.player : null;
        if (!player) {
            this._set('unsupported');
            return;
        }
        if (!this.rows.length)
            this._set('loading');
        let state = 'failed';
        let rows = [];
        try {
            const tracks = await player.get(TRACKLIST, 'Tracks');
            const ids = tracks.get_type_string() === 'ao'
                ? upcomingIds(tracks.deepUnpack(), playback.track.trackId) : null;
            if (ids === null) {
                state = 'unsupported';
            } else if (!ids.length) {
                state = 'empty';
            } else {
                const reply = await player.call('GetTracksMetadata',
                    new GLib.Variant('(ao)', [ids]), TRACKLIST);
                const list = reply.get_type_string() === '(aa{sv})' ? reply.get_child_value(0) : null;
                const decoded = [];
                for (let i = 0; list && i < list.n_children(); i++)
                    decoded.push(decodeMetadata(list.get_child_value(i)));
                rows = queueRows(ids, decoded);
                state = rows.length ? 'ready' : 'empty';
            }
        } catch (e) {
            if (isCancelled(e))
                return;
        }
        if (token !== this._token || !this._open)
            return;
        this._set(state, rows);
    }

    /**
     * Plays a listed song now (GoTo), for the player shown with `context`.
     *
     * @returns {Promise<boolean>} whether it was asked
     */
    async playNow(row, context) {
        const player = this._media.player;
        if (!row || !player || !this._media.allowed(context) ||
            !this._media.playback.caps.canControl)
            return false;
        this.notice = null;
        this._goal = row.trackId;
        this.emit('changed');
        try {
            await player.call('GoTo', new GLib.Variant('(o)', [row.trackId]), TRACKLIST);
        } catch (e) {
            if (!isCancelled(e) && this._open) {
                this._goal = null;
                this.notice = 'did-not-switch';
                this.emit('changed');
            }
            return false;
        }
        if (this._goal === row.trackId)
            this._verify.restart(VERIFY_MS);
        return true;
    }
}
