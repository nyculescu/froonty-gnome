// SPDX-License-Identifier: GPL-3.0-or-later
// A fake MPRIS media player for Froonty's tests: the unit tests export it
// on a private dbus-daemon, the headless tests run it as a separate
// process on the test Shell's private session bus (tools/headless-test/
// fake-mpris.js). Never on the real session bus: GNOME's media card would
// show it.
//
//   const fake = new FakePlayer(connection, {names: ['org.mpris.MediaPlayer2.test']});
//   await fake.own();
//   fake.set({PlaybackStatus: 'Playing', Metadata: {'xesam:title': 'Song'}});
//   fake.calls  // [{method, args}] of every method called
//
// Position is readable but never announced (as with real players);
// emitSeeked() announces a jump. failMethods reply with an error, delayMs
// answers late, ignoreSetPosition ignores SetPosition (Chromium's trackid
// rule), omit leaves properties out, types declares wrong ones.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const ROOT = 'org.mpris.MediaPlayer2';
export const PLAYER = 'org.mpris.MediaPlayer2.Player';
export const TRACKLIST = 'org.mpris.MediaPlayer2.TrackList';
export const PATH = '/org/mpris/MediaPlayer2';

const ROOT_PROPS = {
    Identity: 's', DesktopEntry: 's', CanRaise: 'b', CanQuit: 'b', HasTrackList: 'b',
    SupportedUriSchemes: 'as', SupportedMimeTypes: 'as',
};
const PLAYER_PROPS = {
    PlaybackStatus: 's', Rate: 'd', Metadata: 'a{sv}', Volume: 'd', Position: 'x',
    MinimumRate: 'd', MaximumRate: 'd', CanGoNext: 'b', CanGoPrevious: 'b', CanPlay: 'b',
    CanPause: 'b', CanSeek: 'b', CanControl: 'b',
};
const METADATA_TYPES = {
    'mpris:trackid': 'o', 'mpris:length': 'x', 'mpris:artUrl': 's', 'xesam:title': 's',
    'xesam:artist': 'as', 'xesam:album': 's', 'xesam:url': 's', 'xesam:asText': 's',
};

/** A plain metadata object as a{sv} values (GLib.Variant values kept as given). */
export function metadataVariants(metadata = {}) {
    const out = {};
    for (const [key, value] of Object.entries(metadata)) {
        if (value === undefined || value === null)
            continue;
        out[key] = value instanceof GLib.Variant ? value
            : new GLib.Variant(METADATA_TYPES[key] ?? 's', value);
    }
    return out;
}

function propertiesXml(props, omit) {
    return Object.entries(props).filter(([name]) => !omit.includes(name))
        .map(([name, type]) => `<property name="${name}" type="${type}" access="read"/>`).join('');
}

function interfacesXml({types, omit}) {
    const player = {...PLAYER_PROPS, ...types};
    return {
        root: `<node><interface name="${ROOT}">
            <method name="Raise"/><method name="Quit"/>
            ${propertiesXml(ROOT_PROPS, omit)}</interface></node>`,
        player: `<node><interface name="${PLAYER}">
            <method name="Next"/><method name="Previous"/><method name="Pause"/>
            <method name="PlayPause"/><method name="Stop"/><method name="Play"/>
            <method name="Seek"><arg direction="in" type="x"/></method>
            <method name="SetPosition"><arg direction="in" type="o"/><arg direction="in" type="x"/></method>
            <method name="OpenUri"><arg direction="in" type="s"/></method>
            <signal name="Seeked"><arg type="x"/></signal>
            ${propertiesXml(player, omit)}</interface></node>`,
        tracklist: `<node><interface name="${TRACKLIST}">
            <method name="GetTracksMetadata"><arg direction="in" type="ao"/><arg direction="out" type="aa{sv}"/></method>
            <method name="AddTrack"><arg direction="in" type="s"/><arg direction="in" type="o"/><arg direction="in" type="b"/></method>
            <method name="RemoveTrack"><arg direction="in" type="o"/></method>
            <method name="GoTo"><arg direction="in" type="o"/></method>
            <signal name="TrackListReplaced"><arg type="ao"/><arg type="o"/></signal>
            <signal name="TrackAdded"><arg type="a{sv}"/><arg type="o"/></signal>
            <signal name="TrackRemoved"><arg type="o"/></signal>
            <signal name="TrackMetadataChanged"><arg type="o"/><arg type="a{sv}"/></signal>
            <property name="Tracks" type="ao" access="read"/>
            <property name="CanEditTracks" type="b" access="read"/>
            </interface></node>`,
    };
}

