// SPDX-License-Identifier: GPL-3.0-or-later
// Media tab over D-Bus (froonty@catalin/features/media/mpris.js, service.js,
// queue.js) against fake players (fakeMpris.js) on a PRIVATE dbus-daemon
// started here. The real session bus is never used: a fake there would
// show in GNOME's own media card.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {MprisWatcher, busCall} from '../../froonty@catalin/features/media/mpris.js';
import {MediaService} from '../../froonty@catalin/features/media/service.js';
import {QueueClient} from '../../froonty@catalin/features/media/queue.js';
import {glibTimers} from '../../froonty@catalin/features/media/model.js';
import {FakePlayer, privateBus} from './fakeMpris.js';
import {done, eq, ok, test} from './test.js';

const NAME = 'org.mpris.MediaPlayer2.froontytest';
const bus = await privateBus();

const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

async function waitFor(predicate, ms = 3000) {
    for (let waited = 0; waited < ms; waited += 20) {
        if (predicate())
            return true;
        // eslint-disable-next-line no-await-in-loop
        await sleep(20);
    }
    return predicate();
}

async function fake(options = {}, state = {}) {
    const connection = await bus.connect();
    const player = new FakePlayer(connection, {names: [NAME], ...options});
    player.set({
        PlaybackStatus: 'Playing',
        Metadata: {
            'xesam:title': 'Song', 'xesam:artist': ['Band'], 'xesam:album': 'Album',
            'mpris:length': 180e6, 'mpris:trackid': '/org/froonty/track/1',
        },
        ...state,
    });
    await player.own();
    player.close = () => {
        player.destroy();
        connection.close(null, null);
    };
    return player;
}

function settings(values = {}) {
    const all = {'media-include-other-players': true, 'media-remote-art': false, ...values};
    return {get_boolean: key => all[key], connect: () => 1, disconnect: () => {}};
}

function service(options = {}) {
    const media = new MediaService({
        settings: settings(),
        watcher: new MprisWatcher({bus: bus.connection}),
        ...options,
    });
    media.start();
    return media;
}

test('D1 finds a player already on the bus', async () => {
    const player = await fake();
    const watcher = new MprisWatcher({bus: bus.connection});
    watcher.start();
    try {
        ok(await waitFor(() => watcher.ready && watcher.players.has(NAME)), 'listed');
        const found = watcher.players.get(NAME);
        eq([found.track.title, found.track.artist, found.props.playing, found.pid],
            ['Song', 'Band', true, new Gio.Credentials().get_unix_pid()]);
    } finally {
        watcher.stop();
        player.close();
    }
});

test('D2 finds a player that appears later and forgets one that leaves', async () => {
    const watcher = new MprisWatcher({bus: bus.connection});
    watcher.start();
    try {
        ok(await waitFor(() => watcher.ready));
        eq(watcher.players.size, 0);
        const player = await fake();
        ok(await waitFor(() => watcher.players.has(NAME)), 'appeared');
        player.close();
        ok(await waitFor(() => !watcher.players.has(NAME)), 'left');
    } finally {
        watcher.stop();
    }
});

test('D3 one \'changed\' per burst of property changes', async () => {
    const player = await fake();
    const watcher = new MprisWatcher({bus: bus.connection});
    watcher.start();
    try {
        ok(await waitFor(() => watcher.players.has(NAME)));
        await sleep(100);
        let changes = 0;
        watcher.connect('changed', () => changes++);
        for (let i = 0; i < 20; i++)
            player.set({Metadata: {'xesam:title': `Song ${i}`}});
        ok(await waitFor(() => watcher.players.get(NAME).track.title === 'Song 19'));
        await sleep(100);
        ok(changes >= 1 && changes <= 2, `${changes} changes for 20 updates`);
    } finally {
        watcher.stop();
        player.close();
    }
});

test('D4 Seeked updates the sample at once; Position is read with Get, not the cache', async () => {
    const player = await fake({}, {Position: 10e6});
    const media = service();
    try {
        media.watchPosition(true);
        ok(await waitFor(() => media.hasPosition), 'position read on show');
        ok(Math.abs(media.positionUs() - 10e6) < 0.5e6, `${media.positionUs()}`);
        player.state.Position = 50e6; // silently, as players do
        await sleep(100);
        ok(media.positionUs() < 20e6, 'no change without a signal');
        player.emitSeeked(30e6);
        ok(await waitFor(() => Math.abs(media.positionUs() - 30e6) < 0.5e6), `${media.positionUs()}`);
        player.state.Position = 70e6;
        media.watchPosition(false);
        media.watchPosition(true);
        ok(await waitFor(() => Math.abs(media.positionUs() - 70e6) < 0.5e6), 'read afresh on show');
    } finally {
        media.stop();
        player.close();
    }
});

