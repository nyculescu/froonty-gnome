// SPDX-License-Identifier: GPL-3.0-or-later
// The Claude attention bar's model (docs/features/claude-attention.md §6):
// which Claude sessions wait for the user, from
//
//   - the state files Froonty's Claude Code hook script writes
//     (attentionHook.js), one per session, in a folder watched with one
//     Gio.FileMonitor; and
//   - GNOME's own notifications from the Claude app and, if asked for, web
//     browsers mentioning claude.ai, through a notification store.
//
// Event-driven: no timer, no polling, no process. Shell-free (Gio, GLib,
// core/emitter.js); the Shell side comes in as `desktop`
// (shell/claudeAttention.js) and `notifications`, so plain gjs tests it
// with fakes.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Emitter} from '../../core/emitter.js';
import {
    APP_ENTRYPOINTS, CLAUDE_APP_ID, FILE_RE, FINISHED_KINDS, MAX_ENTRIES, MAX_FILE,
    appNotificationKind, clearedByAppFocus, compareEntries, mentionsClaudeAi, parseEntry,
    parseProcStat, quietWhileLooking, stateDir,
} from './attention.js';

for (const method of ['read_async', 'load_contents_async', 'delete_async', 'enumerate_children_async'])
    Gio._promisify(Gio.File.prototype, method);
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.InputStream.prototype, 'close_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');

const KEYS = ['claude-attention-finished', 'claude-attention-app', 'claude-attention-browsers'];
const TEMP_RE = /^\.claude-attention-.*\.tmp$/;

// One place for this feature's few warnings (a folder it cannot use, an
// I/O error); nothing is logged in normal use.
const warn = message => console.warn(`Froonty: Claude attention: ${message}`);

const isNotFound = e => e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND);
const isCancelled = e => e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);

const isRealDir = file => file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) ===
    Gio.FileType.DIRECTORY;

// A notification's time (GLib.DateTime, or ms in tests) in ms.
function timeOf(time) {
    if (typeof time === 'number')
        return time;
    const usec = time?.to_unix_usec?.();
    return typeof usec === 'number' ? usec / 1000 : 0;
}

async function namesIn(dir, cancellable = null) {
    const names = [];
    const enumerator = await dir.enumerate_children_async('standard::name',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, cancellable);
    try {
        for (;;) {
            const infos = await enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT, cancellable);
            if (infos.length === 0)
                break;
            names.push(...infos.map(info => info.get_name()));
        }
    } finally {
        await enumerator.close_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
    }
    return names;
}

/**
 * Deletes the state folder: its state files, any temporary file the hook
 * script left in the parent folder, then the folder. Best effort.
 *
 * @param {Gio.File} dir
 */
export async function removeStateDir(dir = stateDir()) {
    try {
        for (const name of await namesIn(dir)) {
            if (name.endsWith('.json'))
                await dir.get_child(name).delete_async(GLib.PRIORITY_DEFAULT, null);
        }
        const parent = dir.get_parent();
        for (const name of await namesIn(parent).catch(() => [])) {
            if (TEMP_RE.test(name))
                await parent.get_child(name).delete_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
        }
        await dir.delete_async(GLib.PRIORITY_DEFAULT, null);
    } catch (e) {
        if (!isNotFound(e))
            warn(`could not remove ${dir.get_path()}: ${e.message}`);
    }
}

/**
 * Emits 'changed' when `entries` changes.
 *
 * An entry: {id, origin: 'hook'|'app'|'browser', kind, at, project,
 * appName, entrypoint, title}, plain values only.
 */
export class AttentionService extends Emitter {
    /**
     * @param {object} params
     * @param {Gio.Settings} params.settings
     * @param {object} params.desktop the Shell adapter (shell/claudeAttention.js)
     * @param {?object} params.notifications {createStore({filter}), plainText}
     * @param {Gio.File} params.dir the state folder
     */
    constructor({settings, desktop, notifications = null, dir = stateDir()}) {
        super();
        this._settings = settings;
        this._desktop = desktop;
        this._notifications = notifications;
        this._dir = dir;
        this._started = false;
        this._cancellable = null;
        this._monitor = null;
        this._settingsIds = [];
        this._focusId = 0;
        this._watchingFocus = false;
        /** @type {Map<string, {record: object, ignored: boolean, appId: ?string, appName: ?string}>} */
        this._hooks = new Map();
        /** @type {Map<string, {again: boolean}>} reads in flight, by session */
        this._reads = new Map();
        this._store = null;
        this._storeIds = [];
        this._storeKey = null;
        /** @type {Map<string, {notification: object, entry: object}>} */
        this._gnome = new Map();
        this._notificationIds = new WeakMap();
        this._nextId = 1;
        this._entries = Object.freeze([]);
        this._signature = '[]';
    }

