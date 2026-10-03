// SPDX-License-Identifier: GPL-3.0-or-later
// The Media service (docs/features/media.md): one per Shell, shared by
// the tab, the pill and the "Pause all media" panic button (shared.js).
// No St.
//
// It turns the players the watcher sees (mpris.js) into what is shown:
//
// - sources: the players with a song, one entry per player (mirrors merged);
// - playback: the source shown, chosen by the user or automatically
//   (model.preferred), with its song, state and capabilities;
// - smoothing: a song that vanishes for a moment (a player moving to the
//   next) stays shown 1.5 s (gap hold); a chosen player without a song keeps
//   the choice 5 s (grace); the old cover stays up to 1.5 s for the new one;
// - position: read only for the shown source and only while the tab is on
//   screen (watchPosition), extrapolated by the rate in between, with a
//   display tick only while it plays;
// - commands: each carries the context it was rendered from ({key, owner,
//   identity, revision}) and is re-validated against the player before it
//   is sent, to that owner only.
//
// Emits 'changed' (anything shown), 'position-changed', 'tick' (the shown
// second changed), 'art-changed' and 'track-started' ({key, title, artist},
// once per new song, 0.5 s after it started playing).
//
// Design adapted from vorssaint-utils (GPL-3.0-or-later).

import Gio from 'gi://Gio';

import {Emitter} from '../../core/emitter.js';
import {ArtLoader} from './art.js';
import {Fetcher, isCancelled} from './fetch.js';
import {MprisWatcher, PLAYER, ROOT} from './mpris.js';
import {
    ART_GRACE_MS, GAP_MS, GRACE_MS, MAX_SOURCES, NOTICE_MS, STUCK_CHECK_MS, WEEK_US,
    NewSongDetector, OneShot, decodeMetadata, decodePosition, displayNames, glibTimers,
    isMusicApp, latestPlaying, mergeMirrors, planSeek, playPauseCommand, playerName, positionUs,
    preferred, sortSources, tickDelay, trackIdentity,
} from './model.js';

export const INCLUDE_OTHERS_KEY = 'media-include-other-players';
export const REMOTE_ART_KEY = 'media-remote-art';

const NO_ART = Object.freeze({state: 'none', pixbuf: null, tint: null, owner: null, identity: null});

/** Without GNOME Shell (unit tests): no apps. */
export const NO_APPS = {
    lookup: () => null,
    name: () => null,
    categories: () => [],
    activate: () => {},
};

export class MediaService extends Emitter {
    /**
     * @param {object} options
     * @param {Gio.Settings} options.settings
     * @param {object} [options.memory] the extension's in-memory object;
     *   `memory.media` keeps the choice across screen locks
     * @param {object} [options.apps] apps.js adapter
     * @param {MprisWatcher} [options.watcher]
     * @param {object} [options.timers] model.glibTimers or a fake
     * @param {Function} [options.artSide] () → cover decode size (px)
     * @param {string} [options.userAgent]
     * @param {ArtLoader} [options.artLoader]
     * @param {Fetcher} [options.fetcher]
     */
    constructor({settings, memory = {}, apps = NO_APPS, watcher = null, timers = glibTimers,
        artSide = () => 200, userAgent = 'Froonty', artLoader = null, fetcher = null}) {
        super();
        this._settings = settings;
        memory.media ??= {chosen: null, followed: null, latestPlayed: null};
        this._memory = memory.media;
        this._apps = apps;
        this._watcherOption = watcher;
        this._timers = timers;
        this._artSide = artSide;
        this._userAgent = userAgent;
        this._artLoaderOption = artLoader;
        this._fetcherOption = fetcher;
        this._started = false;
        this._reset();
    }

    _reset() {
        /** Sources for the picker: [{key, owner, pid, displayName, playing, isMusic, hasTrack}]. */
        this.sources = [];
        /** The source shown, or null (see _evaluate). */
        this.playback = null;
        /** Nothing known yet: discovery, or just after a manual choice. */
        this.awaiting = true;
        /** The latest command failed (cleared by the next one or a new song). */
        this.commandFailed = false;
        /** Increments on every change of the shown song or source. */
        this.revision = 0;
        /** The shown cover: {state: 'ready'|'blocked'|'none', pixbuf, tint}. */
        this.art = NO_ART;
        this._samples = new Map(); // owner → {us, atUs, playing, rate, identity, valid}
        this._unreliable = new Map(); // owner → the song whose Position stays 0 while playing
        this._seeks = new Map(); // owner → Seeked count
        this._appCache = new Map();
        this._first = true;
        this._gapDone = false;
        this._watching = 0;
        this._artUsers = 0;
        this._artRequest = null;
        this._artPending = null;
        this._artCancellable = null;
        this._readToken = 0;
        this._stuckFor = null;
        this._pendingSeek = null;
        this._seeking = null;
        this._noticeFor = null;
        this._evalId = 0;
    }

