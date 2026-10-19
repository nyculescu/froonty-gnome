// SPDX-License-Identifier: GPL-3.0-or-later
// "Pause media on Take now" (docs/features/break.md, break-pause-media):
// Take now pauses every player that is playing (the Media tab's shared
// service, its pauseAll), and plays again only those, if still paused,
// when you come back: the first input after an away that began after the
// Take. Nothing is held while no break is taken.
//
// What it paused is plain data in ctx.memory, which survives a screen
// lock (a Take may lock the screen, and a lock disables Froonty): the hold
// made after the unlock plays them again at once, since you are back.
// The Media service is held only from the Take until the players are
// played again.

import {acquireMedia, releaseMedia} from '../media/shared.js';

const MEMORY_KEY = 'breakMediaHeld';
// Waiting for the Media service to list the players: at most this many
// of its changes (it reports the first listing as a change).
const READY_CHANGES = 20;

export class MediaHold {
    /**
     * @param {object} ctx the feature context (settings, memory, version)
     * @param {BreakService} service
     */
    constructor(ctx, service) {
        this._ctx = ctx;
        this._service = service;
        this._media = null;
        this._mediaId = 0;
        this._watcherId = 0;
        this._serviceId = 0;
        this._away = false;
        this._destroyed = false;
        // Held before a screen lock: you are back now.
        if (this._held.length)
            this._resume();
    }

    destroy() {
        this._destroyed = true;
        this._unfollow();
        this._release();
    }

    get _held() {
        return this._ctx.memory?.[MEMORY_KEY] ?? [];
    }

    set _held(list) {
        if (this._ctx.memory)
            this._ctx.memory[MEMORY_KEY] = list;
    }

    /** Take now: pauses what plays, and follows the break. */
    async take() {
        if (this._held.length || this._media)
            return;
        const media = await this._acquire();
        if (!media || this._destroyed)
            return;
        const paused = await media.pauseAll();
        if (this._destroyed)
            return;
        if (!paused.length) {
            this._release();
            return;
        }
        this._held = paused;
        this._away = false;
        this._serviceId = this._service.connect('changed', () => this._onService());
    }

    // Away (an idle period), then back: play again.
    _onService() {
        const m = this._service.model();
        if (!m.present)
            this._away = true;
        else if (this._away)
            this._resume();
    }

    async _resume() {
        this._unfollow();
        const held = this._held;
        this._held = [];
        if (!held.length)
            return;
        const media = this._media ?? await this._acquire();
        if (media && !this._destroyed)
            await media.resume(held);
        this._release();
    }

    _unfollow() {
        if (this._serviceId)
            this._service.disconnect(this._serviceId);
        this._serviceId = 0;
    }

    // The shared Media service once it has listed the players.
    _acquire() {
        this._media = acquireMedia(this._ctx);
        const media = this._media;
        if (media.ready)
            return Promise.resolve(media);
        // The service reports a change when it lists players; with none,
        // only its watcher says it is ready.
        return new Promise(resolve => {
            let changes = 0;
            const watcher = media.watcher;
            const done = () => {
                media.disconnect(this._mediaId);
                watcher?.disconnect(this._watcherId);
                this._mediaId = this._watcherId = 0;
                resolve(this._destroyed ? null : media);
            };
            this._mediaId = media.connect('changed', () => {
                if (media.ready || ++changes >= READY_CHANGES || this._destroyed)
                    done();
            });
            this._watcherId = watcher?.connect('ready', () => done()) ?? 0;
        });
    }

    _release() {
        if (!this._media)
            return;
        if (this._mediaId)
            this._media.disconnect(this._mediaId);
        if (this._watcherId)
            this._media.watcher?.disconnect(this._watcherId);
        this._mediaId = this._watcherId = 0;
        this._media = null;
        releaseMedia();
    }
}