    /** Displayable entries, most urgent first (compareEntries). */
    get entries() {
        return this._entries;
    }

    get started() {
        return this._started;
    }

    start() {
        if (this._started)
            return;
        this._started = true;
        this._cancellable = new Gio.Cancellable();
        this._recreated = false;
        this._focusId = this._desktop.connect('focus-changed', () => this._onFocusChanged());
        this._settingsIds = KEYS.map(key =>
            this._settings.connect(`changed::${key}`, () => this._onSettingChanged(key)));
        this._watchFolder();
        this._syncStore();
    }

    /** Stops watching. The state files stay (pending attention survives a screen lock). */
    stop() {
        if (!this._started)
            return;
        this._started = false;
        this._cancellable.cancel();
        this._cancellable = null;
        this._unwatchFolder();
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this._settingsIds = [];
        this._dropStore();
        if (this._watchingFocus)
            this._desktop.watchFocus(false);
        this._watchingFocus = false;
        this._desktop.disconnect(this._focusId);
        this._focusId = 0;
        this._hooks.clear();
        this._reads.clear();
        this._gnome.clear();
        this._entries = Object.freeze([]);
        this._signature = '[]';
    }

    /** Turning the bar off: the folder and its files go. */
    removeState() {
        return removeStateDir(this._dir);
    }

    /** Raises where the session waits and drops the entry. */
    activate(id) {
        const hook = this._hookFor(id);
        if (hook) {
            this._desktop.raise(hook.record);
            this._deleteFile(hook.record.session);
            return true;
        }
        const gnome = this._gnome.get(id);
        if (!gnome)
            return false;
        if (gnome.entry.appId)
            this._desktop.raiseApp(gnome.entry.appId);
        this._store?.activate(gnome.notification);
        return true;
    }

    /** ×: drops the entry (and GNOME's notification behind it). */
    dismiss(id) {
        const hook = this._hookFor(id);
        if (hook) {
            this._deleteFile(hook.record.session);
            return true;
        }
        const gnome = this._gnome.get(id);
        if (!gnome)
            return false;
        this._store?.dismiss(gnome.notification);
        return true;
    }

    /**
     * Checks that every recorded Claude Code is still running; a crashed one
     * leaves its file behind. One small /proc read each.
     *
     * @returns {Promise}
     */
    revalidate() {
        return Promise.all([...this._hooks].map(async ([session, hook]) => {
            const alive = await this._alive(hook.record);
            if (!alive && this._hooks.get(session)?.record === hook.record)
                this._deleteFile(session);
        }));
    }

    _hookFor(id) {
        const session = id?.startsWith?.('hook:') ? id.slice(5) : null;
        const hook = session ? this._hooks.get(session) : null;
        return hook && !hook.ignored ? hook : null;
    }

    // ------------------------------------------------------------ the folder

    _watchFolder() {
        // Synchronous, but on tmpfs, and once per start.
        GLib.mkdir_with_parents(this._dir.get_path(), 0o700);
        if (!isRealDir(this._dir)) {
            warn(`${this._dir.get_path()} is not a folder; Claude Code's hooks are not followed`);
            return;
        }
        try {
            this._monitor = this._dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
        } catch (e) {
            warn(`cannot watch ${this._dir.get_path()}: ${e.message}`);
            return;
        }
        this._monitor.connect('changed', (_monitor, file, other, event) =>
            this._onFolderEvent(file, other, event));
        this._scan();
    }

    _unwatchFolder() {
        this._monitor?.cancel();
        this._monitor = null;
    }

    async _scan() {
        const cancellable = this._cancellable;
        let names;
        try {
            names = await namesIn(this._dir, cancellable);
        } catch (e) {
            if (!isCancelled(e))
                warn(`cannot list ${this._dir.get_path()}: ${e.message}`);
            return;
        }
        if (cancellable.is_cancelled())
            return;
        const sessions = new Set(names.map(name => FILE_RE.exec(name)?.[1]).filter(Boolean));
        for (const session of [...this._hooks.keys()]) {
            if (!sessions.has(session))
                this._forget(session);
        }
        for (const session of sessions)
            this._read(session);
    }

    _onFolderEvent(file, other, event) {
        const E = Gio.FileMonitorEvent;
        if (file.equal(this._dir)) {
            if (event === E.DELETED)
                this._onFolderDeleted();
            return;
        }
        const session = name => FILE_RE.exec(name ?? '')?.[1] ?? null;
        switch (event) {
        case E.CREATED:
        case E.CHANGED:
        case E.CHANGES_DONE_HINT:
        case E.MOVED_IN:
            this._read(session(file.get_basename()));
            break;
        case E.RENAMED:
            this._gone(session(file.get_basename()));
            this._read(session(other?.get_basename()));
            break;
        case E.DELETED:
        case E.MOVED_OUT:
            this._gone(session(file.get_basename()));
            break;
        }
    }

