// SPDX-License-Identifier: GPL-3.0-or-later
// Reads Horizon summary files and emits the latest items.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Emitter} from '../../core/emitter.js';
import {probe, startOwn} from '../writing/engines/ollama.js';
import {aiFor, defaultHorizonRepoPath, horizonBin, horizonVenvDirs, withAi} from './horizonAi.js';
import {lookupKey} from './horizonSecret.js';
import {parseHorizonMarkdown} from './parser.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_async', 'replace_contents_finish');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

export class HorizonService extends Emitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._monitor = null;
        this._monitorSignalId = 0;
        this._cancellable = new Gio.Cancellable();
        this._items = [];
        this._isRefreshing = false;
    }

    start() {
        this.enable();
    }

    stop() {
        this.disable();
    }

    get items() {
        return this._items;
    }

    /** Whether Horizon is running for a new briefing. */
    get refreshing() {
        return this._isRefreshing;
    }

    enable() {
        const summaryDir = this._getSummariesDir();
        const dirFile = Gio.File.new_for_path(summaryDir);
        if (!dirFile.query_exists(null))
            GLib.mkdir_with_parents(summaryDir, 0o755);

        this._monitor = dirFile.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, this._cancellable);
        this._monitorSignalId = this._monitor.connect('changed', (_monitor, file, _other, eventType) => {
            if ((eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT ||
                eventType === Gio.FileMonitorEvent.CREATED) &&
                file.get_basename().endsWith('.md')) {
                this._loadLatestSummary().catch(console.warn);
            }
        });

        this._loadLatestSummary().catch(console.warn);
    }

    disable() {
        this._cancellable.cancel();
        if (this._monitor && this._monitorSignalId) {
            this._monitor.disconnect(this._monitorSignalId);
            this._monitor.cancel();
        }
        this._monitor = null;
        this._monitorSignalId = 0;
        this._items = [];
    }

    _getRepoPath() {
        const repoPath = this._settings.get_string('horizon-repo-path');
        return repoPath || defaultHorizonRepoPath();
    }

    _getSummariesDir() {
        const customDir = this._settings.get_string('horizon-data-dir');
        const base = customDir || GLib.build_filenamev([
            GLib.get_user_data_dir(),
            'froonty',
            'horizon',
        ]);
        return GLib.build_filenamev([base, 'summaries']);
    }

    async _loadLatestSummary() {
        const dirFile = Gio.File.new_for_path(this._getSummariesDir());
        if (!dirFile.query_exists(null))
            return;

        let enumerator;
        try {
            enumerator = await dirFile.enumerate_children_async(
                'standard::name,time::modified',
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                this._cancellable,
            );
        } catch {
            return;
        }

        let latestFile = null;
        let latestTime = 0;

        while (true) {
            let infos;
            try {
                infos = await new Promise((resolve, reject) => {
                    enumerator.next_files_async(50, GLib.PRIORITY_DEFAULT, this._cancellable, (_obj, res) => {
                        try {
                            resolve(enumerator.next_files_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    });
                });
            } catch {
                break;
            }

            if (!infos.length)
                break;

            for (const info of infos) {
                const name = info.get_name();
                if (!name.endsWith('.md'))
                    continue;
                const time = info.get_modification_date_time()?.to_unix() ?? 0;
                if (time >= latestTime) {
                    latestTime = time;
                    latestFile = dirFile.get_child(name);
                }
            }
        }

        if (!latestFile)
            return;

        const [contents] = await latestFile.load_contents_async(this._cancellable);
        const rawMarkdown = new TextDecoder('utf-8').decode(contents);
        this._items = parseHorizonMarkdown(rawMarkdown);
        this.emit('items-changed', this._items);
    }

    triggerRefresh() {
        if (this._isRefreshing)
            return;
        this._isRefreshing = true;
        this.emit('refresh-state', true);
        this._refresh().catch(e => {
            if (!this._cancellable.is_cancelled()) {
                console.warn(`Froonty: Horizon refresh failed: ${e.message}`);
                this.emit('refresh-error', e.message);
            }
        }).finally(() => {
            this._isRefreshing = false;
            this.emit('refresh-state', false);
        });
    }

    // Writes the AI chosen in Settings into config.json, makes sure it can
    // be reached (Writing's Ollama started, the API key from the keyring),
    // then runs Horizon. A problem is thrown as the line the tab shows.
    async _refresh() {
        const repoPath = this._getRepoPath();
        if (!repoPath)
            throw new Error(_('Horizon repository was not found.'));
        const executable = horizonBin('horizon');
        if (!Gio.File.new_for_path(executable).query_exists(null))
            throw new Error(_('Horizon is not installed: run make horizon-setup in the project folder (it goes to %s).').format(horizonVenvDirs()[1]));
        const dataDir = GLib.path_get_dirname(this._getSummariesDir());
        const configFile = Gio.File.new_for_path(GLib.build_filenamev([dataDir, 'config.json']));

        const s = this._settings;
        const source = s.get_string('horizon-ai');
        const {ai, keyEnv, error} = aiFor({
            source,
            writingModel: s.get_string('writing-ollama-model'),
            provider: s.get_string('horizon-ai-provider'),
            model: s.get_string('horizon-ai-model'),
            chatgptModel: s.get_string('horizon-chatgpt-model'),
            chatgptAccount: s.get_string('horizon-chatgpt-account'),
        });
        if (error)
            throw new Error(ERRORS[error]());

        const env = {};
        if (ai) {
            await this._writeConfig(configFile, ai);
            if (keyEnv) {
                let key = null;
                try {
                    key = await lookupKey(ai.provider, this._cancellable);
                } catch (e) {
                    throw new Error(_('The keyring could not be read: %s').format(e.message));
                }
                if (!key)
                    throw new Error(_('No API key saved. Add it in Settings → Horizon.'));
                env[keyEnv] = key;
            }
            if (source === 'local')
                await this._startLocalModel(ai.model);
        } else if (!configFile.query_exists(null)) {
            throw new Error(_('Horizon has no config.json yet. Run make horizon-wizard, or choose an AI in Settings → Horizon.'));
        }

        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        // Horizon resolves its profiles (and .env, and the copy it keeps for
        // GitHub Pages in docs/_posts, git-ignored) from the folder it runs in.
        launcher.set_cwd(repoPath);
        for (const [name, value] of Object.entries(env))
            launcher.setenv(name, value, true);
        const proc = launcher.spawnv([executable, '--data-dir', dataDir]);
        const [, stderr] = await proc.communicate_utf8_async(null, this._cancellable);
        if (!proc.get_successful()) {
            const last = stderr.trim().split('\n').filter(Boolean).pop();
            throw new Error(last || _('Horizon did not complete successfully.'));
        }
        await this._loadLatestSummary();
    }

    async _writeConfig(file, ai) {
        let existing = null;
        if (file.query_exists(null)) {
            const [contents] = await file.load_contents_async(this._cancellable);
            existing = new TextDecoder().decode(contents);
        }
        let config;
        try {
            config = withAi(existing, ai);
        } catch (e) {
            throw new Error(_('Horizon’s config.json could not be read: %s').format(e.message));
        }
        GLib.mkdir_with_parents(file.get_parent().get_path(), 0o700);
        const bytes = new TextEncoder().encode(`${JSON.stringify(config, null, 2)}\n`);
        // Written in place of the old one only once complete.
        await file.replace_contents_async(bytes, null, false, Gio.FileCreateFlags.PRIVATE,
            this._cancellable);
    }

    // Writing's Ollama: started if it is Froonty's own and stopped, and
    // the model must be downloaded.
    async _startLocalModel(model) {
        const cache = new Map();
        let state = await probe({cache, cancellable: this._cancellable});
        if (!state.running) {
            try {
                await startOwn({cache, cancellable: this._cancellable});
            } catch (e) {
                throw new Error(_('This computer’s model is not running: %s').format(e.message));
            }
            state = await probe({cache, cancellable: this._cancellable});
        }
        if (!state.models.some(m => m.name === model))
            throw new Error(_('The model %s is not downloaded. Download it in Settings → Writing.').format(model));
    }
}

// What a missing choice means, as the tab says it.
const ERRORS = {
    'no-local-model': () => _('No model on this computer yet. Choose or download one in Settings → Writing.'),
    'no-chatgpt-model': () => _('Sign in with ChatGPT and choose a model in Settings → Horizon.'),
    'no-provider': () => _('Choose an API provider in Settings → Horizon.'),
};
