// SPDX-License-Identifier: GPL-3.0-or-later
// Lyrics for the shown song (docs/features/media.md §Lyrics), only while
// the lyrics panel is open. Sources, in order:
//
// 1. xesam:asText from the player (timed if it is LRC, else plain);
// 2. a .lrc file next to a local song (file:// xesam:url), at most 128 KiB;
// 3. lrclib.net, only with media-lyrics-online on: the title, artist,
//    album and length are sent; only an exact match is shown.
//
// state: 'idle', 'consent' (online off and nothing local), 'loading',
// 'unavailable', 'failed' or 'ready'. Emits 'changed'. No St.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Emitter} from '../../core/emitter.js';
import {HttpError, isCancelled} from './fetch.js';
import {
    LRCLIB_URL, LyricsMemory, MAX_LYRICS_BYTES, lrclibMatch, lrclibUrl, lyricsFromText, sidecarPath,
} from './lyrics.js';
import {WEEK_S} from './model.js';

export const ONLINE_KEY = 'media-lyrics-online';

function queryInfo(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.query_info_async('standard::size,standard::type', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, cancellable, (_file, result) => {
                try {
                    resolve(file.query_info_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function loadContents(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.load_contents_async(cancellable, (_file, result) => {
            try {
                resolve(file.load_contents_finish(result)[1]);
            } catch (e) {
                reject(e);
            }
        });
    });
}

export class LyricsService extends Emitter {
    /**
     * @param {object} options
     * @param {Gio.Settings} options.settings
     * @param {MediaService} options.media
     */
    constructor({settings, media}) {
        super();
        this._settings = settings;
        this._media = media;
        this._memory = new LyricsMemory();
        this._open = false;
        this._cancellable = null;
        this._loadingFor = null;
        this._doneFor = null;
        this._ids = [];
        this.state = 'idle';
    }

    /** {lines, plain, instrumental} of the shown song, or null. */
    get lyrics() {
        return this._memory.lyrics;
    }

    /** The user's timing offset (s; positive shows lines later). */
    get offset() {
        return this._memory.offset;
    }

    /** Works only while `open` (the panel on screen). */
    setOpen(open) {
        if (open === this._open)
            return;
        this._open = open;
        if (open) {
            this._doneFor = null;
            this._ids = [
                [this._media, this._media.connect('changed', () => this._sync())],
                [this._settings, this._settings.connect(`changed::${ONLINE_KEY}`, () => this.retry())],
            ];
            this._sync();
        } else {
            for (const [object, id] of this._ids)
                object.disconnect(id);
            this._ids = [];
            this._cancel();
        }
    }

    destroy() {
        this.setOpen(false);
        this._memory.clear();
    }

    /** Asks again (after a failure, or once online lookups were allowed). */
    retry() {
        this._cancel();
        this._doneFor = null;
        this._sync();
    }

    adjust(amount) {
        this._memory.adjust(amount);
        this.emit('changed');
    }

    resetOffset() {
        this._memory.resetOffset();
        this.emit('changed');
    }

    _cancel() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._loadingFor = null;
    }

    _setState(state) {
        this.state = state;
        this.emit('changed');
    }

    _sync() {
        if (!this._open)
            return;
        const playback = this._media.playback;
        if (!playback) {
            // No song: nothing kept (a held gap keeps its playback).
            if (!this._media.awaiting) {
                this._cancel();
                this._memory.clear();
                this._doneFor = null;
            }
            if (this.state !== 'idle')
                this._setState('idle');
            return;
        }
        this._memory.select(playback.identity);
        if (this._memory.lyrics) {
            if (this.state !== 'ready')
                this._setState('ready');
            return;
        }
        // Asked already (or asking): once per song, until "Try again".
        if (this._loadingFor === playback.identity || this._doneFor === playback.identity)
            return;
        this._load(playback);
    }

    async _load(playback) {
        this._cancel();
        const cancellable = this._cancellable = new Gio.Cancellable();
        const identity = this._loadingFor = playback.identity;
        const track = playback.track;
        const durationS = track.lengthUs ? track.lengthUs / 1e6 : WEEK_S;
        this._setState('loading');
        let state = 'ready';
        let lyrics = lyricsFromText(track.asText, durationS);
        try {
            if (!lyrics)
                lyrics = await this._sidecar(track.url, durationS, cancellable);
            if (!lyrics) {
                if (!this._settings.get_boolean(ONLINE_KEY)) {
                    state = 'consent';
                } else {
                    lyrics = await this._online(track, cancellable);
                    state = lyrics ? 'ready' : 'unavailable';
                }
            }
        } catch (e) {
            if (isCancelled(e))
                return;
            state = e instanceof HttpError && e.status === 404 ? 'unavailable' : 'failed';
        }
        if (cancellable.is_cancelled() || this._media.playback?.identity !== identity)
            return;
        this._loadingFor = null;
        this._cancellable = null;
        this._doneFor = identity;
        if (lyrics)
            this._memory.replace(lyrics, identity);
        // Not kept: asking again may find them (the switch, "Try again").
        this._setState(lyrics ? 'ready' : state);
    }

    async _sidecar(url, durationS, cancellable) {
        const path = sidecarPath(url);
        if (!path)
            return null;
        const file = Gio.File.new_for_path(path);
        let info;
        try {
            info = await queryInfo(file, cancellable);
        } catch (e) {
            if (isCancelled(e))
                throw e;
            return null;
        }
        if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_size() > MAX_LYRICS_BYTES)
            return null;
        const bytes = await loadContents(file, cancellable);
        return lyricsFromText(new TextDecoder().decode(bytes), durationS);
    }

    async _online(track, cancellable) {
        const base = GLib.getenv('FROONTY_LRCLIB_URL') || LRCLIB_URL;
        const url = lrclibUrl(track, base);
        // Preconditions not met: no request, no match possible.
        if (!url)
            return null;
        const body = await this._media.fetcher.get(url, {
            maxBytes: MAX_LYRICS_BYTES,
            noRedirect: true,
            cancellable,
        });
        return lrclibMatch(new TextDecoder().decode(body.toArray()), track);
    }
}