    // Someone removed the folder: GLib would look for it again every 4 s,
    // so the monitor goes; the folder and its monitor are made again once.
    _onFolderDeleted() {
        this._unwatchFolder();
        for (const session of [...this._hooks.keys()])
            this._forget(session);
        if (this._recreated)
            return;
        this._recreated = true;
        this._watchFolder();
    }

    // The file went (a clear hook, a click…): the entry goes now; a read in
    // flight is not applied and reads again (and finds nothing).
    _gone(session) {
        if (!session)
            return;
        const reading = this._reads.get(session);
        if (reading)
            reading.again = true;
        this._forget(session);
    }

    // Reads that arrive while one runs fold into one more read after it.
    _read(session) {
        if (!session || !this._started)
            return;
        const reading = this._reads.get(session);
        if (reading) {
            reading.again = true;
            return;
        }
        const state = {again: false};
        this._reads.set(session, state);
        const cancellable = this._cancellable;
        (async () => {
            do {
                state.again = false;
                const result = await this._load(session, cancellable);
                if (cancellable.is_cancelled())
                    return;
                if (!state.again)
                    this._apply(session, result);
            } while (state.again);
        })().catch(e => {
            if (!isCancelled(e))
                warn(`reading a state file: ${e.message}`);
        }).finally(() => {
            if (this._reads.get(session) === state)
                this._reads.delete(session);
        });
    }

    // At most MAX_FILE + 1 bytes are read: a larger file is ignored.
    async _load(session, cancellable) {
        const file = this._dir.get_child(`${session}.json`);
        let bytes;
        try {
            const stream = await file.read_async(GLib.PRIORITY_DEFAULT, cancellable);
            try {
                bytes = await stream.read_bytes_async(MAX_FILE + 1, GLib.PRIORITY_DEFAULT, cancellable);
            } finally {
                await stream.close_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
            }
        } catch (e) {
            if (isCancelled(e))
                throw e;
            return {status: isNotFound(e) ? 'missing' : 'invalid'};
        }
        const record = bytes.get_size() > MAX_FILE ? null : parseEntry(bytes.toArray(), session);
        if (!record)
            return {status: 'invalid'};
        return {status: 'ok', record, alive: await this._alive(record)};
    }

    // Claude Code (pids[0]) is still the process that wrote the file: a
    // reused process id has another start time.
    async _alive(record) {
        const [pid, start] = record.pids[0];
        try {
            const [bytes] = await Gio.File.new_for_path(`/proc/${pid}/stat`)
                .load_contents_async(null);
            return parseProcStat(new TextDecoder().decode(bytes))?.start === start;
        } catch {
            return false;
        }
    }

    _apply(session, result) {
        if (result.status !== 'ok') {
            // Missing, or not a state file of Froonty's: left alone.
            this._forget(session);
            return;
        }
        const {record, alive} = result;
        if (!alive || (FINISHED_KINDS.includes(record.kind) &&
            !this._settings.get_boolean('claude-attention-finished'))) {
            this._deleteFile(session);
            return;
        }
        // The Claude app's own notification stands for its sessions.
        if (APP_ENTRYPOINTS.includes(record.entrypoint) &&
            this._settings.get_boolean('claude-attention-app')) {
            this._hooks.set(session, {record, ignored: true, appId: null, appName: null});
            this._update();
            return;
        }
        const target = this._desktop.resolve(record);
        // Already looking at it: nothing to tell. Only the session's own
        // window counts, known for sure; in a terminal, only for a reply's
        // end (attention.js quietWhileLooking()).
        if (quietWhileLooking(record) && this._desktop.isLookingAt(record, {exactOnly: true})) {
            this._deleteFile(session);
            return;
        }
        this._hooks.set(session, {
            record,
            ignored: false,
            appId: typeof target?.appId === 'string' ? target.appId : null,
            appName: typeof target?.appName === 'string' ? target.appName : null,
        });
        this._update();
    }

    _forget(session) {
        if (this._hooks.delete(session))
            this._update();
    }

    // The entry goes at once; the folder monitor's DELETED follows.
    _deleteFile(session) {
        this._forget(session);
        this._dir.get_child(`${session}.json`).delete_async(GLib.PRIORITY_DEFAULT, null)
            .catch(e => {
                if (!isNotFound(e))
                    warn(`could not delete a state file: ${e.message}`);
            });
    }

    // ------------------------------------------------------------ focus