    get started() {
        return this._started;
    }

    /** The initial discovery of players settled. */
    get ready() {
        return this._watcher?.ready ?? false;
    }

    /** The watcher (tests reach the bus through it). */
    get watcher() {
        return this._watcher;
    }

    /** The shared fetcher (lyrics use it too); its session is made lazily. */
    get fetcher() {
        return this._fetcher;
    }

    start() {
        if (this._started)
            return;
        this._started = true;
        const timers = this._timers;
        this._gap = new OneShot(timers, () => {
            // Expired: the empty reading now counts (not held again).
            this._gapDone = true;
            this._evaluate();
            this._gapDone = false;
        });
        this._grace = new OneShot(timers, () => {
            this._memory.chosen = null;
            this._evaluate();
        });
        this._artGrace = new OneShot(timers, () => this._artGraceExpired());
        this._notice = new OneShot(timers, () => this._noticeFired());
        this._stuck = new OneShot(timers, () => this._checkStuck());
        this._tick = new OneShot(timers, () => {
            this.emit('tick');
            this._syncTick();
        });
        this._detector = new NewSongDetector();
        this._watcher = this._watcherOption ?? new MprisWatcher({timers});
        this._fetcher = this._fetcherOption ?? new Fetcher({userAgent: this._userAgent});
        this._artLoader = this._artLoaderOption ?? new ArtLoader({fetcher: this._fetcher});
        this._watcherIds = [
            this._watcher.connect('changed', () => this._evaluate()),
            this._watcher.connect('ready', () => this._evaluate()),
            this._watcher.connect('seeked', (_w, player, us) => this._onSeeked(player, us)),
        ];
        this._settingsIds = [
            this._settings.connect(`changed::${INCLUDE_OTHERS_KEY}`, () => this._evaluate()),
            this._settings.connect(`changed::${REMOTE_ART_KEY}`, () => this._onRemoteArtChanged()),
        ];
        this._watcher.start();
        this._evaluate();
    }

    stop() {
        if (!this._started)
            return;
        this._started = false;
        for (const id of this._watcherIds)
            this._watcher.disconnect(id);
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._watcherIds = this._settingsIds = [];
        this._watcher.stop();
        for (const timer of [this._gap, this._grace, this._artGrace, this._notice, this._stuck, this._tick])
            timer.stop();
        if (this._evalId)
            this._timers.remove(this._evalId);
        this._artCancellable?.cancel();
        this._fetcher.destroy();
        this._artLoader.clearRemote();
        this._detector.reset();
        this._reset();
        if (!this._watcherOption)
            this._watcher = null;
    }

    // ------------------------------------------------------------ choice

    /** True while no source is chosen by hand. */
    get automatic() {
        return !this._memory.chosen;
    }

    /** The chosen source's key (also during its grace), or null. */
    get chosenKey() {
        return this._memory.chosen?.key ?? null;
    }

    /**
     * Shows a source chosen by hand, or (null) the automatic choice again.
     * Controls of the previous context stop acting at once.
     *
     * @param {?string} key a source's key
     */
    select(key) {
        if (!this._started)
            return;
        const chosen = this._memory.chosen;
        if (key === null && !chosen)
            return;
        if (key !== null && key === chosen?.key)
            return;
        const source = key === null ? null : this.sources.find(s => s.key === key);
        // A stale menu: the source is gone.
        if (key !== null && !source)
            return;
        // The one already shown: now chosen by hand, the context unchanged.
        if (key !== null && key === this.playback?.key) {
            this._memory.chosen = {key, owner: source.owner};
            this.emit('changed');
            return;
        }
        this._memory.chosen = source ? {key, owner: source.owner} : null;
        this._grace.stop();
        this._gap.stop();
        this._notice.stop();
        this._stuck.stop();
        this._pendingSeek = null;
        this._readToken++;
        this.playback = null;
        this.awaiting = true;
        this.commandFailed = false;
        this.revision++;
        this._first = true;
        this._setArt(NO_ART);
        this._artRequest = null;
        this._artCancellable?.cancel();
        this._syncTick();
        this.emit('changed');
        if (!this._evalId) {
            this._evalId = this._timers.idle(() => {
                this._evalId = 0;
                this._evaluate();
            });
        }
    }

