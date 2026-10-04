// SPDX-License-Identifier: GPL-3.0-or-later
// tint() and NewSongDetector follow vorssaint-utils' cover tint and new-song
// rules closely: Copyright (C) 2026 Vorssaint, GPL-3.0-or-later.
//
// Media tab rules (docs/features/media.md): what music and video players
// report over MPRIS, decoded and judged. Pure functions and small state
// holders over GLib only (no St, no D-Bus), so plain gjs unit-tests them.
//
// Design adapted from vorssaint-utils (GPL-3.0-or-later); the rest is
// written from Froonty's own spec.
//
// Players are untrusted: every value is type-checked, trimmed and capped,
// and a wrong type is dropped, never replaced by placeholder text.

import GLib from 'gi://GLib';

export const PREFIX = 'org.mpris.MediaPlayer2.';
/** Bus names never listed: playerctld mirrors other players. */
export const IGNORED = ['org.mpris.MediaPlayer2.playerctld'];
export const NO_TRACK = '/org/mpris/MediaPlayer2/TrackList/NoTrack';
export const WEEK_S = 7 * 24 * 3600;
export const WEEK_US = WEEK_S * 1e6;
export const MAX_TEXT = 300;
export const MAX_NAME_BYTES = 256;
export const MAX_URL = 4096;
export const MAX_AS_TEXT = 128 * 1024;
export const MAX_SOURCES = 16;
/** Players whose bus name tells they are music players (no desktop file). */
export const DAEMON_PLAYERS = ['mpd', 'spotifyd', 'ncspot', 'cmus'];

// Timings (ms) of the smoothing rules, §8 of the spec.
export const GAP_MS = 1500;
export const GRACE_MS = 5000;
export const ART_GRACE_MS = 1500;
export const NOTICE_MS = 500;
export const PEEK_MS = 3000;
export const STUCK_CHECK_MS = 3000;
export const SEEK_HOLD_MS = 1000;
export const SEEK_HOLD_US = 2e6;

const utf8 = new TextEncoder();
const byteLength = text => utf8.encode(text).length;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** Replaces each %s in order (String.prototype.format exists only in the Shell). */
export function subst(template, ...values) {
    let i = 0;
    return template.replace(/%s/g, () => String(values[i++] ?? ''));
}

// Ends `text` at `cap` UTF-16 code units without splitting a surrogate pair.
function cut(text, cap) {
    if (text.length <= cap)
        return text;
    let end = cap;
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff)
        end--;
    return text.slice(0, end);
}

/**
 * Display text from a player: control characters (newlines included)
 * become spaces, then trimmed and capped; empty is null.
 *
 * @param {*} value
 * @param {number} [cap] UTF-16 code units
 * @returns {?string}
 */
export function cleanText(value, cap = MAX_TEXT) {
    if (typeof value !== 'string')
        return null;
    const text = cut(value.replace(/\p{Cc}/gu, ' ').trim(), cap).trimEnd();
    return text || null;
}

// ---------------------------------------------------------------- variants

const typeOf = variant => variant instanceof GLib.Variant ? variant.get_type_string() : null;

function stringOf(variant) {
    return typeOf(variant) === 's' ? variant.get_string()[0] : null;
}

function boolOf(variant) {
    return typeOf(variant) === 'b' ? variant.get_boolean() : null;
}

function numberOf(variant, types) {
    const type = typeOf(variant);
    if (!types.includes(type))
        return null;
    switch (type) {
    case 'x': return Number(variant.get_int64());
    case 't': return Number(variant.get_uint64());
    case 'i': return variant.get_int32();
    case 'u': return variant.get_uint32();
    case 'd': return variant.get_double();
    default: return null;
    }
}

/**
 * An `a{sv}` variant as a Map of its (inner) values; anything else is
 * empty.
 *
 * @param {?GLib.Variant} variant
 * @returns {Map<string, GLib.Variant>}
 */