test('D5 commands reach the shown owner (Play, Pause, Next, Previous, SetPosition with the trackid)', async () => {
    const player = await fake();
    const media = service();
    try {
        ok(await waitFor(() => media.playback?.playing));
        eq(await media.playPause(media.context()), true);
        ok(await waitFor(() => media.playback?.playing === false), 'paused');
        eq(await media.playPause(media.context()), true);
        eq(await media.next(media.context()), true);
        eq(await media.previous(media.context()), true);
        eq(await media.seek(90, media.context()), true);
        const calls = player.calls.map(c => c.method);
        eq(calls, ['Pause', 'Play', 'Next', 'Previous', 'SetPosition']);
        eq(player.calls[4].args, ['/org/froonty/track/1', 90e6]);
    } finally {
        media.stop();
        player.close();
    }
});

test('D6 Seek(offset) when the trackid is NoTrack', async () => {
    const player = await fake({}, {
        Position: 10e6,
        Metadata: {
            'xesam:title': 'Song', 'mpris:length': 180e6,
            'mpris:trackid': '/org/mpris/MediaPlayer2/TrackList/NoTrack',
        },
    });
    const media = service();
    try {
        media.watchPosition(true);
        ok(await waitFor(() => media.hasPosition));
        eq(await media.seek(60, media.context()), true);
        const seek = player.calls.find(c => c.method === 'Seek');
        ok(seek && Math.abs(seek.args[0] - 50e6) < 1e6, JSON.stringify(player.calls));
    } finally {
        media.stop();
        player.close();
    }
});

test('D7 a command to a restarted player fails instead of reaching the new process', async () => {
    const first = await fake();
    const media = service();
    let second = null;
    try {
        ok(await waitFor(() => media.playback !== null));
        const context = media.context();
        const oldOwner = context.owner;
        first.close();
        second = await fake();
        ok(await waitFor(() => media.playback && media.playback.owner !== oldOwner), 'the new owner shows');
        eq(media.sources.length, 1, 'one source, no duplicate');
        eq(await media.next(context), false);
        await sleep(100);
        eq(second.calls.length, 0, 'nothing reached the new process');
        // And on the bus itself: the old unique name is gone for good.
        let failed = false;
        try {
            await busCall(bus.connection, {
                name: oldOwner, path: '/org/mpris/MediaPlayer2',
                iface: 'org.mpris.MediaPlayer2.Player', method: 'Next',
            });
        } catch {
            failed = true;
        }
        ok(failed && second.calls.length === 0);
    } finally {
        media.stop();
        second?.close();
    }
});

test('D8 a command whose track changed before sending is not sent', async () => {
    const player = await fake();
    const media = service();
    try {
        ok(await waitFor(() => media.playback !== null));
        const context = media.context();
        player.set({Metadata: {'xesam:title': 'Another song', 'mpris:length': 100e6}});
        const sent = await media.next(context);
        eq(sent, false);
        eq(player.calls.filter(c => c.method === 'Next').length, 0);
    } finally {
        media.stop();
        player.close();
    }
});

test('D9 a command without a reply in 2 s fails', async () => {
    const player = await fake();
    const media = service();
    try {
        ok(await waitFor(() => media.playback !== null));
        player.delayMs = 3000;
        const started = GLib.get_monotonic_time();
        eq(await media.next(media.context()), false);
        const took = (GLib.get_monotonic_time() - started) / 1000;
        ok(took >= 1900 && took < 2900, `${took} ms`);
        ok(media.commandFailed, 'the failure is shown');
        player.delayMs = 0;
        eq(await media.next(media.context()), true);
        ok(!media.commandFailed, 'cleared by the next command');
        await sleep(1200);
    } finally {
        media.stop();
        player.close();
    }
});