const METHODS = ['Next', 'Previous', 'Pause', 'PlayPause', 'Stop', 'Play', 'Seek',
    'SetPosition', 'OpenUri', 'Raise', 'Quit', 'GoTo'];

export class FakePlayer {
    /**
     * @param {Gio.DBusConnection} connection
     * @param {object} [options]
     * @param {string[]} [options.names] well-known names to own
     * @param {string} [options.identity]
     * @param {?string} [options.desktopEntry]
     * @param {boolean} [options.canRaise]
     * @param {boolean} [options.hasTrackList] also export a TrackList
     * @param {object} [options.types] Player property → declared type (wrong types)
     * @param {string[]} [options.omit] properties left out
     */
    constructor(connection, {names = ['org.mpris.MediaPlayer2.froonty-test'], identity = 'Test Player',
        desktopEntry = null, canRaise = false, hasTrackList = false, types = {}, omit = []} = {}) {
        this.connection = connection;
        this.names = names;
        this.calls = [];
        this.failMethods = new Set();
        this.delayMs = 0;
        this.ignoreSetPosition = false;
        this.root = {
            Identity: identity,
            DesktopEntry: desktopEntry ?? '',
            CanRaise: canRaise,
            CanQuit: false,
            HasTrackList: hasTrackList,
            SupportedUriSchemes: [],
            SupportedMimeTypes: [],
        };
        this.state = {
            PlaybackStatus: 'Stopped',
            Rate: 1.0,
            Metadata: {},
            Volume: 1.0,
            Position: 0,
            MinimumRate: 1.0,
            MaximumRate: 1.0,
            CanGoNext: true,
            CanGoPrevious: true,
            CanPlay: true,
            CanPause: true,
            CanSeek: true,
            CanControl: true,
        };
        this.types = {...PLAYER_PROPS, ...types};
        /** TrackList: [{id, metadata}] and the current id. */
        this.tracks = [];
        this._ownerIds = [];
        const xml = interfacesXml({types, omit});
        this._root = this._export(xml.root, ROOT, this.root, ROOT_PROPS);
        this._player = this._export(xml.player, PLAYER, null, this.types);
        this._trackList = hasTrackList ? this._export(xml.tracklist, TRACKLIST, null, {}) : null;
    }

    _export(xml, iface, values, types) {
        const impl = {};
        for (const name of Object.keys({...types, Tracks: 'ao', CanEditTracks: 'b'})) {
            Object.defineProperty(impl, name, {get: () => this._get(iface, name)});
        }
        for (const method of METHODS) {
            impl[`${method}Async`] = (params, invocation) => this._method(method, params, invocation);
        }
        impl.GetTracksMetadata = ids => ids.map(id => metadataVariants(
            this.tracks.find(t => t.id === id)?.metadata ?? {'mpris:trackid': id}));
        const exported = Gio.DBusExportedObject.wrapJSObject(xml, impl);
        exported.export(this.connection, PATH);
        return exported;
    }

    _get(iface, name) {
        if (iface === ROOT)
            return this.root[name];
        if (iface === TRACKLIST)
            return name === 'Tracks' ? this.tracks.map(t => t.id) : false;
        if (name === 'Metadata')
            return metadataVariants(this.state.Metadata);
        const value = this.state[name];
        // A declared wrong type: give something of that type.
        const type = this.types[name];
        if (type !== PLAYER_PROPS[name]) {
            if (type === 's')
                return String(value);
            if (type === 'b')
                return Boolean(value);
            if (type === 'i' || type === 'x' || type === 'd')
                return Number(value) || 0;
        }
        return value;
    }

