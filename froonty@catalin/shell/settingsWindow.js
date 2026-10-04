// SPDX-License-Identifier: GPL-3.0-or-later
// Opens Froonty's settings window, or raises it when it is already open.
//
// The window is run by GNOME Shell's separate preferences service
// (org.gnome.Shell.Extensions, a public D-Bus API; GNOME Shell 50 behavior):
//
//   - A second OpenExtensionPrefs call while a window is open fails with
//     "Already showing a prefs dialog" instead of raising it.
//   - The request carries no activation token, so Mutter's focus-stealing
//     prevention does not focus the new window.
//   - The window has no GTK application id; it is identified by its WM class
//     (the service's app id) and its title (the extension's name).
//
// The window has two views: the settings tabs, and the All notes page (a
// subpage, features/notes/allNotesPage.js). Which one shows is the
// settings-window-view key, set here before the window is opened or raised;
// the window follows it, and keeps it in step when the user navigates.
//
// The key outlives a window that never came (another extension's
// preferences were open: "Already showing a prefs dialog") or went without
// closing (the session ended, the process was killed). With no window of
// ours, it goes back to "settings": when the wait for a requested window
// gives up, and on enable (login, unlock). So the Extensions app opens on
// the settings next time.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const PREFS_SERVICE = 'org.gnome.Shell.Extensions';
const VIEW_KEY = 'settings-window-view';
const PREFS_OBJECT_PATH = '/org/gnome/Shell/Extensions';
// Stop waiting for the requested window after this long (it normally
// appears within a second; the service may be starting up).
const WINDOW_WAIT_SECONDS = 10;
// A preferences service whose last window just closed still owns its name
// for a moment, without its object; a new one starts once it has gone.
const LEAVING_RETRY_MS = 300;
const LEAVING_RETRIES = 5;

export class SettingsWindow {
    /**
     * @param {string} uuid extension uuid
     * @param {string} title window title, i.e. the extension's name
     * @param {Gio.Settings} settings Froonty's settings (shared with the window)
     */
    constructor(uuid, title, settings) {
        this._uuid = uuid;
        this._title = title;
        this._settings = settings;
        this._waitTimeoutId = 0;
        this._retryId = 0;
        // The windows watched for 'shown' while waiting: _stopWaiting() lets
        // go of exactly these, also one unmanaged before it was ever shown.
        this._watched = new Set();
        this._resetViewWithoutWindow();
    }

    /** @param {'settings'|'all-notes'} view the page to show */
    open(view = 'settings') {
        if (this._settings.get_string(VIEW_KEY) !== view)
            this._settings.set_string(VIEW_KEY, view);
        const window = this._findWindow();
        if (window) {
            Main.activateWindow(window);
            return;
        }

        this._activateWhenShown();
        this._request().catch(e => {
            this._stopWaiting();
            this._resetViewWithoutWindow();
            logError(e, 'Froonty: could not open the settings window');
        });
    }

    destroy() {
        this._stopWaiting();
        // A pending retry's promise is left unresolved: nothing more runs.
        if (this._retryId)
            GLib.source_remove(this._retryId);
        this._retryId = 0;
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
        for (let attempt = 0; ; attempt++) {
            try {
                // eslint-disable-next-line no-await-in-loop
                await Gio.DBus.session.call(PREFS_SERVICE, PREFS_OBJECT_PATH,
                    PREFS_SERVICE, 'OpenExtensionPrefs',
                    new GLib.Variant('(ssa{sv})', [this._uuid, '', {}]),
                    null, Gio.DBusCallFlags.NONE, -1, null);
                return;
            } catch (e) {
                // A second click before the first window has appeared; the
                // pending watch will still activate that window.
                if (e.message.includes('Already showing a prefs dialog'))
                    return;
                const leaving = e.matches?.(Gio.DBusError, Gio.DBusError.UNKNOWN_METHOD) ||
                    e.matches?.(Gio.DBusError, Gio.DBusError.UNKNOWN_OBJECT);
                if (!leaving || attempt >= LEAVING_RETRIES)
                    throw e;
            }
            // eslint-disable-next-line no-await-in-loop
            await new Promise(resolve => {
                this._retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LEAVING_RETRY_MS, () => {
                    this._retryId = 0;
                    resolve();
                    return GLib.SOURCE_REMOVE;
                });
            });
        }
    }

    _activateWhenShown() {
        if (this._waitTimeoutId)
            return;

        global.display.connectObject('window-created', (_display, window) => {
            // The title may not be final at creation time; check once shown.
            this._watched.add(window);
            window.connectObject('shown', () => {
                window.disconnectObject(this);
                this._watched.delete(window);
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
                // No window came (e.g. another extension's preferences
                // were open): nothing will set the page back.
                this._resetViewWithoutWindow();
                return GLib.SOURCE_REMOVE;
            });
    }

    // The All notes page is asked for only while a window of ours exists
    // or is on its way; otherwise the key goes back to the settings.
    _resetViewWithoutWindow() {
        if (this._settings.get_string(VIEW_KEY) !== 'settings' && !this._findWindow())
            this._settings.set_string(VIEW_KEY, 'settings');
    }

    _stopWaiting() {
        global.display.disconnectObject(this);
        for (const window of this._watched)
            window.disconnectObject(this);
        this._watched.clear();

        if (this._waitTimeoutId) {
            GLib.source_remove(this._waitTimeoutId);
            this._waitTimeoutId = 0;
        }
    }
}