test('D10 mirror names are one source; playerctld is ignored', async () => {
    const vlc = await fake({names: ['org.mpris.MediaPlayer2.vlc', 'org.mpris.MediaPlayer2.vlc.instance4242']});
    const ctld = await fake({names: ['org.mpris.MediaPlayer2.playerctld']});
    const media = service();
    try {
        ok(await waitFor(() => media.watcher.players.size === 2));
        await sleep(100);
        eq(media.sources.map(s => s.key), ['org.mpris.MediaPlayer2.vlc']);
        ok(!media.watcher.players.has('org.mpris.MediaPlayer2.playerctld'));
    } finally {
        media.stop();
        vlc.close();
        ctld.close();
    }
});

test('D11 wrong types in Metadata or properties do not throw', async () => {
    const player = await fake({types: {Rate: 's', CanSeek: 's', PlaybackStatus: 'i'}}, {
        Metadata: {
            'xesam:title': 'Song', 'xesam:artist': new GLib.Variant('i', 3),
            'mpris:length': new GLib.Variant('s', 'long'), 'mpris:artUrl': new GLib.Variant('as', ['x']),
        },
    });
    const media = service();
    try {
        // Not playing (PlaybackStatus is not a string), and not a music app:
        // listed, but not shown automatically.
        ok(await waitFor(() => media.sources.length === 1));
        const {track, props} = media.watcher.players.get(NAME);
        eq([track.title, track.artist, track.lengthUs, track.artUrl, props.rate, props.canSeek, props.status],
            ['Song', null, null, null, 1, false, 'Stopped']);
        eq(media.playback, null);
    } finally {
        media.stop();
        player.close();
    }
});

test('D12 stop() unsubscribes and cancels: later signals change nothing; a pending proxy is cancelled', async () => {
    const watcher = new MprisWatcher({bus: bus.connection});
    watcher.start();
    ok(await waitFor(() => watcher.ready));
    let changes = 0;
    watcher.connect('changed', () => changes++);
    watcher.stop();
    const player = await fake();
    await sleep(300);
    try {
        eq([watcher.players.size, changes], [0, 0]);
        // A player being read when stop() comes: its reads are cancelled.
        const again = new MprisWatcher({bus: bus.connection});
        again.start();
        const owner = (await busCall(bus.connection, {
            name: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', iface: 'org.freedesktop.DBus',
            method: 'GetNameOwner', params: new GLib.Variant('(s)', [NAME]), replyType: '(s)',
        })).deepUnpack()[0];
        const adding = again._add('org.mpris.MediaPlayer2.extra', owner);
        const pending = [...again._pending];
        again.stop();
        await adding;
        ok(pending.length > 0 && pending.every(p => p.cancellable.is_cancelled()), `${pending.length}`);
        await sleep(300);
        eq(again.players.size, 0);
    } finally {
        player.close();
    }
});

test('D13 at most 16 players', async () => {
    const names = Array.from({length: 18}, (_, i) => `org.mpris.MediaPlayer2.many${i}`);
    const player = await fake({names});
    const watcher = new MprisWatcher({bus: bus.connection});
    watcher.start();
    try {
        ok(await waitFor(() => watcher.ready));
        await sleep(300);
        eq(watcher.players.size, 16);
        ok(watcher._warnedFull, 'warned (once per watcher)');
    } finally {
        watcher.stop();
        player.close();
    }
});

test('D14 TrackList: GetTracksMetadata and GoTo, proxy only while watched', async () => {
    const player = await fake({hasTrackList: true}, {
        Metadata: {'xesam:title': 'One', 'mpris:trackid': '/t/1', 'mpris:length': 100e6},
    });
    player.tracks = [1, 2, 3].map(i => ({
        id: `/t/${i}`,
        metadata: {'xesam:title': ['One', 'Two', 'Three'][i - 1], 'mpris:trackid': `/t/${i}`, 'xesam:artist': ['A']},
    }));
    const media = service();
    const queue = new QueueClient({media, timers: glibTimers});
    try {
        ok(await waitFor(() => media.playback?.hasTrackList));
        ok(!queue.subscribed, 'nothing followed while closed');
        queue.setOpen(true);
        ok(await waitFor(() => queue.state === 'ready'), queue.state);
        ok(queue.subscribed);
        eq(queue.rows.map(r => [r.offset, r.title]), [[1, 'Two'], [2, 'Three']]);
        eq(await queue.playNow(queue.rows[1], media.context()), true);
        eq(player.calls.at(-1), {method: 'GoTo', args: ['/t/3']});
        ok(await waitFor(() => media.playback?.track.title === 'Three'));
        await sleep(1700);
        eq(queue.notice, null, 'the switch was seen');
        player.ignoreGoTo = true;
        queue.setOpen(false);
        ok(!queue.subscribed, 'unsubscribed on close');
    } finally {
        queue.destroy();
        media.stop();
        player.close();
    }
});

