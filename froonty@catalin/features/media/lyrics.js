// SPDX-License-Identifier: GPL-3.0-or-later
// parseLrc(), catalogAlbum(), lrclibMatch() and LyricsMemory follow
// vorssaint-utils' lyrics rules closely: Copyright (C) 2026 Vorssaint,
// GPL-3.0-or-later.
//
// Media tab extras (docs/features/media.md): timed lyrics (LRC) and the
// upcoming songs of a player's TrackList. Pure rules over GLib only.
//
// Design adapted from vorssaint-utils (GPL-3.0-or-later). The LRC rules
// (repeated tags, [offset:], gaps, the size bounds) follow its parser.

import GLib from 'gi://GLib';

import {cleanText} from './model.js';

export const MAX_LYRICS_BYTES = 128 * 1024;
export const MAX_LYRICS_LINES = 2000;
export const MAX_QUEUE = 20;
export const OFFSET_STEP = 0.25;
export const OFFSET_LIMIT = 10;
export const LRCLIB_URL = 'https://lrclib.net/api/get';

const utf8 = new TextEncoder();
const byteLength = text => utf8.encode(text).length;

// "mm:ss.xx" → seconds, or null.
function timestamp(value) {
    const parts = value.split(':');
    if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !/^[\d.]+$/.test(parts[1]))
        return null;
    const minutes = Number(parts[0]);
    const seconds = Number(parts[1]);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds >= 60 || minutes > 10080)
        return null;
    return minutes * 60 + seconds;
}

/**
 * Timed lines of an LRC text: [{time, text}], sorted; lines of one time
 * joined by "\n"; an empty timed line is a gap (text ''). Empty when the
 * text has no timed words, or is too large.
 *
 * @param {string} source
 * @param {number} durationS the song's length (lines after it are dropped)
 */
export function parseLrc(source, durationS) {
    if (typeof source !== 'string' || byteLength(source) > MAX_LYRICS_BYTES ||
        !Number.isFinite(durationS) || durationS <= 0)
        return [];
    const entries = [];
    let expandedBytes = 0;
    let fileOffset = 0;
    for (const rawLine of source.split(/\r\n|\r|\n/)) {
        const line = rawLine.replace(/^[\s﻿]+|[\s﻿]+$/g, '');
        const offset = /^\[offset:([^\]]*)\]$/i.exec(line);
        if (offset) {
            const value = offset[1].trim() === '' ? NaN : Number(offset[1]);
            if (Number.isFinite(value) && Math.abs(value) <= 60000)
                fileOffset = value / 1000;
            continue;
        }
        let text = line;
        const times = [];
        while (text.startsWith('[') && text.includes(']')) {
            const end = text.indexOf(']');
            const time = timestamp(text.slice(1, end));
            if (time === null)
                break;
            if (times.length >= MAX_LYRICS_LINES)
                return [];
            times.push(time);
            text = text.slice(end + 1);
        }
        const words = text.trim();
        // Repeated tags expand one line into many verses: bound that first.
        const perEntry = byteLength(words) + (words ? 1 : 0);
        for (const time of times) {
            if (entries.length >= MAX_LYRICS_LINES || perEntry > MAX_LYRICS_BYTES - expandedBytes)
                return [];
            expandedBytes += perEntry;
            entries.push({time, text: words, index: entries.length});
        }
    }
    const adjusted = entries
        .map(e => ({...e, time: Math.max(0, e.time - fileOffset)}))
        .filter(e => e.time <= durationS)
        .sort((a, b) => a.time - b.time || a.index - b.index);
    const result = [];
    for (const entry of adjusted) {
        const last = result.at(-1);
        if (last && last.time === entry.time) {
            if (entry.text)
                last.text = last.text ? `${last.text}\n${entry.text}` : entry.text;
        } else {
            result.push({time: entry.time, text: entry.text});
        }
    }
    return result.some(line => line.text) ? result : [];
}

/**
 * Lyrics from a text: timed when it has timed lines, else plain (never
 * given invented timing).
 *
 * @returns {?{lines: object[], plain: string, instrumental: boolean}}
 */