    // ------------------------------------------------------------ evaluation

    _appFor(player) {
        const id = `${player.name}\n${player.owner}\n${player.root.desktopEntry}`;
        let app = this._appCache.get(id) ?? null;
        if (!app) {
            app = this._apps.lookup({desktopEntry: player.root.desktopEntry, pid: player.pid});
            if (app)
                this._appCache.set(id, app);
        }
        return app;
    }

    _describe(entry) {
        const player = entry.player;
        const app = this._appFor(player);
        const name = playerName({
            appName: app ? this._apps.name(app) : null,
            identity: player.root.identity,
            busName: entry.key,
        });
        return {
            key: entry.key,
            owner: entry.owner,
            pid: entry.pid,
            name,
            title: player.track?.title ?? null,
            playing: player.props.playing,
            playingSinceUs: player.playingSinceUs,
            isMusic: isMusicApp({categories: app ? this._apps.categories(app) : [], busName: entry.key}),
            hasTrack: player.track !== null,
            app,
        };
    }

    // A playing player's sample is extrapolated: when its state or rate
    // changes, the position so far becomes the new base.
    _rebaseSamples(players, now) {
        const owners = new Set([...players.values()].map(p => p.owner));
        for (const [owner, sample] of this._samples) {
            if (!owners.has(owner))
                this._samples.delete(owner);
        }
        for (const player of players.values()) {
            const sample = this._samples.get(player.owner);
            if (!sample)
                continue;
            if (sample.identity !== trackIdentity(player.track) && !this.playback?.held) {
                sample.valid = false;
                continue;
            }
            const {playing, rate} = player.props;
            if (sample.playing !== playing || sample.rate !== rate) {
                Object.assign(sample, {
                    us: positionUs(sample, now, player.track?.lengthUs ?? null),
                    atUs: now,
                    playing,
                    rate,
                });
            }
        }
    }

    _evaluate() {
        if (!this._started)
            return;
        const watcher = this._watcher;
        const players = watcher.players;
        const now = this._timers.now();
        this._rebaseSamples(players, now);
        if (!watcher.ready) {
            this.awaiting = true;
            this.emit('changed');
            return;
        }

        // The user's choice: released when its owner leaves or the name
        // gets another; kept 5 s while its player has no song.
        let chosen = this._memory.chosen;
        if (chosen) {
            const player = players.get(chosen.key);
            if (!player || player.owner !== chosen.owner) {
                chosen = this._memory.chosen = null;
                this._grace.stop();
            } else if (player.track) {
                this._grace.stop();
            } else {
                this._grace.start(GRACE_MS);
            }
        }

        const entries = [...players.values()].map(player =>
            ({key: player.name, owner: player.owner, pid: player.pid, track: player.track, player}));
        const merged = mergeMirrors(entries).filter(e => e.track || e.key === chosen?.key);
        const described = sortSources(merged).slice(0, MAX_SOURCES).map(e => this._describe(e));
        const labels = displayNames(described);
        const sources = described.map(s => ({...s, displayName: labels.get(s.key)}));

        const latestKey = latestPlaying(sources, this._memory.latestPlayed);
        if (sources.some(s => s.playing && s.playingSinceUs !== null))
            this._memory.latestPlayed = latestKey;
        let key = preferred(sources, {
            chosenKey: chosen?.key ?? null,
            followedKey: this._memory.followed,
            latestPlayingKey: latestKey,
            includeOthers: this._settings.get_boolean(INCLUDE_OTHERS_KEY),
        });

        // Gap hold: the shown song vanished from a player that is still
        // there; keep it 1.5 s (not extended) unless a real reading comes.
        const previous = this.playback;
        let held = false;
        if (previous) {
            const player = players.get(previous.key);
            const sameOwner = player && player.owner === previous.owner;
            if (sameOwner && !player.track && !this._gapDone)
                this._gap.start(GAP_MS);
            else if (!sameOwner || player.track)
                this._gap.stop();
            if (this._gap.active) {
                key = previous.key;
                held = true;
            }
        }

        this.sources = sources;
        this.awaiting = false;
        const player = key ? players.get(key) : null;
        if (!player) {
            this._show(null, {previous, now});
            return;
        }
        const track = held ? previous.track : player.track;
        const source = sources.find(s => s.key === key) ?? this._describe(
            {key, owner: player.owner, pid: player.pid, track, player});
        this._show({
            key,
            owner: player.owner,
            pid: player.pid,
            name: source.displayName ?? source.name,
            app: source.app,
            isMusic: source.isMusic,
            track,
            identity: trackIdentity(track),
            held,
            status: player.props.status,
            playing: player.props.playing,
            rate: player.props.rate,
            caps: {...player.props},
            canRaise: player.root.canRaise,
            hasTrackList: player.root.hasTrackList,
            canOpen: Boolean(source.app) || player.root.canRaise,
        }, {previous, now});
    }

