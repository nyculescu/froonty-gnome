// SPDX-License-Identifier: GPL-3.0-or-later
// Froonty: a Dynamic-Island-style entry point for GNOME Shell 46.
//
// Lifecycle: nothing is created before enable(), and disable() tears down
// everything enable() created. GNOME Shell 46 calls disable() on every screen
// lock and enable() on unlock (session-modes defaults to ["user"]), so this
// path runs often, not just when the user toggles the extension.

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

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
        this._settingsWindow = new SettingsWindow(this.uuid, this.metadata.name);
        this._clock = null;
        this._island = null;
        this._launcher = null;

        // Always available: toggles the island, or opens the settings while
        // the island is hidden ("Show island" off).
        Main.wm.addKeybinding(TOGGLE_SHORTCUT_KEY, this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => (this._island ? this._island.toggle() : this._settingsWindow.open()));

        this._settings.connectObject(
            'changed::island-enabled', () => this._syncIsland(),
            'changed::hide-panel-clock', () => this._syncPanelClock(),
            this);

        this._syncIsland();
    }

    disable() {
        this._settings.disconnectObject(this);
        Main.wm.removeKeybinding(TOGGLE_SHORTCUT_KEY);
        this._destroyIsland();
        this._launcher?.destroy();
        this._launcher = null;

        this._settingsWindow.destroy();
        this._settingsWindow = null;
        this._panelClock = null;
        this._settings = null;
    }

    // While the island is hidden, a top bar icon keeps Froonty reachable.
    _syncIsland() {
        if (this._settings.get_boolean('island-enabled')) {
            this._launcher?.destroy();
            this._launcher = null;
            this._createIsland();
        } else {
            this._destroyIsland();
            this._launcher ??= new PanelLauncher(() => this._settingsWindow.open());
        }
    }

    _createIsland() {
        if (this._island)
            return;

        this._clock = new ClockService(this._settings);
        this._clock.start();
        this._island = new Island(this._settings, this._clock, this._panelClock, {
            openSettings: () => this._settingsWindow.open(),
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
