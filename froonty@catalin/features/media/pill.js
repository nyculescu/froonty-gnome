// SPDX-License-Identifier: GPL-3.0-or-later
// Music on the collapsed pill (docs/features/media.md §In the island):
//
//   ( [art] [pad] 14:35 [•] [▁▃▂] )      wings, while a song plays
//   ( [art]  Title · Artist      )        a new song's notice, 3 s
//
// The wings show while media-show-in-pill is on, the shown song plays,
// the island is collapsed and on screen (not over a fullscreen window).
// They have equal widths, so the time stays centered. They appear after
// the pill has grown (if it needs to), and fade out before it shrinks
// back. A new song (MediaService 'track-started', already debounced)
// briefly replaces the time with its title (media-track-notice).
// Two-finger swipes on the pill change song (media-gestures).
//
// The island's pill accessory interface: leading, trailing, showing,
// peekText, accessibleText, tabId, setPillShown(), handleScroll(),
// destroy(), signal 'changed'. Holds the shared Media service while it
// exists.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Emitter} from '../../core/emitter.js';
import {ArtFrame} from './artFrame.js';
import {MediaBars} from './bars.js';
import {feedSwipe, nudge} from './gesture.js';
import {OneShot, PEEK_MS, SwipeTracker, glibTimers, peekText, pillAccessibleText, tintCss} from './model.js';
import {acquireMedia, releaseMedia} from './shared.js';

const WING_GAP = 8;
const BARS_WIDTH = 3 * 2.5 + 2 * 2;

export class MediaPillAccessory extends Emitter {
    /**
     * @param {object} ctx feature context {settings, memory}
     * @param {object} island {pill}: the pill, for its colour behind the art
     */
    constructor(ctx, {pill}) {
        super();
        this._settings = ctx.settings;
        this._pill = pill;
        this._media = acquireMedia(ctx);
        this._shown = false;
        this._wings = false;
        this._wantingArt = false;
        this._swipe = new SwipeTracker();
        this._peek = new OneShot(glibTimers, () => this._endPeek());
        this.tabId = 'media';
        /** True while the wings take room on the pill. */
        this.showing = false;
        /** A new song's notice in place of the time, or null. */
        this.peekText = null;
        this._accessibleText = null;

        this._art = new ArtFrame({
            halo: false,
            background: () => {
                const color = this._pill.get_theme_node().get_background_color();
                return {red: color.red, green: color.green, blue: color.blue, alpha: 255};
            },
        });
        this.leading = new St.Widget({
            style_class: 'froonty-media-wing',
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
            opacity: 0,
        });
        this._art.x_align = Clutter.ActorAlign.START;
        this.leading.add_child(this._art);
        this._bars = new MediaBars({count: 3, barWidth: 2.5, height: 12, gap: 2});
        this._bars.x_align = Clutter.ActorAlign.END;
        this.trailing = new St.Widget({
            style_class: 'froonty-media-wing',
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
            opacity: 0,
        });
        this.trailing.add_child(this._bars);

        this._ids = [
            [this._media, this._media.connect('changed', () => this._sync())],
            [this._media, this._media.connect('art-changed', () => this._syncArt())],
            [this._media, this._media.connect('track-started', (_m, info) => this._onTrackStarted(info))],
            [this._pill, this._pill.connect('notify::hover', () => this._art.repaintCorners())],
            [this._pill, this._pill.connect('notify::height', () => this._sizeWings())],
        ];
        for (const key of ['media-animate-bars', 'media-show-in-pill']) {
            this._ids.push([this._settings,
                this._settings.connect(`changed::${key}`, () => this._sync())]);
        }
        this._sizeWings();
        this._sync();
    }

    destroy() {
        this._peek.stop();
        for (const [object, id] of this._ids)
            object.disconnect(id);
        this._ids = [];
        if (this._wantingArt)
            this._media.wantArt(false);
        this._wantingArt = false;
        this._media = null;
        releaseMedia();
        this.leading.destroy();
        this.trailing.destroy();
    }

    /** The island tells whether the collapsed pill is on screen. */
    setPillShown(shown) {
        if (shown === this._shown)
            return;
        this._shown = shown;
        if (!shown) {
            // Expanding (or fullscreen): no notice, no wings.
            this._endPeek();
        }
        this._sync();
    }

    /**
     * A scroll on the collapsed pill: a two-finger swipe changes song.
     *
     * @returns {boolean} whether it was used
     */
    handleScroll(event) {
        const playback = this._media?.playback;
        if (!this.showing || !playback || !this._settings.get_boolean('media-gestures'))
            return false;
        const action = feedSwipe(this._swipe, event);
        if (action === null)
            return false;
        const context = this._media.context();
        if (action && this._media.allowed(context)) {
            if (action === 'next')
                this._media.next(context);
            else
                this._media.previous(context);
            nudge(this.leading, action);
        }
        return true;
    }