export function dictEntries(variant) {
    const map = new Map();
    if (typeOf(variant) !== 'a{sv}')
        return map;
    for (let i = 0; i < variant.n_children(); i++) {
        const entry = variant.get_child_value(i);
        map.set(entry.get_child_value(0).get_string()[0],
            entry.get_child_value(1).get_variant());
    }
    return map;
}

// ---------------------------------------------------------------- metadata

function capped(text, cap) {
    return typeof text === 'string' && text.length > 0 && text.length <= cap ? text : null;
}

function trackIdOf(variant) {
    const type = typeOf(variant);
    let id = null;
    if (type === 'o')
        id = variant.get_string()[0];
    // Rhythmbox sends an object path as a plain string.
    else if (type === 's' && GLib.Variant.is_object_path(variant.get_string()[0]))
        id = variant.get_string()[0];
    return id && id !== NO_TRACK ? id : null;
}

function artistOf(variant) {
    const type = typeOf(variant);
    if (type === 's')
        return cleanText(variant.get_string()[0]);
    if (type !== 'as')
        return null;
    const names = variant.get_strv().map(name => cleanText(name)).filter(Boolean);
    return cleanText(names.join(', '));
}

function lengthOf(variant) {
    const value = numberOf(variant, ['x', 't', 'i', 'u', 'd']);
    return value !== null && Number.isFinite(value) && value > 0 ? Math.min(value, WEEK_US) : null;
}

/** Art addresses Froonty may load: file, http and https only. */
function artUrlOf(variant) {
    const url = capped(stringOf(variant), MAX_URL);
    if (!url)
        return null;
    const scheme = GLib.Uri.peek_scheme(url);
    return ['file', 'http', 'https'].includes(scheme) ? url : null;
}

// "file:///music/Some%20Song.flac" → "Some Song"
function titleFromUrl(url) {
    if (!url || GLib.Uri.peek_scheme(url) !== 'file')
        return null;
    try {
        const [path] = GLib.filename_from_uri(url);
        const name = GLib.path_get_basename(path);
        const dot = name.lastIndexOf('.');
        return cleanText(dot > 0 ? name.slice(0, dot) : name);
    } catch {
        return null;
    }
}

/**
 * A player's Metadata (`a{sv}`) as a track, or null when it names none
 * (no title, and no file:// address to take one from).
 *
 * @param {?GLib.Variant} variant
 * @returns {?{trackId, title, artist, album, lengthUs, artUrl, url, asText}}
 */
export function decodeMetadata(variant) {
    const m = dictEntries(variant);
    const url = capped(stringOf(m.get('xesam:url')), MAX_URL);
    const title = cleanText(stringOf(m.get('xesam:title'))) ?? titleFromUrl(url);
    if (!title)
        return null;
    const asText = stringOf(m.get('xesam:asText'));
    return {
        trackId: trackIdOf(m.get('mpris:trackid')),
        title,
        artist: artistOf(m.get('xesam:artist')),
        album: cleanText(stringOf(m.get('xesam:album'))),
        lengthUs: lengthOf(m.get('mpris:length')),
        artUrl: artUrlOf(m.get('mpris:artUrl')),
        url,
        asText: asText && byteLength(asText) <= MAX_AS_TEXT ? asText : null,
    };
}

/**
 * org.mpris.MediaPlayer2.Player properties.
 *
 * @param {Function} get (name) → GLib.Variant or null
 */
