// SPDX-License-Identifier: GPL-3.0-or-later
// Media tab rules (froonty@catalin/features/media/model.js) and the
// service's choice, gap, grace and art rules over a fake watcher and a fake
// clock (no D-Bus here; see media-mpris.test.js for the bus).

import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

import {
    NewSongDetector, SwipeTracker, artSource, cleanText, decodeMetadata, decodePlayer, displayNames,
    formatRemaining, formatTime, isMusicApp, latestPlaying, mergeMirrors, physicalDx, planSeek,
    playPauseCommand, playerName, positionUs, preferred, peekText, pillAccessibleText, tickDelay,
    tint, trackIdentity, NO_TRACK, WEEK_US,
} from '../../froonty@catalin/features/media/model.js';
import {decode, pixbufTint} from '../../froonty@catalin/features/media/art.js';
import {MediaService} from '../../froonty@catalin/features/media/service.js';
import {Emitter} from '../../froonty@catalin/core/emitter.js';
import {done, eq, ok, test} from './test.js';

const v = (type, value) => new GLib.Variant(type, value);
const meta = entries => new GLib.Variant('a{sv}', entries);
const getter = map => name => map[name] ?? null;

test('M1 text is trimmed, stripped of control characters and capped at 300', () => {
    eq(cleanText('  a\nb\tc\u0007  '), 'a b c');
    eq(cleanText(''), null);
    eq(cleanText('   \n '), null);
    eq(cleanText(42), null);
    eq(cleanText('x'.repeat(400)).length, 300);
    // A cap never splits a surrogate pair.
    const emoji = `${'x'.repeat(299)}😀`;
    eq(cleanText(emoji), 'x'.repeat(299));
});

test('M2 metadata: title, artists joined, album, length in microseconds', () => {
    const track = decodeMetadata(meta({
        'xesam:title': v('s', 'Song'),
        'xesam:artist': v('as', ['A', ' ', 'B']),
        'xesam:album': v('s', 'Album'),
        'mpris:length': v('x', 180e6),
        'mpris:trackid': v('o', '/org/test/1'),
        'mpris:artUrl': v('s', 'file:///tmp/a.png'),
    }));
    eq(track, {
        trackId: '/org/test/1', title: 'Song', artist: 'A, B', album: 'Album', lengthUs: 180e6,
        artUrl: 'file:///tmp/a.png', url: null, asText: null,
    });
    eq(decodeMetadata(meta({'xesam:title': v('s', 'S'), 'xesam:artist': v('s', 'Solo')})).artist, 'Solo');
});

test('M3 metadata: wrong types are dropped, never replaced by placeholder text', () => {
    const track = decodeMetadata(meta({
        'xesam:title': v('s', 'Song'),
        'xesam:artist': v('i', 3),
        'xesam:album': v('as', ['x']),
        'mpris:artUrl': v('i', 1),
    }));
    eq([track.artist, track.album, track.artUrl], [null, null, null]);
    eq(decodeMetadata(meta({'xesam:title': v('i', 1)})), null);
    eq(decodeMetadata(v('s', 'not a dict')), null);
    eq(decodeMetadata(null), null);
});

test('M4 metadata: no title falls back to a file:// url\'s name, else no track', () => {
    eq(decodeMetadata(meta({'xesam:url': v('s', 'file:///music/My%20Song.flac')})).title, 'My Song');
    eq(decodeMetadata(meta({'xesam:url': v('s', 'https://example.org/a.mp3')})), null);
    eq(decodeMetadata(meta({'xesam:title': v('s', '  ')})), null);
});

test('M5 metadata: trackid as o or s; NoTrack and invalid paths become null', () => {
    const id = value => decodeMetadata(meta({'xesam:title': v('s', 'S'), 'mpris:trackid': value})).trackId;
    eq(id(v('o', '/a/b')), '/a/b');
    eq(id(v('s', '/org/mpris/MediaPlayer2/Track/3')), '/org/mpris/MediaPlayer2/Track/3');
    eq(id(v('s', 'not a path')), null);
    eq(id(v('o', NO_TRACK)), null);
});

test('M6 metadata: length accepts x, t, i, u, d; non-positive or NaN is unknown; capped at 7 days', () => {
    const length = value => decodeMetadata(meta({'xesam:title': v('s', 'S'), 'mpris:length': value})).lengthUs;
    eq([length(v('x', 5)), length(v('t', 6)), length(v('i', 7)), length(v('u', 8)), length(v('d', 9.5))],
        [5, 6, 7, 8, 9.5]);
    eq([length(v('x', 0)), length(v('x', -3)), length(v('d', NaN)), length(v('s', '5'))],
        [null, null, null, null]);
    eq(length(v('x', 1e15)), WEEK_US);
});