export function lyricsFromText(text, durationS) {
    if (typeof text !== 'string' || byteLength(text) > MAX_LYRICS_BYTES)
        return null;
    const lines = parseLrc(text, durationS);
    if (lines.length)
        return {lines, plain: '', instrumental: false};
    const plain = text.trim();
    return plain ? {lines: [], plain, instrumental: false} : null;
}

/**
 * The line shown as current: the last whose time has come, with the
 * user's offset; null before the first.
 *
 * @param {object[]} lines sorted by time
 * @param {number} positionS
 * @param {number} offsetS positive shows lines later
 */
export function activeIndex(lines, positionS, offsetS = 0) {
    if (!Number.isFinite(positionS) || !Number.isFinite(offsetS))
        return null;
    const time = positionS - offsetS;
    let lower = 0;
    let upper = lines.length;
    while (lower < upper) {
        const middle = lower + Math.floor((upper - lower) / 2);
        if (lines[middle].time <= time)
            lower = middle + 1;
        else
            upper = middle;
    }
    return lower === 0 ? null : lower - 1;
}

/**
 * Milliseconds until the next verse starts, or null when nothing will
 * change by itself (paused, no position, no valid rate, no later verse).
 *
 * @param {object[]} lines
 * @param {object} playback {playing, hasPosition, rate, positionS, lengthS}
 * @param {number} offsetS
 */
export function nextVerseDelay(lines, {playing, hasPosition, rate, positionS, lengthS = Infinity}, offsetS = 0) {
    if (!playing || !hasPosition || !Number.isFinite(rate) || rate <= 0 ||
        !Number.isFinite(positionS) || !Number.isFinite(offsetS))
        return null;
    for (const line of lines) {
        const target = line.time + offsetS;
        if (target > positionS && target <= lengthS)
            return Math.max(1, Math.ceil((target - positionS) / rate * 1000) + 1);
    }
    return null;
}

/** The user's offset after a step, quantised to 0.25 s within ±10 s. */
export function adjustOffset(offset, amount) {
    if (!Number.isFinite(amount))
        return offset;
    const next = Math.round((offset + amount) * 4) / 4;
    return Math.min(OFFSET_LIMIT, Math.max(-OFFSET_LIMIT, next));
}

/** "+0.25", "−1.50": the offset as the timing control shows it. */
export function offsetLabel(offset) {
    const sign = offset < 0 ? '−' : '+';
    return `${sign}${Math.abs(offset).toFixed(2)}`;
}

/** Album titles of singles and EPs as lrclib stores them. */
export function catalogAlbum(album) {
    const trimmed = (album ?? '').trim();
    const match = /^(.+?) - (Single|EP)$/i.exec(trimmed);
    return match ? match[1] : trimmed;
}

/**
 * The lrclib.net lookup for a song, or null when it cannot match
 * (missing title, artist or album, or a length outside 1 s-1 h).
 *
 * @param {object} track {title, artist, album, lengthUs}
 * @param {string} [base]
 */
export function lrclibUrl(track, base = LRCLIB_URL) {
    const fields = [track?.title, track?.artist, track?.album];
    if (!fields.every(f => typeof f === 'string' && f.length > 0 && byteLength(f) <= 1024))
        return null;
    const duration = Math.round((track.lengthUs ?? NaN) / 1e6);
    if (!Number.isFinite(duration) || duration < 1 || duration > 3600)
        return null;
    const query = [
        ['track_name', track.title],
        ['artist_name', track.artist],
        ['album_name', catalogAlbum(track.album)],
        ['duration', String(duration)],
    ].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    return `${base}?${query}`;
}

const same = (value, expected) => typeof value === 'string' && expected &&
    value.trim().toLowerCase() === expected.trim().toLowerCase();

/**
 * lrclib's answer, accepted only for exactly this recording: title,
 * artist and album equal (ignoring case), length within 2 s.
 *
 * @param {string} body JSON
 * @param {object} track
 * @returns {?{lines, plain, instrumental}}
 */
