// SPDX-License-Identifier: GPL-3.0-or-later
// Claude service: the plan usage Claude Code last checked, read from its
// config file, and whether this computer can reach the internet. No St;
// unit-tested with plain gjs.
//
// Froonty never asks Claude itself: no network access, no sign-in, no
// token. Claude Code checks the account's limits while it runs and caches
// the answer in its config file (at most once a minute). The tab's
// livenerf row is the exception: given a `benchmark` (LivenerfService),
// shown and online, it fetches livenerf's README from GitHub.
//
// Nothing runs while the tab is not on screen. Each time it is shown, the
// file is read again (user request: refresh on every visit, never poll);
// while it stays shown, a file monitor and the network monitor bring in
// changes as they happen. Hidden, both are disconnected.
//
// Emits 'changed' when the usage, the error, the connection or the
// benchmark changes.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Emitter} from '../../core/emitter.js';
import {usageFromConfig} from './usage.js';

for (const method of ['load_contents_async', 'query_info_async'])
    Gio._promisify(Gio.File.prototype, method);

// The file also holds Claude Code's settings and project list; a much
// larger one is not parsed on the Shell's main thread.
const MAX_FILE_SIZE = 16 << 20;

/**
 * Claude Code's config file, found the way Claude Code finds it: a legacy
 * .config.json in its config folder wins, then .claude.json in
 * $CLAUDE_CONFIG_DIR, or in the home folder.
 */
export function configFile() {
    const dir = GLib.getenv('CLAUDE_CONFIG_DIR') || null;
    const home = GLib.get_home_dir();
    const legacy = Gio.File.new_for_path(GLib.build_filenamev(
        [dir ?? GLib.build_filenamev([home, '.claude']), '.config.json']));
    if (legacy.query_exists(null))
        return legacy;
    return Gio.File.new_for_path(GLib.build_filenamev([dir ?? home, '.claude.json']));
}

export class ClaudeService extends Emitter {
    /**
     * @param {object} [options]
     * @param {Function} [options.file] () → Gio.File to read (tests)
     * @param {Gio.NetworkMonitor} [options.network] (tests)
     * @param {LivenerfService} [options.benchmark] livenerf's results, or
     *   null for none (the panic button)
     */
    constructor({file = configFile, network = null, benchmark = null} = {}) {
        super();
        this._fileFor = file;
        this._network = network;

        /** LivenerfService, or null. */
        this.benchmark = benchmark;
        this.benchmark?.connect('changed', () => this.emit('changed'));

        /** {fetchedAt, windows} (usage.js), or null when there is none. */
        this.usage = null;
        /** 'missing' (no file), 'unreadable', or null. */
        this.error = null;
        /** Whether this computer can reach the internet. */
        this.online = true;
        /** False until the file has been read once. */
        this.loaded = false;

        this._active = false;
        this._monitor = null;
        this._networkIds = [];
        this._reading = null;
        this._readAgain = false;
        this._cancellable = null;
    }

    start() {
        this._cancellable = new Gio.Cancellable();
        this.benchmark?.start();
    }

    stop() {
        this.setActive(false);
        this._cancellable?.cancel();
        this._cancellable = null;
        this.benchmark?.stop();
    }

    /** Shown: read now and watch; hidden: stop watching. */
    setActive(active) {
        if (active === this._active)
            return;
        this._active = active;
        if (active) {
            this._watchNetwork();
            this._watchFile();
            this.refresh();
            this._refreshBenchmark();
        } else {
            this._monitor?.cancel();
            this._monitor = null;
            this._networkIds.forEach(id => this._network.disconnect(id));
            this._networkIds = [];
        }
    }

    /**
     * Reads the file again. Calls made while a read runs are folded into one
     * more read after it, so a burst of writes costs at most two reads.
     *
     * @returns {Promise} resolves when the file has been read (for tests)
     */
    refresh() {
        if (this._reading) {
            this._readAgain = true;
            return this._reading;
        }
        this._reading = (async () => {
            do {
                this._readAgain = false;
                await this._read();
            } while (this._readAgain && this._active);
        })().finally(() => {
            this._reading = null;
        });
        return this._reading;
    }

    _watchNetwork() {
        this._network ??= Gio.NetworkMonitor.get_default();
        // NetworkManager's backend reports its connectivity check only as
        // property changes; 'network-changed' comes with route changes.
        this._networkIds = ['network-changed', 'notify::connectivity', 'notify::network-available']
            .map(signal => this._network.connect(signal, () => this._syncOnline()));
        this._syncOnline();
    }

    // Full connectivity only: a network without internet (LOCAL), one that
    // reaches only part of it (LIMITED) or a captive portal cannot reach
    // Claude either.
    _syncOnline() {
        const online = this._network.network_available &&
            this._network.connectivity === Gio.NetworkConnectivity.FULL;
        if (online === this.online)
            return;
        this.online = online;
        this.emit('changed');
        this._refreshBenchmark();
    }

    // Shown and online only; the benchmark skips a fetch within the hour.
    _refreshBenchmark() {
        if (this._active && this.online)
            this.benchmark?.refresh();
    }

    // The file's folder is watched too (Gio does this for a file monitor), so
    // a write that replaces the file by renaming a new one onto it counts.
    _watchFile() {
        this._file = this._fileFor();
        try {
            this._monitor = this._file.monitor_file(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._monitor.connect('changed', () => this.refresh());
        } catch (e) {
            // No monitor (e.g. the folder is gone): reads on each visit still work.
            this._monitor = null;
        }
    }

    async _read() {
        const file = this._file ?? this._fileFor();
        let usage = null;
        let error = null;
        try {
            const info = await file.query_info_async('standard::size',
                Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, this._cancellable);
            if (info.get_size() > MAX_FILE_SIZE)
                throw new Error(`${file.get_path()} is larger than ${MAX_FILE_SIZE} bytes`);
            const [bytes] = await file.load_contents_async(this._cancellable);
            usage = usageFromConfig(JSON.parse(new TextDecoder().decode(bytes)));
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                error = 'missing';
            } else if (this.usage) {
                // Most likely caught halfway through a write that does not
                // replace the file atomically: keep the last good reading,
                // the write's own event reads it again.
                return;
            } else {
                error = 'unreadable';
                if (this.error !== error)
                    console.warn(`Froonty: cannot read Claude Code's usage: ${e.message}`);
            }
        }
        if (this.loaded &&
            JSON.stringify([usage, error]) === JSON.stringify([this.usage, this.error]))
            return;
        this.loaded = true;
        this.usage = usage;
        this.error = error;
        this.emit('changed');
    }
}