test('M7 metadata: artUrl keeps file, http, https; others and over 4096 characters become null', () => {
    const art = url => decodeMetadata(meta({'xesam:title': v('s', 'S'), 'mpris:artUrl': v('s', url)})).artUrl;
    eq(art('file:///a.png'), 'file:///a.png');
    eq(art('HTTPS://x.org/a.png'), 'HTTPS://x.org/a.png');
    eq(art('http://x.org/a.png'), 'http://x.org/a.png');
    eq(art('data:image/png;base64,AAAA'), null);
    eq(art('ftp://x/a.png'), null);
    eq(art(`file:///${'a'.repeat(4100)}`), null);
});

test('M8 properties: status, rate in (0,16] else 1, capabilities; CanControl false makes all read-only', () => {
    const props = decodePlayer(getter({
        PlaybackStatus: v('s', 'Playing'), Rate: v('d', 2), CanPlay: v('b', true),
        CanPause: v('b', true), CanSeek: v('b', true), CanGoNext: v('b', true),
    }));
    eq([props.status, props.playing, props.rate, props.canPlay, props.canPause, props.canSeek, props.canControl],
        ['Playing', true, 2, true, true, true, true]);
    eq(decodePlayer(getter({PlaybackStatus: v('s', 'Buffering'), Rate: v('d', 0)})).status, 'Stopped');
    eq(decodePlayer(getter({Rate: v('d', 0)})).rate, 1);
    eq(decodePlayer(getter({Rate: v('d', 17)})).rate, 1);
    eq(decodePlayer(getter({Rate: v('s', '2')})).rate, 1);
    const locked = decodePlayer(getter({
        CanControl: v('b', false), CanPlay: v('b', true), CanPause: v('b', true),
        CanSeek: v('b', true), CanGoNext: v('b', true),
    }));
    eq([locked.canPlay, locked.canPause, locked.canSeek, locked.canGoNext, locked.canGoPrevious],
        [false, false, false, false, false]);
});

test('M9 missing CanGoNext/CanGoPrevious is unknown (null)', () => {
    const props = decodePlayer(getter({}));
    eq([props.canGoNext, props.canGoPrevious, props.canControl], [null, null, true]);
    eq(decodePlayer(getter({CanGoNext: v('b', false)})).canGoNext, false);
});

test('M10 identity changes with trackid, title, artist, album or rounded length, not with status or position', () => {
    const base = {trackId: '/a', title: 'T', artist: 'A', album: 'B', lengthUs: 180.2e6};
    const id = trackIdentity(base);
    for (const change of [{trackId: '/b'}, {title: 'U'}, {artist: 'C'}, {album: 'D'}, {lengthUs: 181e6}])
        ok(trackIdentity({...base, ...change}) !== id, JSON.stringify(change));
    eq(trackIdentity({...base, lengthUs: 180.4e6}), id);
    eq(trackIdentity(null), null);
});

test('M11 position extrapolates by rate while playing, holds while paused, clamps to [0, length]', () => {
    eq(positionUs({us: 10e6, atUs: 0, playing: true, rate: 2}, 1e6, 100e6), 12e6);
    eq(positionUs({us: 10e6, atUs: 0, playing: false, rate: 1}, 5e6, 100e6), 10e6);
    eq(positionUs({us: 99e6, atUs: 0, playing: true, rate: 1}, 5e6, 100e6), 100e6);
    eq(positionUs({us: -5, atUs: 0, playing: false, rate: 1}, 0, 100e6), 0);
});

test('M12 seek plan: SetPosition with a trackid, Seek(offset) without, nothing without CanSeek or length', () => {
    const track = {trackId: '/t/1', lengthUs: 100e6};
    const set = planSeek({track, caps: {canSeek: true}, targetUs: 150e6, estimateUs: 0});
    eq([set.method, set.params.deepUnpack()], ['SetPosition', ['/t/1', 100e6]]);
    const seek = planSeek({track: {...track, trackId: null}, caps: {canSeek: true}, targetUs: 30e6, estimateUs: 10e6});
    eq([seek.method, seek.params.deepUnpack()], ['Seek', [20e6]]);
    eq(planSeek({track, caps: {canSeek: false}, targetUs: 1, estimateUs: 0}), null);
    eq(planSeek({track: {trackId: '/t', lengthUs: null}, caps: {canSeek: true}, targetUs: 1, estimateUs: 0}), null);
});