    _show(next, {previous, now}) {
        const sourceChanged = !next || !previous ||
            next.key !== previous.key || next.owner !== previous.owner;
        const identityChanged = !sourceChanged && next.identity !== previous.identity;
        if (next) {
            if (sourceChanged || identityChanged) {
                this.revision++;
                this.commandFailed = false;
                this._pendingSeek = null;
                // A new song starts from 0 until its position is read (or
                // a Seeked for it already told).
                if (this._samples.get(next.owner)?.identity !== next.identity) {
                    this._samples.set(next.owner, {
                        us: 0, atUs: now, playing: next.playing, rate: next.rate,
                        identity: next.identity, valid: false,
                    });
                }
            }
            next.revision = this.revision;
            if (sourceChanged)
                this._memory.followed = next.key;
        } else if (previous) {
            this.revision++;
        }
        const statusChanged = next && previous && !sourceChanged && !identityChanged &&
            (next.status !== previous.status || next.rate !== previous.rate);
        this.playback = next;

        // New song notice: the first reading after start or a manual
        // choice only records.
        const first = this._first;
        this._first = false;
        if (next && !next.held && this._detector.isNewSong({
            key: next.key, title: next.track.title, artist: next.track.artist, playing: next.playing,
        }, first)) {
            this._noticeFor = {key: next.key, identity: next.identity};
            this._notice.restart(NOTICE_MS);
        }

        if (this._watching > 0 && next && (sourceChanged || identityChanged || statusChanged))
            this._readPosition();
        this._syncArt({sourceChanged, identityChanged});
        this._syncTick();
        this.emit('changed');
    }

    _noticeFired() {
        const playback = this.playback;
        const wanted = this._noticeFor;
        this._noticeFor = null;
        if (!playback || !wanted || playback.key !== wanted.key ||
            playback.identity !== wanted.identity || !playback.playing)
            return;
        this.emit('track-started', {
            key: playback.key,
            title: playback.track.title,
            artist: playback.track.artist,
        });
    }

    // ------------------------------------------------------------ position

    /**
     * Read the shown source's position while `on` (the tab on screen);
     * reference-counted.
     */
    watchPosition(on) {
        const before = this._watching;
        this._watching = Math.max(0, this._watching + (on ? 1 : -1));
        if (before === 0 && this._watching > 0)
            this._readPosition();
        if (this._watching === 0) {
            this._stuck?.stop();
            this._readToken++;
        }
        this._syncTick();
    }

    get watching() {
        return this._watching > 0;
    }

    /** Whether the display tick runs (tests, the design budget). */
    get ticking() {
        return this._tick?.active ?? false;
    }

    _playerOf(context) {
        const player = this._watcher?.players.get(context?.key);
        return player && player.owner === context.owner ? player : null;
    }

    /** The shown source's player (the queue reads its TrackList). */
    get player() {
        return this.playback ? this._playerOf(this.playback) : null;
    }

    /** True when the shown song's position is known (and believable). */
    get hasPosition() {
        const playback = this.playback;
        const sample = playback && this._samples.get(playback.owner);
        return Boolean(sample?.valid && sample.identity === playback.identity &&
            this._unreliable.get(playback.owner) !== playback.identity);
    }