export function decodePlayer(get) {
    const raw = stringOf(get('PlaybackStatus'));
    const status = ['Playing', 'Paused', 'Stopped'].includes(raw) ? raw : 'Stopped';
    const rawRate = typeOf(get('Rate')) === 'd' ? get('Rate').get_double() : NaN;
    const rate = Number.isFinite(rawRate) && rawRate > 0 && rawRate <= 16 ? rawRate : 1;
    // Per the MPRIS spec, CanControl false makes every other Can* false.
    const canControl = boolOf(get('CanControl')) ?? true;
    const flag = name => canControl && (boolOf(get(name)) ?? false);
    // Unknown (null) when missing: such a button stays shown.
    const maybe = name => canControl ? boolOf(get(name)) : false;
    const volume = typeOf(get('Volume')) === 'd' ? get('Volume').get_double() : null;
    return {
        status,
        playing: status === 'Playing',
        rate,
        canControl,
        canPlay: flag('CanPlay'),
        canPause: flag('CanPause'),
        canSeek: flag('CanSeek'),
        canGoNext: maybe('CanGoNext'),
        canGoPrevious: maybe('CanGoPrevious'),
        volume: Number.isFinite(volume) ? volume : null,
    };
}

/**
 * org.mpris.MediaPlayer2 (root) properties.
 *
 * @param {Function} get (name) → GLib.Variant or null
 */
export function decodeRoot(get) {
    const entry = stringOf(get('DesktopEntry'));
    const desktopEntry = entry && entry.length <= 255 && !/\p{Cc}/u.test(entry) && entry.trim()
        ? entry.trim() : null;
    return {
        identity: cleanText(stringOf(get('Identity')), 256),
        desktopEntry,
        canRaise: boolOf(get('CanRaise')) ?? false,
        hasTrackList: boolOf(get('HasTrackList')) ?? false,
    };
}

/**
 * What tells one song from the next: position and status never change it.
 *
 * @param {?object} track from decodeMetadata
 * @returns {?string}
 */
export function trackIdentity(track) {
    if (!track)
        return null;
    const seconds = track.lengthUs === null ? null : Math.round(track.lengthUs / 1e6);
    return JSON.stringify([track.trackId, track.title, track.artist, track.album, seconds]);
}

// The same, without the track id: mirrors of one player (VLC) agree on it.
function songIdentity(track) {
    if (!track)
        return null;
    const seconds = track.lengthUs === null ? null : Math.round(track.lengthUs / 1e6);
    return JSON.stringify([track.title, track.artist, track.album, seconds]);
}

/**
 * A Position reading in µs, or null when it is not a usable one.
 *
 * @param {?GLib.Variant} variant
 */
export function decodePosition(variant) {
    const value = numberOf(variant, ['x', 'i', 'u', 't']);
    return value !== null && Number.isFinite(value) && value >= 0 && value <= WEEK_US ? value : null;
}

// ---------------------------------------------------------------- position

/**
 * The position now, extrapolated from a sample by the rate while playing.
 *
 * @param {{us, atUs, playing, rate}} sample
 * @param {number} now monotonic µs
 * @param {?number} lengthUs
 */
export function positionUs(sample, now, lengthUs = null) {
    const elapsed = sample.playing ? Math.max(0, now - sample.atUs) * sample.rate : 0;
    return clamp(sample.us + elapsed, 0, lengthUs ?? WEEK_US);
}

/**
 * How to reach `targetUs`: SetPosition when the track has an id (the
 * player then ignores it if the song changed), else a relative Seek.
 *
 * @returns {?{method: string, params: GLib.Variant, targetUs: number}}
 */
export function planSeek({track, caps, targetUs, estimateUs}) {
    if (!caps?.canSeek || !(track?.lengthUs > 0) || !Number.isFinite(targetUs))
        return null;
    const target = Math.round(clamp(targetUs, 0, track.lengthUs));
    if (track.trackId) {
        return {
            method: 'SetPosition',
            params: new GLib.Variant('(ox)', [track.trackId, target]),
            targetUs: target,
        };
    }
    return {
        method: 'Seek',
        params: new GLib.Variant('(x)', [Math.round(target - estimateUs)]),
        targetUs: target,
    };
}

/**
 * A picture's size from its header (PNG, JPEG, GIF, WebP), before any
 * decoding; null for another or a broken format.
 *
 * @param {Uint8Array} d
 * @returns {?{width: number, height: number}}
 */