test('M13 play/pause: Pause or Play by status, only as the player allows', () => {
    eq(playPauseCommand({playing: true, canPlay: true, canPause: true}), 'Pause');
    eq(playPauseCommand({playing: false, canPlay: true, canPause: true}), 'Play');
    eq(playPauseCommand({playing: true, canPlay: true, canPause: false}), null);
    eq(playPauseCommand({playing: false, canPlay: false, canPause: true}), null);
    eq(playPauseCommand({playing: true, canPlay: false, canPause: false}), null);
});

test('M14 time format: m:ss, h:mm:ss from an hour, clamped to [0, 7 days]', () => {
    eq([formatTime(0), formatTime(83.9), formatTime(3599), formatTime(3600), formatTime(3725)],
        ['0:00', '1:23', '59:59', '1:00:00', '1:02:05']);
    eq([formatTime(-5), formatTime(NaN), formatTime(1e9)], ['0:00', '0:00', '168:00:00']);
    eq(formatRemaining(225, 101), '−2:04');
});

test('M15 music app: Audio or Music categories, never WebBrowser; daemon names', () => {
    ok(isMusicApp({categories: ['Audio', 'Player'], busName: 'org.mpris.MediaPlayer2.rhythmbox'}));
    ok(isMusicApp({categories: ['Music'], busName: 'x'}));
    ok(!isMusicApp({categories: ['Audio', 'WebBrowser'], busName: 'org.mpris.MediaPlayer2.brave'}));
    ok(!isMusicApp({categories: ['Video'], busName: 'org.mpris.MediaPlayer2.vlc'}));
    ok(isMusicApp({categories: [], busName: 'org.mpris.MediaPlayer2.mpd'}));
    ok(isMusicApp({categories: [], busName: 'org.mpris.MediaPlayer2.spotifyd.instance42'}));
});

const src = (key, extra = {}) => ({key, pid: null, playing: false, isMusic: false, hasTrack: true, ...extra});

test('M16 choice: an explicit choice with a track wins, even paused against a playing player', () => {
    const sources = [src('a', {isMusic: true, playing: true, pid: 1}), src('b', {pid: 2})];
    eq(preferred(sources, {chosenKey: 'b'}), 'b');
    eq(preferred([src('a', {playing: true, isMusic: true}), src('b', {hasTrack: false})], {chosenKey: 'b'}), 'a');
});

test('M17 choice: playing music, then any other player that plays, then paused music', () => {
    const music = src('music', {isMusic: true, pid: 5});
    const browser = src('browser', {playing: true, pid: 1});
    eq(preferred([{...music, playing: true}, browser], {latestPlayingKey: 'browser'}), 'music');
    eq(preferred([music, browser], {latestPlayingKey: 'browser'}), 'browser');
    eq(preferred([music, browser], {followedKey: 'browser'}), 'browser');
    // Apple Music paused, YouTube still playing: YouTube, not the paused one.
    eq(preferred([music, browser], {followedKey: 'music', latestPlayingKey: 'music'}), 'browser');
    eq(preferred([music, {...browser, playing: false}], {}), 'music');
});

test('M17b choice: the player whose window was brought up, paused or not, after a choice made by hand', () => {
    const music = src('music', {isMusic: true, playing: true, pid: 5});
    const browser = src('browser', {pid: 1});
    eq(preferred([music, browser], {focusedKey: 'browser'}), 'browser');
    eq(preferred([music, browser], {focusedKey: 'browser', chosenKey: 'music'}), 'music');
    eq(preferred([music, {...browser, hasTrack: false}], {focusedKey: 'browser'}), 'music');
    eq(preferred([music, browser], {focusedKey: 'browser', includeOthers: false}), 'music');
});

test('M18 choice: with other players excluded, a playing browser never wins', () => {
    const browser = src('browser', {playing: true});
    eq(preferred([browser], {latestPlayingKey: 'browser', followedKey: 'browser', includeOthers: false}), null);
    eq(preferred([src('m', {isMusic: true}), browser], {latestPlayingKey: 'browser', includeOthers: false}), 'm');
    eq(preferred([browser], {chosenKey: 'browser', includeOthers: false}), 'browser');
});

test('M19 choice: ties go to followed, then latest to play, then PID, then bus name', () => {
    const a = src('a', {isMusic: true, playing: true, pid: 9});
    const b = src('b', {isMusic: true, playing: true, pid: 3});
    const c = src('c', {isMusic: true, playing: true, pid: 3});
    eq(preferred([a, b, c], {followedKey: 'a', latestPlayingKey: 'c'}), 'a');
    eq(preferred([a, b, c], {latestPlayingKey: 'c'}), 'c');
    eq(preferred([a, b, c], {}), 'b');
    eq(preferred([a, c], {}), 'c');
    eq(preferred([src('z', {isMusic: true, playing: true}), src('y', {isMusic: true, playing: true})], {}), 'y');
});

