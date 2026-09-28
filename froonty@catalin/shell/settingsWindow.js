// SPDX-License-Identifier: GPL-3.0-or-later
// Opens Froonty's settings window, or raises it when it is already open.
//
// The window is run by GNOME Shell's separate preferences service
// (org.gnome.Shell.Extensions, a public D-Bus API; GNOME Shell 46 behavior):
//
//   - A second OpenExtensionPrefs call while a window is open fails with
//     "Already showing a prefs dialog" instead of raising it.
//   - The request carries no activation token, so Mutter's focus-stealing
//     prevention does not focus the new window.
//   - The window has no GTK application id; it is identified by its WM class
//     (the service's app id) and its title (the extension's name).

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const PREFS_SERVICE = 'org.gnome.Shell.Extensions';
const PREFS_OBJECT_PATH = '/org/gnome/Shell/Extensions';
// Stop waiting for the requested window after this long (it normally
// appears within a second; the service may be starting up).
const WINDOW_WAIT_SECONDS = 10;

export class SettingsWindow {
    /**
     * @param {string} uuid extension uuid
     * @param {string} title window title, i.e. the extension's name
     */
    constructor(uuid, title) {
        this._uuid = uuid;
        this._title = title;
        this._waitTimeoutId = 0;
    }

    open() {
        const window = this._findWindow();
        if (window) {
            Main.activateWindow(window);
            return;
        }

        this._activateWhenShown();
        this._request().catch(e => {
            this._stopWaiting();
            logError(e, 'Froonty: could not open the settings window');
        });
    }

    destroy() {
        this._stopWaiting();
    }

    _findWindow() {
        return global.display.list_all_windows().find(w => this._isOurs(w));
    }

    _isOurs(window) {
        return window.get_wm_class() === PREFS_SERVICE &&
            window.get_title() === this._title;
    }

    // Extension.openPreferences() makes the same call but drops the returned
    // promise, so a failure would surface as an unhandled rejection.
    async _request() {
        try {
            await Gio.DBus.session.call(PREFS_SERVICE, PREFS_OBJECT_PATH,
                PREFS_SERVICE, 'OpenExtensionPrefs',
                new GLib.Variant('(ssa{sv})', [this._uuid, '', {}]),
                null, Gio.DBusCallFlags.NONE, -1, null);
        } catch (e) {
            // A second click before the first window has appeared; the
            // pending watch will still activate that window.
            if (!e.message.includes('Already showing a prefs dialog'))
                throw e;
        }
    }

    _activateWhenShown() {
        if (this._waitTimeoutId)
            return;

        global.display.connectObject('window-created', (_display, window) => {
            // The title may not be final at creation time; check once shown.
            window.connectObject('shown', () => {
                window.disconnectObject(this);
                if (this._isOurs(window)) {
                    this._stopWaiting();
                    Main.activateWindow(window);
                }
            }, this);
        }, this);

        this._waitTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            WINDOW_WAIT_SECONDS, () => {
                this._waitTimeoutId = 0;
                this._stopWaiting();
                return GLib.SOURCE_REMOVE;
            });
    }

    _stopWaiting() {
        global.display.disconnectObject(this);
        for (const window of global.display.list_all_windows())
            window.disconnectObject(this);

        if (this._waitTimeoutId) {
            GLib.source_remove(this._waitTimeoutId);
            this._waitTimeoutId = 0;
        }
    }
}