export function imageSize(d) {
    const be16 = i => d[i] << 8 | d[i + 1];
    const le16 = i => d[i] | d[i + 1] << 8;
    const le24 = i => d[i] | d[i + 1] << 8 | d[i + 2] << 16;
    const be32 = i => (d[i] << 24 | d[i + 1] << 16 | d[i + 2] << 8 | d[i + 3]) >>> 0;
    const ascii = (i, n) => String.fromCharCode(...d.subarray(i, i + n));
    if (d.length >= 24 && be32(0) === 0x89504E47 && ascii(12, 4) === 'IHDR')
        return {width: be32(16), height: be32(20)};
    if (d.length >= 10 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a'))
        return {width: le16(6), height: le16(8)};
    if (d.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
        switch (ascii(12, 4)) {
        case 'VP8 ':
            return {width: le16(26) & 0x3FFF, height: le16(28) & 0x3FFF};
        case 'VP8L':
            return {
                width: 1 + ((d[22] & 0x3F) << 8 | d[21]),
                height: 1 + ((d[24] & 0x0F) << 10 | d[23] << 2 | (d[22] & 0xC0) >> 6),
            };
        case 'VP8X':
            return {width: 1 + le24(24), height: 1 + le24(27)};
        }
        return null;
    }
    if (d.length >= 4 && d[0] === 0xFF && d[1] === 0xD8) {
        // Markers up to the first frame header (SOF0–SOF15 but DHT, JPG, DAC).
        let i = 2;
        while (i + 9 < d.length) {
            if (d[i] !== 0xFF)
                return null;
            const marker = d[i + 1];
            if (marker === 0xFF) {
                i++;
                continue;
            }
            if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker))
                return {width: be16(i + 7), height: be16(i + 5)};
            i += 2 + be16(i + 2);
        }
    }
    return null;
}

/** Pause or Play, as the player allows; null when it allows neither. */
export function playPauseCommand({playing, canPlay, canPause}) {
    if (playing)
        return canPause ? 'Pause' : null;
    return canPlay ? 'Play' : null;
}