test('M20 choice: nothing eligible gives none, or the latest player when others are included', () => {
    const browser = src('browser', {playing: false});
    eq(preferred([browser], {includeOthers: true}), null);
    eq(preferred([browser], {latestPlayingKey: 'browser', includeOthers: true}), 'browser');
    eq(preferred([browser], {latestPlayingKey: 'browser', includeOthers: false}), null);
    eq(preferred([], {}), null);
    eq(latestPlaying([
        {key: 'a', playing: true, playingSinceUs: 5},
        {key: 'b', playing: true, playingSinceUs: 9},
        {key: 'c', playing: false, playingSinceUs: null},
    ], 'c'), 'b');
    eq(latestPlaying([{key: 'c', playing: false, playingSinceUs: null}], 'c'), 'c');
    eq(latestPlaying([{key: 'c', playing: false, playingSinceUs: null}], 'gone'), null);
});

test('M21 mirrors merge by PID and track; different tracks stay separate; playerctld never listed', () => {
    const track = {title: 'T', artist: 'A', album: null, lengthUs: 1e6, trackId: '/1'};
    const players = [
        {key: 'org.mpris.MediaPlayer2.vlc.instance77', pid: 77, track: {...track, trackId: '/2'}},
        {key: 'org.mpris.MediaPlayer2.vlc', pid: 77, track},
        {key: 'org.mpris.MediaPlayer2.kdeconnect.phone1', pid: 50, track},
        {key: 'org.mpris.MediaPlayer2.kdeconnect.phone2', pid: 50, track: {...track, title: 'U'}},
        {key: 'org.mpris.MediaPlayer2.playerctld', pid: 60, track},
        {key: 'org.mpris.MediaPlayer2.a', pid: null, track},
        {key: 'org.mpris.MediaPlayer2.b', pid: null, track},
    ];
    eq(mergeMirrors(players).map(p => p.key), [
        'org.mpris.MediaPlayer2.vlc',
        'org.mpris.MediaPlayer2.kdeconnect.phone1',
        'org.mpris.MediaPlayer2.kdeconnect.phone2',
        'org.mpris.MediaPlayer2.a',
        'org.mpris.MediaPlayer2.b',
    ]);
});

test('M22 display names: app, Identity, bus name; duplicates get the title', () => {
    eq(playerName({appName: 'Rhythmbox', identity: 'rb', busName: 'org.mpris.MediaPlayer2.rhythmbox'}), 'Rhythmbox');
    eq(playerName({appName: null, identity: 'VLC media player', busName: 'org.mpris.MediaPlayer2.vlc'}), 'VLC media player');
    eq(playerName({busName: 'org.mpris.MediaPlayer2.chromium.instance123'}), 'chromium');
    eq(playerName({appName: 'é'.repeat(200), identity: 'Short', busName: 'x'}), 'Short');
    const names = displayNames([
        {key: 'a', name: 'Brave', title: 'Video one'},
        {key: 'b', name: 'Brave', title: `Two ${'x'.repeat(80)}`},
        {key: 'c', name: 'Music', title: 'Song'},
    ]);
    eq(names.get('a'), 'Brave · Video one');
    eq(names.get('b').length, 60);
    ok(names.get('b').endsWith('…'));
    eq(names.get('c'), 'Music');
});

// ---------------------------------------------------------------- service on fakes

class FakeTimers {
    constructor() {
        this.t = 0;
        this.next = 1;
        this.pending = new Map();
    }

    add(ms, callback) {
        const id = this.next++;
        this.pending.set(id, {at: this.t + ms * 1000, callback});
        return id;
    }

    idle(callback) {
        return this.add(0, callback);
    }

    remove(id) {
        this.pending.delete(id);
    }

    now() {
        return this.t;
    }

    advance(ms) {
        const end = this.t + ms * 1000;
        for (;;) {
            const due = [...this.pending.entries()].filter(([, p]) => p.at <= end)
                .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
            if (!due)
                break;
            this.pending.delete(due[0]);
            this.t = Math.max(this.t, due[1].at);
            due[1].callback();
        }
        this.t = end;
    }
}

class FakeWatcherPlayer {
    constructor(name, owner, {pid = 1, track = null, playing = false, isMusic = true} = {}) {
        this.name = name;
        this.owner = owner;
        this.pid = pid;
        this.track = track;
        this.root = {identity: name, desktopEntry: isMusic ? 'music' : 'browser', canRaise: false, hasTrackList: false};
        this.calls = [];
        this.setPlaying(playing, 0);
    }

