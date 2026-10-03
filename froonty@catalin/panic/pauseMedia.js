// SPDX-License-Identifier: GPL-3.0-or-later
// Panic button "Pause all media": pauses every player that is playing
// (MPRIS, through the shared Media service); a second click plays again
// the ones it paused. Checked (red) while some of those are still paused,
// insensitive while there is nothing to pause and nothing held.
//
// It holds the Media service only while the island is open (setActive).
// What it paused lives on the button, so a screen lock (which runs
// disable()) forgets it (docs/features/media.md §Panic button).

import St from 'gi://St';

import {acquireMedia, releaseMedia} from '../features/media/shared.js';
import {OneShot, glibTimers} from '../features/media/model.js';

// A player that has not reported itself paused this long after Pause
// ignored it: the button does not claim it.
const SETTLE_MS = 1500;

export class PauseMediaButton {
    /**
     * @param {string} title accessible name
     * @param {object} actions {ctx}: the feature context (settings, memory)
     */
    constructor(title, {ctx}) {
        this._ctx = ctx;
        this._media = null;
        this._mediaId = 0;
        this._held = [];
        this._busy = false;
        this._settle = new OneShot(glibTimers, () => {
            this._settled = true;
            this._sync();
        });
        this._settled = true;
        this.actor = new St.Button({
            style_class: 'froonty-icon-button froonty-panic-button',
            accessible_name: title,
            can_focus: true,
            track_hover: true,
            child: new St.Icon({icon_name: 'media-playback-pause-symbolic'}),
        });
        this.actor.connect('clicked', () => this._toggle());
        this._sync();
    }

    destroy() {
        this._destroyed = true;
        this._settle.stop();
        this.setActive(false);
        this.actor.destroy();
    }

    setActive(active) {
        if (active === Boolean(this._media))
            return;
        if (active) {
            this._media = acquireMedia(this._ctx);
            this._mediaId = this._media.connect('changed', () => this._sync());
        } else {
            this._media.disconnect(this._mediaId);
            this._mediaId = 0;
            this._media = null;
            releaseMedia();
        }
        this._sync();
    }

    /** Players it paused that are still paused (tests). */
    get held() {
        return this._held;
    }

    async _toggle() {
        const media = this._media;
        if (!media || this._busy)
            return;
        this._busy = true;
        try {
            if (this._held.length) {
                const held = this._held;
                this._held = [];
                this._sync();
                await media.resume(held);
            } else {
                const paused = await media.pauseAll();
                // Disabled meanwhile: no timer, no actor to touch.
                if (this._destroyed)
                    return;
                this._held = paused;
                this._settled = false;
                this._settle.restart(SETTLE_MS);
            }
        } finally {
            this._busy = false;
            if (!this._destroyed)
                this._sync();
        }
    }

    _sync() {
        const media = this._media;
        // A held player that plays again (once its pause was seen), or is
        // gone, drops out.
        if (media?.ready && !this._busy) {
            this._held = this._held.filter(entry => {
                if (media.stillPaused(entry)) {
                    entry.seenPaused = true;
                    return true;
                }
                return !entry.seenPaused && !this._settled && media.hasPlayer(entry);
            });
        }
        this.actor.checked = this._held.length > 0;
        this.actor.reactive = Boolean(media) &&
            (this._held.length > 0 || media.sources.length > 0);
    }
}
