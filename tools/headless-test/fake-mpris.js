// SPDX-License-Identifier: GPL-3.0-or-later
// A fake MPRIS media player for the headless checks (checks.js), run as
// its own process on the test Shell's PRIVATE session bus:
//
//   gjs -m fake-mpris.js --names org.mpris.MediaPlayer2.a[,…] --work DIR
//       [--identity NAME] [--desktop-entry ID] [--can-raise] [--track-list]
//       [--omit Prop,…] [--http]
//
// The checks drive it through org.froonty.TestPlayer at /org/froonty/
// TestPlayer (on the same connection, so reachable through its MPRIS
// name): Set(a{sv}) (properties, Metadata, and x-fail / x-delay /
// x-ignore-set-position / x-tracks / x-http-delay), EmitSeeked(x),
// Calls() → s (JSON), ClearCalls(), Quit().
//
// It writes a red 64×64 cover to DIR/cover-<first name's suffix>.png. With
// --http it also serves, on 127.0.0.1 only, /cover.png (the same cover)
// and /api/get (lrclib-shaped lyrics), logs each request into Calls, and
// writes its port to DIR/fake-<suffix>.port.

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {FakePlayer} from '../unit/fakeMpris.js';

function parseArgs(argv) {
    const options = {names: [], work: GLib.get_tmp_dir(), omit: [], http: false,
        identity: 'Test Player', desktopEntry: null, canRaise: false, hasTrackList: false};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => argv[++i];
        switch (arg) {
        case '--names': options.names = next().split(','); break;
        case '--work': options.work = next(); break;
        case '--identity': options.identity = next(); break;
        case '--desktop-entry': options.desktopEntry = next(); break;
        case '--can-raise': options.canRaise = true; break;
        case '--track-list': options.hasTrackList = true; break;
        case '--omit': options.omit = next().split(','); break;
        case '--http': options.http = true; break;
        }
    }
    return options;
}

const options = parseArgs(ARGV);
const suffix = options.names[0].replace('org.mpris.MediaPlayer2.', '');
const loop = new GLib.MainLoop(null, false);
const connection = Gio.DBus.session;
const fake = new FakePlayer(connection, {
    names: options.names,
    identity: options.identity,
    desktopEntry: options.desktopEntry,
    canRaise: options.canRaise,
    hasTrackList: options.hasTrackList,
    omit: options.omit,
});

// The cover: saturated red, 64×64.
const cover = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 64, 64);
cover.fill(0xdd2222ff);
cover.savev(GLib.build_filenamev([options.work, `cover-${suffix}.png`]), 'png', [], []);
const [, coverBytes] = cover.save_to_bufferv('png', [], []);

let httpDelay = 0;
let server = null;
if (options.http) {
    server = new Soup.Server({});
    const log = (path, query) => fake.calls.push({
        method: 'HTTP',
        args: [query ? `${path}?${Object.entries(query).map(([k, v]) => `${k}=${v}`).join('&')}` : path],
    });
    const reply = (message, respond) => {
        if (httpDelay > 0) {
            message.pause();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, httpDelay, () => {
                respond();
                message.unpause();
                return GLib.SOURCE_REMOVE;
            });
        } else {
            respond();
        }
    };
    server.add_handler('/cover.png', (_server, message, path, query) => {
        log(path, query);
        reply(message, () => {
            message.set_status(200, null);
            message.set_response('image/png', Soup.MemoryUse.COPY, coverBytes);
        });
    });
    server.add_handler('/api/get', (_server, message, path, query) => {
        log(path, query);
        reply(message, () => {
            const body = JSON.stringify({
                trackName: query?.track_name ?? '',
                artistName: query?.artist_name ?? '',
                albumName: query?.album_name ?? '',
                duration: Number(query?.duration ?? 0),
                instrumental: false,
                plainLyrics: 'Online one\nOnline two',
                syncedLyrics: '[00:01.00]Online one\n[00:20.00]Online two',
            });
            message.set_status(200, null);
            message.set_response('application/json', Soup.MemoryUse.COPY, new TextEncoder().encode(body));
        });
    });
    server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
    const port = server.get_uris()[0].get_port();
    GLib.file_set_contents(GLib.build_filenamev([options.work, `fake-${suffix}.port`]), String(port));
}

const CONTROL = `<node><interface name="org.froonty.TestPlayer">
    <method name="Set"><arg direction="in" type="a{sv}"/></method>
    <method name="EmitSeeked"><arg direction="in" type="x"/></method>
    <method name="Calls"><arg direction="out" type="s"/></method>
    <method name="ClearCalls"/>
    <method name="Quit"/>
</interface></node>`;

const control = Gio.DBusExportedObject.wrapJSObject(CONTROL, {
    Set(values) {
        const state = {};
        for (const [key, variant] of Object.entries(values)) {
            switch (key) {
            case 'x-fail': fake.failMethods = new Set(variant.deepUnpack()); break;
            case 'x-delay': fake.delayMs = variant.deepUnpack(); break;
            case 'x-ignore-set-position': fake.ignoreSetPosition = variant.deepUnpack(); break;
            case 'x-http-delay': httpDelay = variant.deepUnpack(); break;
            case 'x-tracks':
                fake.tracks = variant.deepUnpack().map(entry => ({
                    id: entry['mpris:trackid'].deepUnpack(),
                    metadata: entry,
                }));
                fake.emitTrackListReplaced();
                break;
            // a{sv}: its values stay variants (wrong types on purpose).
            case 'Metadata': state.Metadata = variant.deepUnpack(); break;
            default: state[key] = variant.deepUnpack();
            }
        }
        fake.set(state);
    },
    EmitSeeked(us) {
        fake.emitSeeked(us);
    },
    Calls() {
        return JSON.stringify(fake.calls);
    },
    ClearCalls() {
        fake.calls = [];
    },
    Quit() {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            fake.destroy();
            control.unexport();
            server?.disconnect();
            loop.quit();
            return GLib.SOURCE_REMOVE;
        });
    },
});
control.export(connection, '/org/froonty/TestPlayer');

await fake.own();
loop.run();