    setPlaying(playing, now) {
        this.props = {
            status: playing ? 'Playing' : 'Paused', playing, rate: 1, canControl: true,
            canPlay: true, canPause: true, canSeek: true, canGoNext: true, canGoPrevious: true,
        };
        this.playingSinceUs = playing ? now : null;
    }

    async get(_iface, prop) {
        if (prop === 'Position')
            return new GLib.Variant('x', 0);
        const m = this.track ? {'xesam:title': new GLib.Variant('s', this.track.title)} : {};
        return new GLib.Variant('a{sv}', m);
    }

    async call(method) {
        this.calls.push(method);
        return null;
    }
}

class FakeWatcher extends Emitter {
    constructor() {
        super();
        this.players = new Map();
        this.ready = false;
    }

    start() {}

    stop() {}

    add(player) {
        this.players.set(player.name, player);
    }
}

const apps = {
    lookup: ({desktopEntry}) => desktopEntry,
    name: app => app,
    categories: app => app === 'music' ? ['Audio'] : ['WebBrowser'],
    activate: () => {},
};

function fakeSettings(values = {}) {
    const all = {'media-include-other-players': true, 'media-remote-art': false, ...values};
    return {
        get_boolean: key => all[key],
        connect: () => 1,
        disconnect: () => {},
    };
}

function rig({include = true, pauseOthers = true, focus = null} = {}) {
    const timers = new FakeTimers();
    const watcher = new FakeWatcher();
    const loads = [];
    const artLoader = {
        load: url => new Promise(resolve => loads.push({url, resolve})),
        clearRemote: () => {},
    };
    const memory = {};
    const service = new MediaService({
        settings: fakeSettings({'media-include-other-players': include, 'media-pause-others': pauseOthers}),
        memory, apps, watcher, timers, artLoader, focus,
        fetcher: {destroy: () => {}, abort: () => {}},
    });
    service.start();
    const changed = () => {
        watcher.emit('changed');
    };
    return {timers, watcher, service, memory, loads, changed};
}

const T = title => ({trackId: null, title, artist: 'A', album: null, lengthUs: 100e6, artUrl: null, url: null, asText: null});

test('M23 selection: picking the shown one keeps it and checks it; a stale key is ignored; a change clears playback and awaits', () => {
    const {timers, watcher, service, changed} = rig();
    watcher.add(new FakeWatcherPlayer('org.mpris.MediaPlayer2.a', ':1.1', {pid: 1, track: T('A'), playing: true}));
    watcher.add(new FakeWatcherPlayer('org.mpris.MediaPlayer2.b', ':1.2', {pid: 2, track: T('B')}));
    watcher.ready = true;
    changed();
    eq(service.playback?.key, 'org.mpris.MediaPlayer2.a');
    const revision = service.revision;
    service.select('org.mpris.MediaPlayer2.a');
    eq([service.revision, service.automatic, service.chosenKey, service.playback?.key],
        [revision, false, 'org.mpris.MediaPlayer2.a', 'org.mpris.MediaPlayer2.a'],
        'the shown key becomes the chosen one, without a reset');
    service.select('org.mpris.MediaPlayer2.gone');
    eq(service.chosenKey, 'org.mpris.MediaPlayer2.a', 'a stale key is ignored');
    const context = service.context();
    service.select('org.mpris.MediaPlayer2.b');
    eq([service.playback, service.awaiting, service.chosenKey], [null, true, 'org.mpris.MediaPlayer2.b']);
    ok(!service.allowed(context), 'the old context no longer acts');
    timers.advance(0);
    eq([service.playback?.key, service.awaiting], ['org.mpris.MediaPlayer2.b', false]);
    const again = service.revision;
    service.select('org.mpris.MediaPlayer2.b');
    eq(service.revision, again, 're-choosing the chosen key is a no-op');
    service.select(null);
    timers.advance(0);
    eq([service.automatic, service.playback?.key], [true, 'org.mpris.MediaPlayer2.a']);
    service.stop();
});

test('M24 selection: 5 s grace keeps the check while Automatic fills in; a returning track resets; expiry or a new owner releases', () => {
    const {timers, watcher, service, changed} = rig();
    const a = new FakeWatcherPlayer('org.mpris.MediaPlayer2.a', ':1.1', {pid: 1, track: T('A'), playing: true});
    const b = new FakeWatcherPlayer('org.mpris.MediaPlayer2.b', ':1.2', {pid: 2, track: T('B')});
    watcher.add(a);
    watcher.add(b);
    watcher.ready = true;
    changed();
    service.select(b.name);
    timers.advance(0);
    b.track = null;
    changed();
    timers.advance(1600); // past the gap hold
    eq([service.chosenKey, service.playback?.key], [b.name, a.name], 'Automatic fills in, the choice stays');
    ok(service.sources.some(s => s.key === b.name), 'the chosen source stays listed');
    timers.advance(3000);
    b.track = T('B2');
    changed();
    eq(service.playback?.key, b.name, 'the returning track shows');
    b.track = null;
    changed();
    timers.advance(4900);
    eq(service.chosenKey, b.name, 'the grace runs 5 s from the first reading without a song');
    timers.advance(200);
    eq(service.chosenKey, null, 'expiry releases');
    b.track = T('B3');
    changed();
    service.select(b.name);
    timers.advance(0);
    watcher.players.delete(b.name);
    watcher.add(new FakeWatcherPlayer(b.name, ':1.9', {pid: 2, track: T('B3')}));
    changed();
    eq(service.chosenKey, null, 'a new owner releases at once');
    service.stop();
});