    // The art fits the pill's height; the trailing wing is as wide as the
    // leading one, so the time stays centered.
    _sizeWings() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const height = this._pill.height / scale || 28;
        const side = Math.round(Math.min(22, Math.max(12, height - 10)));
        this._art.setSize(side * scale, 5 * scale);
        const width = Math.max(side, BARS_WIDTH) + WING_GAP - 5;
        this.leading.width = this.trailing.width = width * scale;
    }

    get _wanted() {
        const playback = this._media?.playback;
        return Boolean(this._shown && playback?.playing &&
            this._settings.get_boolean('media-show-in-pill'));
    }

    _sync() {
        if (!this._media)
            return;
        const playback = this._media.playback;
        if (this.peekText && !playback?.playing) {
            this._endPeek();
            return;
        }
        const wanted = this._wanted;
        this._bars.setEnabled(this._settings.get_boolean('media-animate-bars'));
        this._bars.setPlaying(Boolean(playback?.playing) && wanted);
        this._bars.opacity = wanted ? 255 : 0;
        this._setWings(wanted || Boolean(this.peekText), true);
        this._syncAccessible();
    }

    _syncArt() {
        const art = this._media?.art;
        const playback = this._media?.playback;
        if (!art)
            return;
        this._art.setImage(art.state === 'ready' ? art.pixbuf : null, playback?.app?.get_icon?.() ?? null);
        this._bars.setColor(tintCss(art.state === 'ready' ? art.tint : null));
    }

    _setWantArt(want) {
        if (want === this._wantingArt)
            return;
        this._wantingArt = want;
        this._media.wantArt(want);
        if (want)
            this._syncArt();
    }

    // Appear: room first (the island eases the width on 'changed'), then
    // the wings fade in. Depart: fade out, then the room goes.
    _setWings(on, animate) {
        if (on === this._wings)
            return;
        this._wings = on;
        const duration = animate ? this._settings.get_int('animation-duration') : 0;
        for (const wing of [this.leading, this.trailing])
            wing.remove_all_transitions();
        if (on) {
            this._setWantArt(true);
            const wasShowing = this.showing;
            for (const wing of [this.leading, this.trailing]) {
                wing.show();
                wing.ease({
                    opacity: 255,
                    // A departure reversed: back at once; else after the room.
                    delay: wasShowing ? 0 : duration,
                    duration,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
            if (!wasShowing) {
                this.showing = true;
                this._accessibleText = this.accessibleText;
                this.emit('changed');
            }
        } else {
            const done = () => {
                if (this._wings)
                    return;
                for (const wing of [this.leading, this.trailing])
                    wing.hide();
                this._setWantArt(false);
                if (this.showing) {
                    this.showing = false;
                    this._accessibleText = this.accessibleText;
                    this.emit('changed');
                }
            };
            if (duration > 0 && this.leading.visible) {
                this.leading.ease({
                    opacity: 0, duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD, onComplete: done,
                });
                this.trailing.ease({opacity: 0, duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            } else {
                for (const wing of [this.leading, this.trailing])
                    wing.opacity = 0;
                done();
            }
        }
    }

    _onTrackStarted({title, artist}) {
        const playback = this._media?.playback;
        if (!this._settings.get_boolean('media-track-notice') || !this._shown ||
            !playback?.playing || !title)
            return;
        this.peekText = peekText({title, artist});
        this._peekArtist = artist;
        this._peekTitle = title;
        this._peek.restart(PEEK_MS);
        this._accessibleText = this.accessibleText;
        this._sync();
        this.emit('changed');
    }

    _endPeek() {
        this._peek.stop();
        if (!this.peekText)
            return;
        this.peekText = null;
        this._accessibleText = this.accessibleText;
        this._sync();
        this.emit('changed');
    }

    /** What the pill's accessible name adds (the song), or null. */
    get accessibleText() {
        const playback = this._media?.playback;
        if (this.peekText)
            return pillAccessibleText({title: this._peekTitle, artist: this._peekArtist, peek: true}, _);
        if (this.showing && playback)
            return pillAccessibleText({title: playback.track.title, artist: playback.track.artist}, _);
        return null;
    }

    // The pill's name follows the song (the island reads it on 'changed').
    _syncAccessible() {
        const text = this.accessibleText;
        if (text === this._accessibleText)
            return;
        this._accessibleText = text;
        this.emit('changed');
    }
}
