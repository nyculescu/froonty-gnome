// SPDX-License-Identifier: GPL-3.0-or-later
// Claude service: the plan usage Claude Code last checked, read from its
// config file, merged with what Froonty's status line saved, and whether
// this computer can reach the internet. No St; unit-tested with plain gjs.
//
// Froonty never asks Claude itself: no sign-in, no token. Two sources:
// - Claude Code caches the account's limits in its config file, but only
//   when it checks them (its /usage command, VS Code's Account & Usage).
//   Given a refresher (refresher.js), showing the tab runs that /usage
//   (A), unless the setting is off or the laptop is in low power.
// - Froonty's Claude Code status line (statusline.py) saves Session and
//   Weekly after each Claude Code reply (B). Whichever is newer wins.
// The tab's livenerf row is separate: given a `benchmark`
// (LivenerfService), shown and online, it fetches livenerf's README from
// GitHub.
//
// Nothing runs while the tab is not on screen. Each time it is shown, the
// files are read again (user request: refresh on every visit, never poll);
// while it stays shown, file monitors and the network monitor bring in
// changes as they happen. Hidden, all are disconnected.
//
// Emits 'changed' when the usage, the error, the connection, the refresh
// mode or the benchmark changes.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Emitter} from '../../core/emitter.js';
import {acquireShared, releaseShared} from './refresher.js';
import {mergeStatusLine, statusLineFromFile, usageFromConfig} from './usage.js';

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

/** Where statusline.py saves the status line's usage. */
export function statusLineFile() {
    return Gio.File.new_for_path(GLib.build_filenamev(
        [GLib.get_user_cache_dir(), 'froonty', 'claude-status-line.json']));
}

export class ClaudeService extends Emitter {
    /**
     * @param {object} [options]
     * @param {Function} [options.file] () → Gio.File to read (tests)
     * @param {Gio.NetworkMonitor} [options.network] (tests)
     * @param {Function} [options.statusFile] () → Gio.File (tests)
     * @param {LivenerfService} [options.benchmark] livenerf's results, or
     *   null for none (the panic button)
     * @param {Gio.Settings} [options.settings] to share the Shell's
     *   refresher (refresher.js); without it or `refresher`, no runs
     * @param {ClaudeRefresher} [options.refresher] (tests)
     */
    constructor({file = configFile, statusFile = statusLineFile, network = null,
        benchmark = null, settings = null, refresher = null} = {}) {
        super();
        this._fileFor = file;
        this._statusFileFor = statusFile;
        this._network = network;
        this._settings = settings;
        this._refresher = refresher;
        this._ownsRefresher = false;
        this._refresherIds = [];

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

        /** The cache's own reading, without the status line's. */
        this._cacheUsage = null;
        this._cacheFetchedAt = null;
        this._active = false;
        this._monitor = null;
        this._statusMonitor = null;
        this._networkIds = [];
        this._reading = null;
        this._readAgain = false;
        this._cancellable = null;
    }

    start() {
        this._cancellable = new Gio.Cancellable();
        this.benchmark?.start();
        if (!this._refresher && this._settings) {
            this._refresher = acquireShared(this._settings);
            this._ownsRefresher = true;
        }
        this._refresherIds = this._refresher ? [
            this._refresher.connect('changed', () => this.emit('changed')),
            // The file monitor sees the write too; this covers a missed one.
            this._refresher.connect('done', () => this._active && this.refresh()),
        ] : [];
    }

    stop() {
        this.setActive(false);
        this._cancellable?.cancel();
        this._cancellable = null;
        this.benchmark?.stop();
        this._refresherIds.forEach(id => this._refresher.disconnect(id));
        this._refresherIds = [];
        if (this._ownsRefresher) {
            releaseShared();
            this._refresher = null;
            this._ownsRefresher = false;
        }
    }

    /**
     * How new readings arrive (refresher.js `mode`), or null without a
     * refresher.
     */
    get refreshMode() {
        if (!this._refresher)
            return null;
        return {...this._refresher.mode, found: this._refresher.found};
    }

    /** Shown: read now and watch; hidden: stop watching. */
    setActive(active) {
        if (active === this._active)
            return;
        this._active = active;
        if (active) {
            this._refresher?.setActive(true);
            this._watchNetwork();
            this._watchFile();
            // Read what there is first, then ask Claude Code for newer.
            this.refresh().then(() => this._requestFresh());
            this._refreshBenchmark();
        } else {
            this._refresher?.setActive(false);
            this._monitor?.cancel();
            this._monitor = null;
            this._statusMonitor?.cancel();
            this._statusMonitor = null;
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

    // Shown and online only; the refresher decides the rest (mode, once a
    // minute).
    _requestFresh() {
        if (this._active && this.online)
            this._refresher?.request(this._cacheFetchedAt);
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
        this._statusFile = this._statusFileFor();
        this._monitor = this._monitorFile(this._file);
        // The status line's folder is Froonty's own (statusline.py makes the
        // same one, 0700). Made here if missing: GLib's inotify backend
        // looks for a missing folder every 4 s, which would be polling.
        GLib.mkdir_with_parents(this._statusFile.get_parent().get_path(), 0o700);
        this._statusMonitor = this._monitorFile(this._statusFile);
    }

    _monitorFile(file) {
        try {
            const monitor = file.monitor_file(Gio.FileMonitorFlags.WATCH_MOVES, null);
            monitor.connect('changed', () => this.refresh());
            return monitor;
        } catch (e) {
            // No monitor (e.g. the folder is gone): reads on each visit still work.
            return null;
        }
    }

    // The status line's file: null when there is none (not set up, or no
    // reply since), or it cannot be used.
    async _readStatusLine() {
        const file = this._statusFile ?? this._statusFileFor();
        try {
            const [bytes] = await file.load_contents_async(this._cancellable);
            return statusLineFromFile(JSON.parse(new TextDecoder().decode(bytes)));
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
            return null;
        }
    }

    async _read() {
        const file = this._file ?? this._fileFor();
        let usage = null;
        let error = null;
        let status;
        try {
            status = await this._readStatusLine();
        } catch (e) {
            return;
        }
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
            } else if (this._cacheUsage) {
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
        this._cacheUsage = usage;
        this._cacheFetchedAt = usage?.fetchedAt ?? null;
        // The status line alone is enough for Session and Weekly.
        const merged = mergeStatusLine(usage, status);
        if (merged)
            error = null;
        if (this.loaded &&
            JSON.stringify([merged, error]) === JSON.stringify([this.usage, this.error]))
            return;
        this.loaded = true;
        this.usage = merged;
        this.error = error;
        this.emit('changed');
    }
}