test('M25 gap: 1.5 s hold, replaced at once, not extended by repeats, controls refused meanwhile', () => {
    const {timers, watcher, service, changed} = rig();
    const a = new FakeWatcherPlayer('org.mpris.MediaPlayer2.a', ':1.1', {track: T('One'), playing: true});
    watcher.add(a);
    watcher.ready = true;
    changed();
    a.track = null;
    changed();
    eq([service.playback?.track.title, service.playback?.held], ['One', true]);
    ok(!service.allowed(service.context()), 'controls are refused during the hold');
    timers.advance(1000);
    changed();
    timers.advance(600);
    eq(service.playback, null, 'repeats did not extend it');
    a.track = T('Two');
    changed();
    a.track = null;
    changed();
    timers.advance(500);
    a.track = T('Three');
    changed();
    eq([service.playback?.track.title, service.playback?.held], ['Three', false], 'a real reading replaces it at once');
    service.stop();
});

test('M26 art grace: the old cover for up to 1.5 s, then the placeholder; a source change resets', async () => {
    const {timers, watcher, service, changed, loads} = rig();
    service.wantArt(true);
    const a = new FakeWatcherPlayer('org.mpris.MediaPlayer2.a', ':1.1', {track: {...T('One'), artUrl: 'file:///1.png'}, playing: true});
    watcher.add(a);
    watcher.ready = true;
    changed();
    loads.at(-1).resolve({state: 'ready', pixbuf: 'P1', tint: null});
    await null;
    await null;
    eq(service.art.pixbuf, 'P1');
    a.track = {...T('Two'), artUrl: 'file:///2.png'};
    changed();
    eq(service.art.pixbuf, 'P1', 'the old cover stays while the new one loads');
    timers.advance(1600);
    eq([service.art.state, service.art.pixbuf], ['none', null], 'then the placeholder');
    loads.at(-1).resolve({state: 'ready', pixbuf: 'P2', tint: null});
    await null;
    await null;
    eq(service.art.pixbuf, 'P2');
    const b = new FakeWatcherPlayer('org.mpris.MediaPlayer2.b', ':1.2', {pid: 0, track: T('B'), playing: true});
    watcher.add(b);
    changed();
    service.select(b.name);
    timers.advance(0);
    eq([service.playback?.key, service.art.pixbuf], [b.name, null], 'another source drops the cover at once');
    service.stop();
});

test('M27 tint: dark and grey covers have none; colours are stretched into [0.06, 0.92] (exact values for (0.8, 0.2, 0.2) → (0.92, 0.06, 0.06))', () => {
    eq(tint(0.04, 0.02, 0.01), null);
    eq(tint(0.5, 0.48, 0.47), null);
    const t = tint(0.8, 0.2, 0.2);
    eq([t.r, t.g, t.b].map(x => Math.round(x * 1000) / 1000), [0.92, 0.06, 0.06]);
    eq(tint(NaN, 0, 0), null);
});

test('M28 tint from a generated GdkPixbuf: 16×16 reduction, alpha-weighted', () => {
    const red = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, true, 8, 64, 64);
    red.fill(0xcc3333ff);
    const t = pixbufTint(red);
    ok(t && t.r > 0.9 && t.g < 0.1 && t.b < 0.1, JSON.stringify(t));
    // Half the cover transparent green: the opaque red still decides.
    const mixed = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, true, 8, 64, 64);
    mixed.fill(0xcc3333ff);
    mixed.new_subpixbuf(0, 0, 64, 32).fill(0x00ff0000);
    const m = pixbufTint(mixed);
    ok(m && m.r > 0.9 && m.g < 0.1, JSON.stringify(m));
    const grey = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 32, 32);
    grey.fill(0x808080ff);
    eq(pixbufTint(grey), null);
});

