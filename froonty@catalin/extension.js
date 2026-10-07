// SPDX-License-Identifier: GPL-3.0-or-later
// Froonty: a Dynamic-Island-style entry point for GNOME Shell.
//
// Lifecycle: nothing is created before enable(), and disable() tears down
// everything enable() created. GNOME Shell calls disable() on every screen
// lock and enable() on unlock (session-modes defaults to ["user"]), so this
// path runs often, not just when the user toggles the extension.

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {FEATURES} from './features/registry.js';
// local:begin local-features (working-tree only; tools/pack-public strips it)
import {LOCAL_PARTS} from './features/localFeatures.js';
// local:end local-features
import {ClockService} from './services/clock.js';
import {PanelClock} from './shell/dateMenu.js';
import {SettingsWindow} from './shell/settingsWindow.js';
import {Island} from './ui/island.js';
import {PanelLauncher} from './ui/panelLauncher.js';

const TOGGLE_SHORTCUT_KEY = 'toggle-shortcut';
// Whether Froonty runs now: Settings' Stop/Start, the Show Apps entry's
// actions (dconf), the top bar icon and the shortcut set it.
const RUNNING_KEY = 'running';

export default class FroontyExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._panelClock = new PanelClock();
        this._settingsWindow = new SettingsWindow(this.uuid, this.metadata.name, this._settings);
        this._clock = null;
        this._island = null;
        this._launcher = null;

        // "Start at login": the first enable() in a Shell process is the
        // login, and sets whether Froonty runs. Later ones (screen unlock,
        // another extension being toggled) keep what the user had (Stop in
        // Settings, the top bar icon), so disable() leaves this field and
        // the key alone.
        if (!this._loginSeen) {
            this._loginSeen = true;
            this._settings.set_boolean(RUNNING_KEY, this._settings.get_boolean('start-at-login'));
        }
        // Plain data features keep in memory (ctx.memory). Kept across
        // screen locks only when a feature asks for that (keepsMemory);
        // otherwise disable() drops it.
        this._memory ??= {};

        // Always available: starts Froonty while it waits after login,
        // toggles the island, or opens the settings while the island is
        // hidden ("Show island" off).
        Main.wm.addKeybinding(TOGGLE_SHORTCUT_KEY, this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this._onShortcut());

        this._settings.connectObject(
            'changed::island-enabled', () => this._syncIsland(),
            'changed::hide-panel-clock', () => this._syncPanelClock(),
            `changed::${RUNNING_KEY}`, () => this._syncRunning(),
            this);
        // Work a feature does while it is enabled, not only once its tab
        // has been opened.
        this._backgrounds = new Set();
        for (const feature of FEATURES.filter(f => f.background)) {
            this._settings.connectObject(`changed::${feature.enabledKey}`,
                () => this._syncBackground(feature), this);
        }

        // One-time checks of features (e.g. a tab whose app is not
        // installed starts off); each remembers that it ran.
        for (const feature of FEATURES) {
            feature.setup?.(this._settings).catch(e =>
                console.warn(`Froonty: ${feature.id} setup failed: ${e.message}`));
        }

        // Parts of features that live while Froonty runs and follow
        // whether the island is shown (made in _syncRunning).
        this._parts = [];
        this._syncRunning();
    }

    get _running() {
        return this._settings.get_boolean(RUNNING_KEY);
    }

    // Running: the island, the features' parts (Super+V, the break
    // takeover) and their background work (clipboard recording, break
    // tracking, usage checks). Stopped (Settings → General → Stop, for a
    // computer that needs all its power): none of it, only the top bar
    // icon that starts it again and the shortcut.
    _syncRunning() {
        if (this._running && !this._parts.length) {
            this._parts = FEATURES.filter(f => f.createExtensionPart)
                .map(f => f.createExtensionPart(this._settings));
            // local:begin local-features
            // Parts that are not a tab's (Software brightness).
            this._parts.push(...LOCAL_PARTS.map(create => create(this._settings)));
            // local:end local-features
        } else if (!this._running) {
            for (const part of this._parts)
                part.destroy({locked: false});
            this._parts = [];
        }
        for (const feature of FEATURES.filter(f => f.background))
            this._syncBackground(feature);
        this._syncIsland();
    }

    disable() {
        const locked = this._isSessionLocked();
        for (const part of this._parts)
            part.destroy({locked});
        this._parts = null;
        this._settings.disconnectObject(this);
        for (const feature of FEATURES.filter(f => this._backgrounds.has(f.id)))
            feature.background.release();
        this._backgrounds = null;
        Main.wm.removeKeybinding(TOGGLE_SHORTCUT_KEY);
        this._destroyIsland();
        this._launcher?.destroy();
        this._launcher = null;

        this._settingsWindow.destroy();
        this._settingsWindow = null;
        this._panelClock = null;
        this._settings = null;
        if (!FEATURES.some(f => f.keepsMemory))
            this._memory = null;
    }

    _syncBackground(feature) {
        const want = this._running && this._settings.get_boolean(feature.enabledKey);
        if (want === this._backgrounds.has(feature.id))
            return;
        if (want) {
            this._backgrounds.add(feature.id);
            feature.background.acquire(this._settings);
        } else {
            this._backgrounds.delete(feature.id);
            feature.background.release();
        }
    }

    // Extensions are disabled on the session mode's 'updated' after
    // 'unlock-dialog' is pushed, which has isLocked (ui/sessionMode.js).
    // A method, so the headless test can stand in for a lock.
    _isSessionLocked() {
        return Main.sessionMode.isLocked;
    }

    _onShortcut() {
        if (!this._running)
            this._start();
        else if (this._island)
            this._island.toggle();
        else
            this._settingsWindow.open();
    }

    // Through the key, as Settings and the Show Apps entry do.
    _start() {
        this._settings.set_boolean(RUNNING_KEY, true);
    }

    // While the island is not shown, a top bar icon keeps Froonty reachable.
    _syncIsland() {
        this._launcher?.destroy();
        this._launcher = null;
        if (this._running && this._settings.get_boolean('island-enabled')) {
            this._createIsland();
        } else {
            this._destroyIsland();
            this._launcher = this._running
                ? new PanelLauncher(_('Froonty settings'), () => this._settingsWindow.open())
                : new PanelLauncher(_('Start Froonty'), () => this._start());
        }
        for (const part of this._parts)
            part.sync?.({pillShown: this._island !== null});
    }

    _createIsland() {
        if (this._island)
            return;

        this._clock = new ClockService(this._settings);
        this._clock.start();
        this._island = new Island(this._settings, this._clock, this._panelClock, {
            openSettings: view => this._settingsWindow.open(view),
            memory: this._memory,
            version: this.metadata['version-name'] ?? null,
        });

        this._syncPanelClock();
    }

    _destroyIsland() {
        if (!this._island)
            return;

        this._island.destroy();
        this._island = null;

        this._clock.stop();
        this._clock = null;

        this._panelClock.restore();
    }

    _syncPanelClock() {
        if (this._island && this._settings.get_boolean('hide-panel-clock'))
            this._panelClock.conceal();
        else
            this._panelClock.restore();
    }
}