    _method(method, params, invocation) {
        this.calls.push({method, args: params});
        const reply = () => {
            if (this.failMethods.has(method)) {
                invocation.return_dbus_error('org.mpris.MediaPlayer2.Error.Failed', `${method} failed`);
                return;
            }
            this._apply(method, params);
            invocation.return_value(null);
        };
        if (this.delayMs > 0) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.delayMs, () => {
                reply();
                return GLib.SOURCE_REMOVE;
            });
        } else {
            reply();
        }
    }

    _apply(method, params) {
        switch (method) {
        case 'Play':
            this.set({PlaybackStatus: 'Playing'});
            break;
        case 'Pause':
            this.set({PlaybackStatus: 'Paused'});
            break;
        case 'PlayPause':
            this.set({PlaybackStatus: this.state.PlaybackStatus === 'Playing' ? 'Paused' : 'Playing'});
            break;
        case 'SetPosition':
            if (!this.ignoreSetPosition)
                this.state.Position = params[1];
            break;
        case 'Seek':
            this.state.Position = Math.max(0, this.state.Position + params[0]);
            break;
        case 'GoTo': {
            const track = this.tracks.find(t => t.id === params[0]);
            if (track)
                this.set({Metadata: track.metadata});
            break;
        }
        }
    }

    /** Owns every name; resolves once all are owned. */
    own() {
        return Promise.all(this.names.map(name => new Promise((resolve, reject) => {
            this._ownerIds.push(Gio.bus_own_name_on_connection(this.connection, name,
                Gio.BusNameOwnerFlags.NONE, () => resolve(), () => reject(new Error(`lost ${name}`))));
        })));
    }

    unown() {
        for (const id of this._ownerIds)
            Gio.bus_unown_name(id);
        this._ownerIds = [];
    }

    /**
     * Changes properties; each change is announced (PropertiesChanged),
     * except Position, as with real players.
     */
    set(state) {
        for (const [name, value] of Object.entries(state)) {
            this.state[name] = value;
            if (name === 'Position' || !(name in this.types))
                continue;
            const type = this.types[name];
            const variant = name === 'Metadata'
                ? new GLib.Variant('a{sv}', metadataVariants(value))
                : new GLib.Variant(type, this._get(PLAYER, name));
            this._player.emit_property_changed(name, variant);
        }
        this._player.flush();
    }

    emitSeeked(us) {
        this.state.Position = us;
        this._player.emit_signal('Seeked', new GLib.Variant('(x)', [us]));
    }

    emitTrackListReplaced() {
        this._trackList?.emit_signal('TrackListReplaced',
            new GLib.Variant('(ao)', [this.tracks.map(t => t.id)]));
    }

    destroy() {
        this.unown();
        for (const exported of [this._root, this._player, this._trackList])
            exported?.unexport();
    }
}

/**
 * A private dbus-daemon for unit tests, and a connection to it.
 *
 * @returns {Promise<{connection, address, connect, stop}>}
 */
export async function privateBus() {
    // Unix socket paths are limited to 108 bytes: a long TMPDIR gets a
    // short private folder in the runtime dir instead.
    let dir = GLib.getenv('TMPDIR') || GLib.get_tmp_dir();
    let made = null;
    if (dir.length > 60) {
        dir = made = GLib.build_filenamev([GLib.get_user_runtime_dir(),
            `froonty-bus-${new Gio.Credentials().get_unix_pid()}-${GLib.random_int()}`]);
        GLib.mkdir_with_parents(made, 0o700);
    }
    const daemon = Gio.Subprocess.new(['/usr/bin/dbus-daemon', '--session', '--nofork',
        '--print-address=1', `--address=unix:dir=${dir}`], Gio.SubprocessFlags.STDOUT_PIPE);
    const stdout = new Gio.DataInputStream({base_stream: daemon.get_stdout_pipe()});
    const address = await new Promise((resolve, reject) => {
        stdout.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, result) => {
            try {
                const [line] = stream.read_line_finish_utf8(result);
                resolve(line.trim());
            } catch (e) {
                reject(e);
            }
        });
    });
    const connect = () => new Promise((resolve, reject) => {
        Gio.DBusConnection.new_for_address(address,
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT |
            Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, null, null, (_o, result) => {
                try {
                    resolve(Gio.DBusConnection.new_for_address_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
    });
    const connection = await connect();
    return {
        connection,
        address,
        connect,
        stop: () => {
            daemon.force_exit();
            if (made)
                GLib.spawn_command_line_async(`rm -rf ${GLib.shell_quote(made)}`);
        },
    };
}