/** "m:ss", or "h:mm:ss" from an hour; clamped to [0, 7 days]. */
export function formatTime(seconds) {
    const total = Math.floor(clamp(Number.isFinite(seconds) ? seconds : 0, 0, WEEK_S));
    const h = Math.floor(total / 3600);
    const m = Math.floor(total % 3600 / 60);
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** "−2:04" (U+2212). */
export function formatRemaining(lengthS, positionS) {
    return `−${formatTime(lengthS - positionS)}`;
}

/**
 * Milliseconds to the next whole second of the shown position.
 *
 * @param {number} positionS
 * @param {number} rate
 */
export function tickDelay(positionS, rate) {
    const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
    const frac = positionS - Math.floor(positionS);
    return clamp(Math.ceil((1 - frac) / r * 1000) + 5, 50, 1100);
}

// ---------------------------------------------------------------- sources

/** Ignored names (playerctld), and anything outside the MPRIS namespace. */
export function isIgnored(name) {
    return typeof name !== 'string' || !name.startsWith(PREFIX) || IGNORED.includes(name);
}

/** "org.mpris.MediaPlayer2.vlc.instance123" → "vlc" */
export function busSuffix(name) {
    return name.startsWith(PREFIX) ? name.slice(PREFIX.length).replace(/\.instance.*$/, '') : name;
}

/**
 * Music apps are followed even when other players are not.
 *
 * @param {object} what
 * @param {string[]} what.categories the app's desktop categories
 * @param {string} what.busName
 */
export function isMusicApp({categories = [], busName = ''}) {
    if (categories.includes('WebBrowser'))
        return false;
    if (categories.includes('Audio') || categories.includes('Music'))
        return true;
    const first = busSuffix(busName).split('.')[0].toLowerCase();
    return DAEMON_PLAYERS.includes(first);
}

/**
 * The name shown for a player: its app's, its Identity, or its bus name.
 * Names over 256 bytes are skipped.
 */
export function playerName({appName = null, identity = null, busName}) {
    for (const name of [appName, identity, busSuffix(busName)]) {
        const clean = cleanText(name, 256);
        if (clean && byteLength(clean) <= MAX_NAME_BYTES)
            return clean;
    }
    return busSuffix(busName).slice(0, 64);
}

const ellipsize = (text, max) => text.length > max ? `${cut(text, max - 1)}…` : text;

/**
 * Display names for a source list; two sources with one name get their
 * song's title after it.
 *
 * @param {object[]} sources each {key, name, title}
 * @returns {Map<string, string>} key → label
 */
export function displayNames(sources) {
    const counts = new Map();
    for (const {name} of sources)
        counts.set(name, (counts.get(name) ?? 0) + 1);
    return new Map(sources.map(({key, name, title}) => [key,
        counts.get(name) > 1 && title ? ellipsize(`${name} · ${title}`, 60) : name]));
}

const byPidThenKey = (a, b) =>
    (a.pid ?? Infinity) - (b.pid ?? Infinity) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** Process id ascending (unknown last), then bus name. */
export function sortSources(sources) {
    return [...sources].sort(byPidThenKey);
}

/**
 * One entry per player: names of one process that report the same song
 * are one player under several names (VLC); different songs stay apart
 * (KDE Connect: one name per phone).
 *
 * @param {object[]} players each {key, pid, track}
 * @returns {object[]} the representatives, in input order
 */
export function mergeMirrors(players) {
    const kept = [];
    const better = (a, b) => {
        const instance = name => /\.instance/.test(name.slice(PREFIX.length));
        if (instance(a.key) !== instance(b.key))
            return instance(a.key) ? b : a;
        if (a.key.length !== b.key.length)
            return a.key.length < b.key.length ? a : b;
        return a.key < b.key ? a : b;
    };
    for (const player of players.filter(p => !isIgnored(p.key))) {
        const index = player.pid === null ? -1 : kept.findIndex(other =>
            other.pid === player.pid && songIdentity(other.track) === songIdentity(player.track));
        if (index < 0)
            kept.push(player);
        else
            kept[index] = better(kept[index], player);
    }
    return kept;
}

/**
 * The source to show automatically, or null.
 *
 * @param {object[]} sources each {key, pid, playing, isMusic, hasTrack}
 * @param {object} rules
 * @param {?string} rules.chosenKey the user's choice
 * @param {?string} rules.focusedKey the player whose window the user
 *   brought up (until another one starts playing)
 * @param {?string} rules.followedKey the source shown last
 * @param {?string} rules.latestPlayingKey the latest to start playing
 * @param {boolean} rules.includeOthers follow browsers and video players
 */
export function preferred(sources, {chosenKey = null, focusedKey = null, followedKey = null,
    latestPlayingKey = null, includeOthers = true} = {}) {
    const byKey = new Map(sources.map(s => [s.key, s]));
    if (chosenKey && byKey.get(chosenKey)?.hasTrack)
        return chosenKey;
    const focused = byKey.get(focusedKey);
    if (focused?.hasTrack && (includeOthers || focused.isMusic))
        return focusedKey;
    const withTrack = sources.filter(s => s.hasTrack);
    // Anything playing comes before anything paused.
    const tiers = [
        withTrack.filter(s => s.playing && s.isMusic),
        includeOthers ? withTrack.filter(s => s.playing && !s.isMusic) : [],
        withTrack.filter(s => s.isMusic),
    ];
    for (const tier of tiers) {
        if (!tier.length)
            continue;
        for (const key of [followedKey, latestPlayingKey]) {
            if (key && tier.some(s => s.key === key))
                return key;
        }
        return [...tier].sort(byPidThenKey)[0].key;
    }
    if (includeOthers && latestPlayingKey && byKey.get(latestPlayingKey)?.hasTrack)
        return latestPlayingKey;
    return null;
}

/**
 * The source that most recently started playing and still plays, else the
 * remembered one (most recently playing) if it is still listed.
 *
 * @param {object[]} sources each {key, playing, playingSinceUs}
 * @param {?string} remembered
 */
export function latestPlaying(sources, remembered = null) {
    let best = null;
    for (const source of sources) {
        if (source.playing && source.playingSinceUs !== null &&
            (!best || source.playingSinceUs > best.playingSinceUs))
            best = source;
    }
    if (best)
        return best.key;
    return remembered && sources.some(s => s.key === remembered) ? remembered : null;
}

// ---------------------------------------------------------------- art

/**
 * How a cover may be loaded: 'file', 'remote', 'blocked' (http(s) while
 * internet covers are off) or null (data: and anything else).
 *
 * @param {?string} url
 * @param {object} options
 * @param {boolean} options.remote media-remote-art
 */
export function artSource(url, {remote = false} = {}) {
    const scheme = url ? GLib.Uri.peek_scheme(url) : null;
    if (scheme === 'file')
        return 'file';
    if (scheme === 'http' || scheme === 'https')
        return remote ? 'remote' : 'blocked';
    return null;
}

/**
 * A colour taken from the cover, stretched so every cover glows alike;
 * null for covers with no real colour of their own (dark or grey).
 *
 * @returns {?{r: number, g: number, b: number}} each in [0, 1]
 */
export function tint(r, g, b) {
    const channels = [r, g, b];
    if (!channels.every(c => Number.isFinite(c) && c >= 0 && c <= 1))
        return null;
    const high = Math.max(...channels);
    const low = Math.min(...channels);
    if (high <= 0.05 || (high - low) / high < 0.12)
        return null;
    const [sr, sg, sb] = channels.map(c => clamp((c - low) / (high - low) * 0.86 + 0.06, 0, 1));
    return {r: sr, g: sg, b: sb};
}

/**
 * The tint of raw pixels (a cover already reduced to 16 × 16): the mean
 * colour, weighted by alpha.
 *
 * @param {Uint8Array} pixels
 * @param {object} layout {width, height, rowstride, nChannels, hasAlpha}
 */
export function tintFromPixels(pixels, {width, height, rowstride, nChannels, hasAlpha}) {
    let r = 0, g = 0, b = 0, weight = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * rowstride + x * nChannels;
            const a = hasAlpha ? pixels[i + 3] / 255 : 1;
            r += pixels[i] * a;
            g += pixels[i + 1] * a;
            b += pixels[i + 2] * a;
            weight += a;
        }
    }
    if (weight <= 0)
        return null;
    return tint(r / weight / 255, g / weight / 255, b / weight / 255);
}