    /** The shown song's position now, µs (0 when unknown). */
    positionUs(now = this._timers.now()) {
        const playback = this.playback;
        const sample = playback && this._samples.get(playback.owner);
        if (!sample || sample.identity !== playback.identity)
            return 0;
        return positionUs(sample, now, playback.track.lengthUs);
    }

    /** {playing, hasPosition, rate, positionS, lengthS} of the shown song. */
    get timing() {
        const playback = this.playback;
        return {
            playing: playback?.playing ?? false,
            hasPosition: this.hasPosition,
            rate: playback?.rate ?? 1,
            positionS: this.positionUs() / 1e6,
            lengthS: (playback?.track.lengthUs ?? 0) / 1e6,
        };
    }

    async _readPosition({check = true} = {}) {
        const playback = this.playback;
        const player = playback && !playback.held && this._playerOf(playback);
        if (!player || this._watching === 0)
            return;
        const token = ++this._readToken;
        let us = null;
        try {
            us = decodePosition(await player.get(PLAYER, 'Position'));
        } catch (e) {
            if (isCancelled(e))
                return;
        }
        const current = this.playback;
        if (!this._started || token !== this._readToken || !current ||
            current.owner !== playback.owner || current.identity !== playback.identity)
            return;
        const owner = current.owner;
        this._samples.set(owner, {
            us: us ?? 0,
            atUs: this._timers.now(),
            playing: player.props.playing,
            rate: player.props.rate,
            identity: current.identity,
            valid: us !== null,
        });
        if (us > 0)
            this._unreliable.delete(owner);
        // Some players (reportedly Spotify) always answer 0: check once.
        if (check && us === 0 && player.props.playing && this._unreliable.get(owner) !== current.identity) {
            this._stuckFor = {owner, identity: current.identity, seeks: this._seeks.get(owner) ?? 0};
            this._stuck.restart(STUCK_CHECK_MS);
        }
        this._positionChanged();
    }

    async _checkStuck() {
        const wanted = this._stuckFor;
        this._stuckFor = null;
        const playback = this.playback;
        const player = playback && this._playerOf(playback);
        if (!wanted || !player || player.owner !== wanted.owner ||
            playback.identity !== wanted.identity || !playback.playing || this._watching === 0)
            return;
        let us = null;
        try {
            us = decodePosition(await player.get(PLAYER, 'Position'));
        } catch {
            return;
        }
        if (!this._started || this.playback?.identity !== wanted.identity)
            return;
        if (us === 0 && player.props.playing && (this._seeks.get(wanted.owner) ?? 0) === wanted.seeks) {
            this._unreliable.set(wanted.owner, wanted.identity);
            this._syncTick();
            this.emit('changed');
            return;
        }
        if (us !== null) {
            this._samples.set(wanted.owner, {
                us, atUs: this._timers.now(), playing: player.props.playing, rate: player.props.rate,
                identity: wanted.identity, valid: true,
            });
            this._positionChanged();
        }
    }

    _onSeeked(player, us) {
        const owner = player.owner;
        const position = Math.min(Math.max(0, us), player.track?.lengthUs ?? WEEK_US);
        this._samples.set(owner, {
            us: position,
            atUs: this._timers.now(),
            playing: player.props.playing,
            rate: player.props.rate,
            identity: trackIdentity(player.track),
            valid: true,
        });
        this._seeks.set(owner, (this._seeks.get(owner) ?? 0) + 1);
        if (position > 0)
            this._unreliable.delete(owner);
        if (this.playback?.owner === owner)
            this._positionChanged();
    }

    _positionChanged() {
        // The next second boundary moved.
        this._tick.stop();
        this._syncTick();
        this.emit('position-changed');
    }

    // A display tick, not a poll: it reads nothing, and runs only while
    // the tab is on screen and the shown song plays with a known length
    // and position. Each fires at the next whole second shown.
    _syncTick() {
        if (!this._tick)
            return;
        const playback = this.playback;
        const wanted = this._started && this._watching > 0 && playback && playback.playing &&
            !playback.held && playback.track.lengthUs > 0 && this.hasPosition;
        if (!wanted) {
            this._tick.stop();
            return;
        }
        if (!this._tick.active)
            this._tick.restart(tickDelay(this.positionUs() / 1e6, playback.rate));
    }

    // ------------------------------------------------------------ commands