test('M29 new song: first reading records; counts once playing; missing artist matches; stand-in counts for neither; empty never', () => {
    const d = new NewSongDetector();
    const r = (key, title, artist, playing = true) => ({key, title, artist, playing});
    ok(!d.isNewSong(r('a', 'One', 'X'), true), 'first only records');
    ok(!d.isNewSong(r('a', 'One', 'X'), false));
    ok(!d.isNewSong(r('a', 'Two', 'X', false), false), 'paused does not count');
    ok(d.isNewSong(r('a', 'Two', 'X'), false), 'counts once playing');
    ok(!d.isNewSong(r('a', 'Two', null), false), 'missing artist matches');
    ok(!d.isNewSong(r('b', 'Other', 'Y'), false), 'a stand-in without history counts for nothing');
    ok(!d.isNewSong(r('a', 'Two', 'X'), false), 'the first player is unchanged by the stand-in');
    ok(!d.isNewSong(r('a', '  ', 'X'), false), 'empty titles never count');
});

test('M30 swipe: 4 px axis lock at 1.5×; fires once at 40 px; finish or a 350 ms gap ends a sequence', () => {
    const s = new SwipeTracker();
    eq(s.feed({dx: -3, dy: 0, timeMs: 0}), null);
    eq(s.feed({dx: -3, dy: -3, timeMs: 10}), null);
    ok(s.horizontal, 'locked horizontally (6 ≥ 1.5 × 3)');
    eq(s.feed({dx: -40, dy: 0, timeMs: 20}), 'next');
    eq(s.feed({dx: -60, dy: 0, timeMs: 30}), null, 'once per sequence');
    eq(s.feed({dx: 0, dy: 0, timeMs: 40, finished: true}), null);
    eq(s.feed({dx: 45, dy: 0, timeMs: 50}), 'previous', 'a new sequence after finish');
    eq(s.feed({dx: 45, dy: 0, timeMs: 500}), 'previous', 'a 350 ms gap starts a new sequence');
    const vertical = new SwipeTracker();
    vertical.feed({dx: 1, dy: 10, timeMs: 0});
    eq(vertical.feed({dx: -60, dy: 0, timeMs: 10}), null, 'a vertical sequence never skips');
    const small = new SwipeTracker();
    eq(small.feed({dx: -20, dy: 0, timeMs: 0}), null, '20 px is not enough');
});

test('M31 swipe: fingers left mean next, with and without INVERTED', () => {
    // Traditional scrolling: fingers left give dx < 0. Natural scrolling
    // inverts dx and sets INVERTED.
    for (const [dx, inverted] of [[-50, false], [50, true]]) {
        const s = new SwipeTracker();
        eq(s.feed({dx: physicalDx(dx, inverted), dy: 0, timeMs: 0}), 'next', `${dx} ${inverted}`);
    }
});

test('M32 art policy: file local; http(s) only when allowed; data: and others never', () => {
    eq(artSource('file:///a.png', {remote: false}), 'file');
    eq(artSource('https://x/a.png', {remote: false}), 'blocked');
    eq(artSource('http://x/a.png', {remote: true}), 'remote');
    eq(artSource('data:image/png;base64,AA', {remote: true}), null);
    eq(artSource(null, {remote: true}), null);
});

test('M33 pill accessible and peek text', () => {
    eq(peekText({title: 'Song', artist: 'Band'}), 'Song · Band');
    eq(peekText({title: 'Song', artist: null}), 'Song');
    eq(pillAccessibleText({title: 'Song', artist: 'Band'}), 'playing “Song” by Band');
    eq(pillAccessibleText({title: 'Song', artist: null}), 'playing “Song”');
    eq(pillAccessibleText({title: 'Song', artist: 'Band', peek: true}), 'Now playing: Song, Band');
    eq(pillAccessibleText({title: 'Song', artist: null, peek: true}), 'Now playing: Song');
    ok(!/—/.test(peekText({title: 'a', artist: 'b'})), 'no em dash');
});

test('M34 tick delay: next whole second by rate, within [50, 1100] ms', () => {
    eq(tickDelay(10.0, 1), 1005);
    eq(tickDelay(10.5, 1), 505);
    eq(tickDelay(10.5, 2), 255);
    eq(tickDelay(10.99, 1), 50);
    eq(tickDelay(10.0, 0.5), 1100);
    eq(tickDelay(3, NaN), 1005);
});

// A PNG header (signature + IHDR) claiming width × height, no pixels.
function pngHeader(width, height) {
    const crcTable = Array.from({length: 256}, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++)
            c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = bytes => {
        let c = 0xFFFFFFFF;
        for (const b of bytes)
            c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    };
    const be = n => [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255];
    const body = [...[0x49, 0x48, 0x44, 0x52], ...be(width), ...be(height), 8, 6, 0, 0, 0];
    return new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        ...be(13), ...body, ...be(crc(body))]);
}