/** CSS rgba() of a tint, or white without one. */
export function tintCss(color, alpha = 1) {
    if (!color)
        return `rgba(255, 255, 255, ${alpha})`;
    const c = v => Math.round(v * 255);
    return `rgba(${c(color.r)}, ${c(color.g)}, ${c(color.b)}, ${alpha})`;
}

// ---------------------------------------------------------------- notices

/**
 * Tells a new song from the updates a playing one keeps sending (pause,
 * seek, cover, the artist filled in a moment later). Each source keeps its
 * own song, so another standing in during a gap changes nothing; a song
 * counts once it plays.
 */
export class NewSongDetector {
    constructor() {
        this._songs = new Map();
    }

    /**
     * @param {?object} reading {key, title, artist, playing}
     * @param {boolean} first the first reading since start or a manual
     *   source change: only records
     */
    isNewSong(reading, first) {
        const title = reading?.key ? cleanText(reading.title) : null;
        if (!title)
            return false;
        const song = {title, artist: cleanText(reading.artist)};
        if (first) {
            this._songs.set(reading.key, song);
            return false;
        }
        if (!reading.playing)
            return false;
        const previous = this._songs.get(reading.key);
        this._songs.set(reading.key, song);
        if (!previous)
            return false;
        const same = previous.title === song.title &&
            (previous.artist === null || song.artist === null || previous.artist === song.artist);
        return !same;
    }