export function lrclibMatch(body, track) {
    if (typeof body !== 'string' || byteLength(body) > MAX_LYRICS_BYTES)
        return null;
    let object;
    try {
        object = JSON.parse(body);
    } catch {
        return null;
    }
    const duration = Math.round((track.lengthUs ?? NaN) / 1e6);
    if (!object || typeof object !== 'object' ||
        !same(object.trackName, track.title) || !same(object.artistName, track.artist) ||
        !same(typeof object.albumName === 'string' ? catalogAlbum(object.albumName) : null,
            catalogAlbum(track.album)) ||
        typeof object.duration !== 'number' || !Number.isFinite(object.duration) ||
        Math.abs(object.duration - duration) > 2)
        return null;
    const instrumental = object.instrumental === true;
    const plain = typeof object.plainLyrics === 'string' ? object.plainLyrics.trim() : '';
    const lines = typeof object.syncedLyrics === 'string' ? parseLrc(object.syncedLyrics, duration) : [];
    if (!instrumental && !plain && !lines.length)
        return null;
    return {
        lines: instrumental ? [] : lines,
        plain: instrumental ? '' : plain,
        instrumental,
    };
}

/**
 * The .lrc file next to a local song ("/music/a.flac" → "/music/a.lrc"),
 * or null for anything that is not a file:// address.
 *
 * @param {?string} url xesam:url
 */
export function sidecarPath(url) {
    if (typeof url !== 'string' || GLib.Uri.peek_scheme(url) !== 'file')
        return null;
    try {
        const [path] = GLib.filename_from_uri(url);
        const dir = GLib.path_get_dirname(path);
        const name = GLib.path_get_basename(path);
        const dot = name.lastIndexOf('.');
        const stem = dot > 0 ? name.slice(0, dot) : name;
        if (!stem || name === '/' || name === '.')
            return null;
        const sidecar = GLib.build_filenamev([dir, `${stem}.lrc`]);
        return sidecar === path ? null : sidecar;
    } catch {
        return null;
    }
}

/**
 * Lyrics kept in memory: one song's, with the user's offset. Hiding the
 * panel keeps them; another song (or none) clears them.
 */
export class LyricsMemory {
    constructor() {
        this.clear();
    }

    /** @param {?string} identity the song's (model.trackIdentity) */
    select(identity) {
        if (identity === this.identity)
            return;
        this.identity = identity;
        this.lyrics = null;
        this.offset = 0;
    }

    /** Keeps lyrics only for the song they were asked for. */
    replace(lyrics, identity) {
        if (identity !== this.identity)
            return false;
        this.lyrics = lyrics;
        this.offset = 0;
        return true;
    }

    adjust(amount) {
        if (this.identity !== null)
            this.offset = adjustOffset(this.offset, amount);
    }

    resetOffset() {
        this.offset = 0;
    }

    clear() {
        this.identity = null;
        this.lyrics = null;
        this.offset = 0;
    }
}

// ---------------------------------------------------------------- queue

/**
 * The upcoming songs of a TrackList: up to 20 after the current one,
 * numbered from 1. A row keeps its number when one before it is skipped
 * (no title). Null for a list it cannot trust: duplicate ids, ids that are
 * not object paths, or no current song in it.
 *
 * @param {string[]} trackIds the Tracks property
 * @param {?string} currentId the current song's mpris:trackid
 * @returns {?string[]} the upcoming ids, in order (≤ 20)
 */
export function upcomingIds(trackIds, currentId) {
    if (!Array.isArray(trackIds) || !currentId)
        return null;
    if (new Set(trackIds).size !== trackIds.length ||
        !trackIds.every(id => typeof id === 'string' && GLib.Variant.is_object_path(id)))
        return null;
    const index = trackIds.indexOf(currentId);
    if (index < 0)
        return null;
    return trackIds.slice(index + 1, index + 1 + MAX_QUEUE);
}

/**
 * Rows for the upcoming ids, from GetTracksMetadata's decoded answers.
 *
 * @param {string[]} ids from upcomingIds
 * @param {object[]} tracks decodeMetadata results (with trackId), any order
 * @returns {object[]} [{offset, trackId, title, artist}]
 */
export function queueRows(ids, tracks) {
    const byId = new Map(tracks.filter(t => t?.trackId).map(t => [t.trackId, t]));
    const rows = [];
    ids.forEach((id, i) => {
        const track = byId.get(id);
        const title = cleanText(track?.title);
        if (title)
            rows.push({offset: i + 1, trackId: id, title, artist: track.artist ?? null});
    });
    return rows;
}