    /** What a control rendered now acts on: {key, owner, identity, revision}. */
    context() {
        const playback = this.playback;
        return playback ? {
            key: playback.key,
            owner: playback.owner,
            identity: playback.identity,
            revision: playback.revision,
        } : null;
    }

    /** Whether controls rendered with `context` may act now. */
    allowed(context) {
        const playback = this.playback;
        return Boolean(this._started && context && playback && !playback.held && !this.awaiting &&
            context.revision === playback.revision && context.owner === playback.owner &&
            context.key === playback.key);
    }

    // Re-reads the song from the player itself and sends the command only
    // if it is still the one the control showed. To that owner only.
    async _send(context, method, params = null) {
        if (!this.allowed(context))
            return false;
        const player = this._playerOf(context);
        if (!player)
            return false;
        if (this.commandFailed) {
            this.commandFailed = false;
            this.emit('changed');
        }
        try {
            const metadata = decodeMetadata(await player.get(PLAYER, 'Metadata'));
            if (trackIdentity(metadata) !== context.identity)
                throw new Error('the song changed');
            await player.call(method, params);
            return true;
        } catch (e) {
            if (isCancelled(e) || !this._started)
                return false;
            if (this.playback?.revision === context.revision) {
                this.commandFailed = true;
                this.emit('changed');
            }
            return false;
        }
    }

    /** Play or pause (model.playPauseCommand). */
    playPause(context) {
        const playback = this.playback;
        const method = playback && playPauseCommand(playback.caps);
        return method ? this._send(context, method) : Promise.resolve(false);
    }

    next(context) {
        const caps = this.playback?.caps;
        return caps?.canControl && caps.canGoNext !== false
            ? this._skip(context, 'Next') : Promise.resolve(false);
    }

    previous(context) {
        const caps = this.playback?.caps;
        return caps?.canControl && caps.canGoPrevious !== false
            ? this._skip(context, 'Previous') : Promise.resolve(false);
    }

    async _skip(context, method) {
        const ok = await this._send(context, method);
        if (ok && this.allowed(context))
            await this._readPosition({check: false});
        return ok;
    }

    /**
     * Seeks the shown song. One seek at a time per source; a newer target
     * replaces one still waiting (latest wins).
     *
     * @param {number} targetSeconds
     * @param {object} context
     */
    seek(targetSeconds, context) {
        if (!this.allowed(context) || !planSeek({
            track: this.playback.track, caps: this.playback.caps,
            targetUs: targetSeconds * 1e6, estimateUs: 0,
        }))
            return Promise.resolve(false);
        this._pendingSeek = {context, targetUs: targetSeconds * 1e6};
        this._seeking ??= this._drainSeeks().finally(() => {
            this._seeking = null;
        });
        return this._seeking;
    }

    async _drainSeeks() {
        let ok = false;
        while (this._pendingSeek) {
            const {context, targetUs} = this._pendingSeek;
            this._pendingSeek = null;
            if (!this.allowed(context))
                return false;
            const plan = planSeek({
                track: this.playback.track,
                caps: this.playback.caps,
                targetUs,
                estimateUs: this.positionUs(),
            });
            if (!plan)
                return false;
            // eslint-disable-next-line no-await-in-loop
            ok = await this._send(context, plan.method, plan.params);
            if (ok && this.allowed(context)) {
                const sample = this._samples.get(context.owner);
                if (sample) {
                    Object.assign(sample, {us: plan.targetUs, atUs: this._timers.now(), valid: true});
                    this._positionChanged();
                }
                // Some players do not emit Seeked: read where it went.
                // eslint-disable-next-line no-await-in-loop
                await this._readPosition({check: false});
            }
        }
        return ok;
    }

    /**
     * Opens the shown player: its app, else the player's own Raise.
     *
     * @returns {boolean} whether anything was asked to open
     */
    raise() {
        const playback = this.playback;
        if (!playback)
            return false;
        if (playback.app) {
            this._apps.activate(playback.app);
            return true;
        }
        const player = this._playerOf(playback);
        if (playback.canRaise && player) {
            player.call('Raise', null, ROOT).catch(() => {});
            return true;
        }
        return false;
    }

    // ------------------------------------------------------------ pause all