    reset() {
        this._songs.clear();
    }
}

/** "Title · Artist" for the collapsed pill's notice. */
export function peekText({title, artist}) {
    return artist ? `${title} · ${artist}` : title;
}

/**
 * What the pill adds to its accessible name while music shows on it.
 *
 * @param {object} what {title, artist, peek}
 * @param {Function} [_] gettext
 */
export function pillAccessibleText({title, artist, peek = false}, _ = s => s) {
    if (peek) {
        return artist
            ? subst(_('Now playing: %s, %s'), title, artist)
            : subst(_('Now playing: %s'), title);
    }
    return artist
        ? subst(_('playing “%s” by %s'), title, artist)
        : subst(_('playing “%s”'), title);
}

// ---------------------------------------------------------------- swipe

/** Physical finger motion: positive when the fingers moved right. */
export function physicalDx(dx, inverted) {
    return inverted ? -dx : dx;
}

/**
 * Two-finger horizontal swipes on a touchpad: one skip per gesture.
 * Fingers left → 'next', right → 'previous'.
 */
export class SwipeTracker {
    constructor({lockPx = 4, dominance = 1.5, firePx = 40, gapMs = 350} = {}) {
        Object.assign(this, {lockPx, dominance, firePx, gapMs});
        this.reset();
    }

    reset() {
        this._x = 0;
        this._y = 0;
        this._axis = null;
        this._fired = false;
        this._lastMs = null;
    }

    /** True while a gesture is horizontal (its events are the tracker's). */
    get horizontal() {
        return this._axis === 'x';
    }

    /**
     * @param {object} motion
     * @param {number} motion.dx physical px, positive = fingers right
     * @param {number} motion.dy px
     * @param {number} motion.timeMs event time
     * @param {boolean} [motion.finished] the gesture ended
     * @returns {?string} 'next', 'previous' or null
     */
    feed({dx, dy, timeMs, finished = false}) {
        if (this._lastMs !== null && timeMs - this._lastMs > this.gapMs)
            this.reset();
        this._lastMs = timeMs;
        this._x += dx;
        this._y += dy;
        let result = null;
        if (this._axis === null) {
            const [ax, ay] = [Math.abs(this._x), Math.abs(this._y)];
            if (Math.max(ax, ay) >= this.lockPx) {
                if (ax >= this.dominance * ay)
                    this._axis = 'x';
                else if (ay >= this.dominance * ax)
                    this._axis = 'y';
            }
        }
        if (this._axis === 'x' && !this._fired) {
            if (this._x <= -this.firePx)
                result = 'next';
            else if (this._x >= this.firePx)
                result = 'previous';
            this._fired = result !== null;
        }
        if (finished)
            this.reset();
        return result;
    }
}

// ---------------------------------------------------------------- timers

/**
 * GLib one-shot timers and idles, the default for services; tests pass
 * a fake with the same shape.
 */
export const glibTimers = {
    add: (ms, callback) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, Math.round(ms)), () => {
        callback();
        return GLib.SOURCE_REMOVE;
    }),
    idle: callback => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        callback();
        return GLib.SOURCE_REMOVE;
    }),
    remove: id => GLib.source_remove(id),
    now: () => GLib.get_monotonic_time(),
};

/** A restartable one-shot over a timers object. */
export class OneShot {
    constructor(timers, callback) {
        this._timers = timers;
        this._callback = callback;
        this._id = 0;
    }

    get active() {
        return this._id !== 0;
    }

    /** Starts it unless it runs (a running one is not extended). */
    start(ms) {
        if (!this._id)
            this.restart(ms);
    }

    restart(ms) {
        this.stop();
        this._id = this._timers.add(ms, () => {
            this._id = 0;
            this._callback();
        });
    }

    stop() {
        if (this._id)
            this._timers.remove(this._id);
        this._id = 0;
    }
}
