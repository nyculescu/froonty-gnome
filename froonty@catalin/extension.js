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
import {ClockService} from './services/clock.js';
import {PanelClock} from './shell/dateMenu.js';
import {SettingsWindow} from './shell/settingsWindow.js';
import {Island} from './ui/island.js';
import {PanelLauncher} from './ui/panelLauncher.js';

const TOGGLE_SHORTCUT_KEY = 'toggle-shortcut';

export default class FroontyExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._panelClock = new PanelClock();
        this._settingsWindow = new SettingsWindow(this.uuid, this.metadata.name, this._settings);
        this._clock = null;
        this._island = null;
        this._launcher = null;

        // "Start at login": the first enable() in a Shell process is the
        // login. Later ones (screen unlock, another extension being
        // toggled) keep what the user had, so disable() deliberately leaves
        // this field alone.
        this._started ??= this._settings.get_boolean('start-at-login');
        // Choices kept in memory for as long as the Shell runs, across
        // screen locks (Media's chosen player): plain data, never cleared
        // by disable().
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
            this);
        // Work a feature does while it is enabled, not only once its tab
        // has been opened (the Clipboard tab's recording, for one).
        this._backgrounds = new Set();
        for (const feature of FEATURES.filter(f => f.background)) {
            this._settings.connectObject(`changed::${feature.enabledKey}`,
                () => this._syncBackground(feature), this);
        }

        // One-time checks of features (e.g. a tab whose app is not
        // installed starts off); each remembers that it ran.
        for (const feature of FEATURES) {
            feature.setup?.(this._settings)?.catch?.(e =>
                console.warn(`Froonty: ${feature.id} setup failed: ${e.message}`));
        }

        // Parts of features that live as long as the extension and follow
        // whether the island is shown (the Break tab's reminders).
        this._parts = FEATURES.filter(f => f.createExtensionPart)
            .map(f => f.createExtensionPart(this._settings));
        this._syncIsland();
        for (const feature of FEATURES.filter(f => f.background))
            this._syncBackground(feature);
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
    }

    _syncBackground(feature) {
        const want = this._settings.get_boolean(feature.enabledKey);
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
        if (!this._started)
            this._start();
        else if (this._island)
            this._island.toggle();
        else
            this._settingsWindow.open();
    }

    _start() {
        this._started = true;
        this._syncIsland();
    }

    // While the island is not shown, a top bar icon keeps Froonty reachable.
    _syncIsland() {
        this._launcher?.destroy();
        this._launcher = null;
        if (this._started && this._settings.get_boolean('island-enabled')) {
            this._createIsland();
        } else {
            this._destroyIsland();
            this._launcher = this._started
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