    /**
     * Pauses every player that is playing (no song check: "everything").
     *
     * @returns {Promise<object[]>} [{key, owner}] of the ones it paused
     */
    async pauseAll() {
        if (!this._started)
            return [];
        const players = mergeMirrors([...this._watcher.players.values()].map(player =>
            ({key: player.name, owner: player.owner, pid: player.pid, track: player.track, player})))
            .map(e => e.player)
            .filter(p => p.props.playing && p.props.canPause);
        const results = await Promise.allSettled(players.map(p => p.call('Pause')));
        return players.filter((_p, i) => results[i].status === 'fulfilled')
            .map(p => ({key: p.name, owner: p.owner}));
    }

    /** Plays again what pauseAll paused, if still there and still paused. */
    async resume(held) {
        if (!this._started)
            return;
        await Promise.allSettled(held.map(({key, owner}) => {
            const player = this._watcher.players.get(key);
            return player?.owner === owner && player.props.status === 'Paused'
                ? player.call('Play') : null;
        }));
    }

    /** Whether a {key, owner} that pauseAll paused is still paused. */
    stillPaused({key, owner}) {
        const player = this._watcher?.players.get(key);
        return player?.owner === owner && player.props.status === 'Paused';
    }

    /** Whether a {key, owner} is still there (same process). */
    hasPlayer({key, owner}) {
        return this._watcher?.players.get(key)?.owner === owner;
    }

    // ------------------------------------------------------------ art

    /** Load covers while `on` (the tab or the pill shows one); counted. */
    wantArt(on) {
        const before = this._artUsers;
        this._artUsers = Math.max(0, this._artUsers + (on ? 1 : -1));
        if (before === 0 && this._artUsers > 0) {
            this._artRequest = null;
            this._syncArt();
        } else if (this._artUsers === 0) {
            this._artCancellable?.cancel();
            this._artCancellable = null;
            this._artRequest = null;
        }
    }

    _setArt(art) {
        if (art === this.art)
            return;
        this.art = art;
        this.emit('art-changed');
    }

    _syncArt({sourceChanged = false, identityChanged = false} = {}) {
        const playback = this.playback;
        if (!playback) {
            this._artGrace.stop();
            this._artCancellable?.cancel();
            this._artRequest = null;
            this._setArt(NO_ART);
            return;
        }
        if (sourceChanged || (this.art.owner && this.art.owner !== playback.owner)) {
            // Another source: its cover, or nothing, at once.
            this._artGrace.stop();
            this._setArt(NO_ART);
        } else if (identityChanged) {
            // The old cover may stay while the new one loads.
            this._artPending = null;
            if (this.art.state !== 'none')
                this._artGrace.restart(ART_GRACE_MS);
        }
        if (this._artUsers === 0)
            return;
        const remote = this._settings.get_boolean(REMOTE_ART_KEY);
        const url = playback.track.artUrl;
        const request = JSON.stringify([playback.owner, playback.identity, url, remote]);
        if (request === this._artRequest)
            return;
        this._artRequest = request;
        this._artCancellable?.cancel();
        const cancellable = this._artCancellable = new Gio.Cancellable();
        const {owner, identity} = playback;
        this._artLoader.load(url, {remote, side: this._artSide(), cancellable})
            .catch(e => {
                if (!isCancelled(e))
                    console.debug(`Froonty: cover ${url} not loaded: ${e.message}`);
                return {state: isCancelled(e) ? 'cancelled' : 'none'};
            })
            .then(result => {
                if (cancellable.is_cancelled() || result.state === 'cancelled' || !this._started)
                    return;
                const art = {pixbuf: null, tint: null, ...result, owner, identity};
                // A real cover replaces the old one at once; "no cover"
                // waits for the grace to end.
                if (art.state === 'ready' || !this._artGrace.active) {
                    this._artGrace.stop();
                    this._setArt(art);
                } else {
                    this._artPending = art;
                }
            });
    }

    _artGraceExpired() {
        const playback = this.playback;
        const pending = this._artPending;
        this._artPending = null;
        if (!playback)
            return;
        this._setArt(pending?.identity === playback.identity ? pending
            : {...NO_ART, owner: playback.owner, identity: playback.identity});
    }

    _onRemoteArtChanged() {
        if (!this._settings.get_boolean(REMOTE_ART_KEY)) {
            // Off: requests in flight stop, and web covers go.
            this._fetcher.abort();
            this._artLoader.clearRemote();
        }
        this._artRequest = null;
        this._syncArt();
    }
}