test('M-art a cover claiming 25000 × 25000 is refused from its header; a small one is scaled', () => {
    eq(decode(pngHeader(25000, 25000), 128), null);
    const small = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, true, 8, 64, 32);
    small.fill(0x3366ccff);
    const [, png] = small.save_to_bufferv('png', [], []);
    const pixbuf = decode(png, 128);
    eq([pixbuf.get_width(), pixbuf.get_height()], [128, 64]);
});

test('M-pause starting a player pauses the others that play (not at the start, not its mirror, not when off)', () => {
    const {watcher, changed} = rig();
    const brave = new FakeWatcherPlayer('org.mpris.MediaPlayer2.brave', ':1.1', {pid: 1, track: T('Video'), playing: true, isMusic: false});
    const music = new FakeWatcherPlayer('org.mpris.MediaPlayer2.music', ':1.2', {pid: 2, track: T('Song')});
    const mirror = new FakeWatcherPlayer('org.mpris.MediaPlayer2.music2', ':1.3', {pid: 2, track: T('Song'), playing: true});
    watcher.add(brave);
    watcher.add(music);
    watcher.ready = true;
    changed();
    eq(brave.calls, [], 'found playing: nothing paused');
    music.setPlaying(true, 10);
    watcher.add(mirror);
    changed();
    eq([brave.calls, music.calls, mirror.calls], [['Pause'], [], []]);

    const off = rig({pauseOthers: false});
    const a = new FakeWatcherPlayer('org.mpris.MediaPlayer2.a', ':1.1', {pid: 1, track: T('A'), playing: true});
    const b = new FakeWatcherPlayer('org.mpris.MediaPlayer2.b', ':1.2', {pid: 2, track: T('B')});
    off.watcher.add(a);
    off.watcher.add(b);
    off.watcher.ready = true;
    off.changed();
    b.setPlaying(true, 10);
    off.changed();
    eq(a.calls, [], 'off: both play');
});

test('M-pause Apple Music paused while YouTube plays: YouTube is shown', () => {
    const {watcher, service, changed} = rig({pauseOthers: false});
    const youtube = new FakeWatcherPlayer('org.mpris.MediaPlayer2.brave', ':1.1', {pid: 1, track: T('Video'), playing: true, isMusic: false});
    const music = new FakeWatcherPlayer('org.mpris.MediaPlayer2.music', ':1.2', {pid: 2, track: T('Song')});
    watcher.add(youtube);
    watcher.add(music);
    watcher.ready = true;
    changed();
    music.setPlaying(true, 10);
    changed();
    eq(service.playback?.key, 'org.mpris.MediaPlayer2.music');
    music.setPlaying(false, 20);
    changed();
    eq(service.playback?.key, 'org.mpris.MediaPlayer2.brave');
});

test('M-focus bringing up a player\'s window shows it, until another starts playing; a choice by hand wins', () => {
    const focus = new Emitter();
    focus.window = null;
    focus.current = () => focus.window;
    const {watcher, service, changed} = rig({focus, pauseOthers: false});
    const music = new FakeWatcherPlayer('org.mpris.MediaPlayer2.music', ':1.1', {pid: 1, track: T('Song'), playing: true});
    const brave = new FakeWatcherPlayer('org.mpris.MediaPlayer2.brave', ':1.2', {pid: 2, track: T('Video'), isMusic: false});
    const other = new FakeWatcherPlayer('org.mpris.MediaPlayer2.other', ':1.3', {pid: 3, track: T('Other')});
    watcher.add(music);
    watcher.add(brave);
    watcher.add(other);
    watcher.ready = true;
    changed();
    eq(service.playback?.key, 'org.mpris.MediaPlayer2.music');
    focus.window = {pid: 2, appId: null};
    focus.emit('changed');
    eq(service.playback?.key, 'org.mpris.MediaPlayer2.brave', 'its window brought up');
    focus.window = {pid: 99, appId: null};
    focus.emit('changed');
    eq(service.playback?.key, 'org.mpris.MediaPlayer2.brave', 'another app: unchanged');
    other.setPlaying(true, 30);
    changed();
    eq(service.playback?.key, 'org.mpris.MediaPlayer2.other', 'another started: it is shown, the usual rules');
    service.select('org.mpris.MediaPlayer2.other');
    focus.window = {pid: 2, appId: null};
    focus.emit('changed');
    eq(service.playback?.key, 'org.mpris.MediaPlayer2.other', 'chosen by hand');
    service.stop();
    eq(focus.listenerCount?.('changed') ?? 0, 0, 'stop() lets go of the focus');
});

await done();