    // The focus moved to another window. The session's own window, known
    // for sure: the user is looking at it. Its window not known for sure,
    // a permission or a question also clears on any window of its app:
    // the user went there, most likely to answer (attention.js
    // clearedByAppFocus()). Then a crashed Claude Code is looked for.
    _onFocusChanged() {
        for (const [session, hook] of [...this._hooks]) {
            if (hook.ignored)
                continue;
            const exactOnly = !clearedByAppFocus(hook.record.kind);
            if (this._desktop.isLookingAt(hook.record, {exactOnly}))
                this._deleteFile(session);
        }
        this.revalidate();
    }

    _syncFocusWatch() {
        const want = this._started &&
            [...this._hooks.values()].some(hook => !hook.ignored && hook.appId);
        if (want === this._watchingFocus)
            return;
        this._watchingFocus = want;
        this._desktop.watchFocus(want);
    }

    // ------------------------------------------------------------ settings

    _onSettingChanged(key) {
        if (key === 'claude-attention-finished' &&
            !this._settings.get_boolean('claude-attention-finished')) {
            for (const [session, hook] of [...this._hooks]) {
                if (FINISHED_KINDS.includes(hook.record.kind))
                    this._deleteFile(session);
            }
        }
        if (key === 'claude-attention-app')
            this._rescan();
        this._syncStore();
        this._rebuildGnome();
    }

    // Every file read again (the app switch decides what is shown).
    _rescan() {
        if (this._monitor)
            this._scan();
    }

    // ------------------------------------------------------------ GNOME's notifications

    _syncStore() {
        const app = this._settings.get_boolean('claude-attention-app');
        const browsers = this._settings.get_boolean('claude-attention-browsers');
        const key = `${app}/${browsers}`;
        if (key === this._storeKey)
            return;
        this._dropStore();
        this._storeKey = key;
        if (this._notifications && (app || browsers)) {
            this._store = this._notifications.createStore({
                filter: this._desktop.notificationFilter({app, browsers}),
            });
            this._storeIds = ['changed', 'notification-changed'].map(signal =>
                this._store.connect(signal, () => this._rebuildGnome()));
            this._store.watch();
        }
        this._rebuildGnome();
    }

    _dropStore() {
        if (this._store) {
            this._storeIds.forEach(id => this._store.disconnect(id));
            this._store.unwatch();
        }
        this._store = null;
        this._storeIds = [];
        this._storeKey = null;
    }

    _plain(text, useMarkup) {
        return this._notifications?.plainText?.(text, useMarkup) ?? text ?? '';
    }

    _idFor(notification) {
        let id = this._notificationIds.get(notification);
        if (!id) {
            id = `gnome:${this._nextId++}`;
            this._notificationIds.set(notification, id);
        }
        return id;
    }

    _rebuildGnome() {
        this._gnome.clear();
        const app = this._settings.get_boolean('claude-attention-app');
        const browsers = this._settings.get_boolean('claude-attention-browsers');
        const finished = this._settings.get_boolean('claude-attention-finished');
        for (const notification of this._store?.notifications ?? []) {
            const d = this._store.describe(notification);
            if (!d)
                continue;
            const title = this._plain(d.title, false);
            const body = this._plain(d.body, d.useMarkup);
            const base = {
                id: this._idFor(notification), at: timeOf(d.time), project: '',
                appName: d.appName ?? null, appId: d.appId ?? null, entrypoint: '',
            };
            let entry;
            if (d.appId === CLAUDE_APP_ID) {
                const kind = appNotificationKind(body);
                if (!app || (kind === 'finished' && !finished))
                    continue;
                entry = {...base, origin: 'app', kind,
                    title: title && title !== 'Claude Code' && title !== 'Claude' ? title : null};
            } else {
                if (!browsers || !mentionsClaudeAi(title, body))
                    continue;
                entry = {...base, origin: 'browser', kind: 'attention', title: null};
            }
            this._gnome.set(entry.id, {notification, entry: Object.freeze(entry)});
        }
        this._update();
    }

    // ------------------------------------------------------------ the list

    _update() {
        const hooks = [...this._hooks]
            .filter(([, hook]) => !hook.ignored)
            .map(([session, hook]) => Object.freeze({
                id: `hook:${session}`, origin: 'hook', kind: hook.record.kind, at: hook.record.at,
                project: hook.record.project, appName: hook.appName, appId: hook.appId,
                entrypoint: hook.record.entrypoint, title: null,
            }));
        const all = [...hooks, ...[...this._gnome.values()].map(g => g.entry)]
            .sort((a, b) => b.at - a.at)
            .slice(0, MAX_ENTRIES)
            .sort(compareEntries);
        this._syncFocusWatch();
        const signature = JSON.stringify(all);
        if (signature === this._signature)
            return;
        this._signature = signature;
        this._entries = Object.freeze(all);
        this.emit('changed');
    }
}