class FakeTimers {
    constructor() {
        this.next = 1;
        this.pending = new Map();
        this.t = 0;
    }

    add(ms, callback) {
        const id = this.next++;
        this.pending.set(id, {at: this.t + ms * 1000, callback});
        return id;
    }

    idle(callback) {
        return glibTimers.idle(callback);
    }

    remove(id) {
        if (this.pending.has(id))
            this.pending.delete(id);
        else
            GLib.source_remove(id);
    }

    now() {
        return GLib.get_monotonic_time();
    }

    advance(ms) {
        this.t += ms * 1000;
        for (const [id, p] of [...this.pending].sort((a, b) => a[1].at - b[1].at)) {
            if (p.at <= this.t && this.pending.has(id)) {
                this.pending.delete(id);
                p.callback();
            }
        }
    }
}

test('D15 service on a fake clock: gap, grace, notice debounce, peek-ready signal', async () => {
    const player = await fake();
    const timers = new FakeTimers();
    const media = service({timers, watcher: new MprisWatcher({bus: bus.connection})});
    const started = [];
    media.connect('track-started', (_m, info) => started.push(info.title));
    try {
        ok(await waitFor(() => media.playback?.track.title === 'Song'));
        for (const title of ['B', 'C', 'D']) {
            player.set({Metadata: {'xesam:title': title, 'xesam:artist': ['X'], 'mpris:length': 100e6}});
            // eslint-disable-next-line no-await-in-loop
            ok(await waitFor(() => media.playback?.track.title === title));
            timers.advance(100);
        }
        eq(started, [], 'debounced while songs change quickly');
        timers.advance(500);
        eq(started, ['D'], 'one notice, for the last song');
        player.set({Metadata: {}});
        ok(await waitFor(() => media.playback?.held === true), 'the gap holds the song');
        timers.advance(1000);
        eq(media.playback?.track.title, 'D');
        timers.advance(600);
        eq(media.playback, null, 'then nothing');
        player.set({Metadata: {'xesam:title': 'E', 'mpris:length': 100e6}});
        ok(await waitFor(() => media.playback?.track.title === 'E'));
        media.select(null);
    } finally {
        media.stop();
        player.close();
    }
});

test('D16 service: position stuck at 0 hides the timeline after the 3 s check', async () => {
    const player = await fake({}, {Position: 0});
    const timers = new FakeTimers();
    const media = service({timers, watcher: new MprisWatcher({bus: bus.connection})});
    try {
        ok(await waitFor(() => media.playback !== null));
        media.watchPosition(true);
        ok(await waitFor(() => media.hasPosition), 'shown at first');
        timers.advance(3000);
        ok(await waitFor(() => !media.hasPosition), 'hidden after the check');
        ok(!media.ticking, 'no tick without a position');
        player.emitSeeked(20e6);
        ok(await waitFor(() => media.hasPosition), 'a real position brings it back');
    } finally {
        media.stop();
        player.close();
    }
});

test('D17 pause all, then resume only what it paused', async () => {
    const a = await fake({names: ['org.mpris.MediaPlayer2.a']});
    const b = await fake({names: ['org.mpris.MediaPlayer2.b']}, {Metadata: {'xesam:title': 'Other'}});
    const c = await fake({names: ['org.mpris.MediaPlayer2.c']}, {PlaybackStatus: 'Paused', Metadata: {'xesam:title': 'Third'}});
    const media = service();
    try {
        ok(await waitFor(() => media.sources.length === 3));
        const held = await media.pauseAll();
        eq(held.map(h => h.key).sort(), ['org.mpris.MediaPlayer2.a', 'org.mpris.MediaPlayer2.b']);
        ok(await waitFor(() => held.every(h => media.stillPaused(h))));
        await media.resume(held);
        eq([a.calls.map(x => x.method), b.calls.map(x => x.method), c.calls.map(x => x.method)],
            [['Pause', 'Play'], ['Pause', 'Play'], []]);
    } finally {
        media.stop();
        for (const p of [a, b, c])
            p.close();
    }
});

test('D-end: the private bus is stopped', () => {
    bus.stop();
});

await done();
