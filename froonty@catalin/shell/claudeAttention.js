// SPDX-License-Identifier: GPL-3.0-or-later
// The Shell side of the Claude attention bar (docs/features/claude-
// attention.md §6): which app and window a Claude session runs in, whether
// the user is looking at it, raising it, and when the bar must stay out of
// the way. The model (features/claude/attentionService.js) is Shell-free
// and reaches all of this through ClaudeDesktop.
//
// PRIVATE / INTERNAL API (DESIGN.md §6.3), verified against GNOME Shell
// 50.1:
//
//   Main.messageTray.visible     true while a banner is on screen
//                                (MessageTray._updateState()); notify::visible
//   source.app                   the Shell.App of a notification source
//                                (FdoNotificationDaemonSource only; the
//                                window-attention source has none)
//
// Exported Shell APIs: Shell.WindowTracker get_app_from_pid /
// get_window_app, Shell.AppSystem lookup_app, Shell.App get_windows /
// get_name / get_id / get_app_info, global.display focus_window
// (notify::focus-window), Main.activateWindow, Main.overview visible
// ('showing', 'hidden'), Main.sessionMode isLocked (set from the mode
// before 'updated', which disables extensions at a lock: ui/sessionMode.js
// _sync(), ui/extensionSystem.js _sessionUpdated()).
//
// Nothing is created at module load.

import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {CLAUDE_APP_ID, pickWindow} from '../features/claude/attention.js';

/**
 * Whether the screen is locked. GNOME Shell disables extensions at a lock
 * with `isLocked` already set, so Island.destroy() can tell a lock (what
 * waits is kept) from the extension or the island being turned off.
 */
export function screenLocked() {
    return Main.sessionMode.isLocked === true;
}

/**
 * Emits 'focus-changed' (only while watchFocus(true)) and 'busy-changed'.
 */
export class ClaudeDesktop extends EventEmitter {
    constructor() {
        super();
        this._focusWatched = false;
        this._lastFocus = null;
        // Banners and the overview take the bar's place, for as long as
        // the adapter lives.
        Main.messageTray.connectObject('notify::visible', () => this.emit('busy-changed'), this);
        Main.overview.connectObject(
            'showing', () => this.emit('busy-changed'),
            'hidden', () => this.emit('busy-changed'),
            this);
    }

    destroy() {
        this.watchFocus(false);
        Main.messageTray.disconnectObject(this);
        Main.overview.disconnectObject(this);
    }

    /** A GNOME banner or the overview is on screen. */
    get busy() {
        return Main.messageTray.visible || Main.overview.visible;
    }

    /**
     * The app and window a session's Claude Code runs in: the first process
     * of the chain with a window (Claude Code, its terminal, VS Code…),
     * else the app the hint names. Of several windows, the one whose title
     * names the project (attention.js pickWindow(): when it is for sure).
     *
     * @param {object} target {pids, desktop, project}
     * @returns {?{appId: string, appName: string, window: ?Meta.Window, exact: boolean}}
     */
    resolve({pids, desktop, project}) {
        const tracker = Shell.WindowTracker.get_default();
        let app = null;
        for (const [pid] of pids ?? []) {
            app = tracker.get_app_from_pid(pid);
            if (app)
                break;
        }
        if (!app && desktop)
            app = Shell.AppSystem.get_default().lookup_app(desktop);
        if (!app)
            return null;

        const windows = app.get_windows().filter(w => !w.is_skip_taskbar());
        const pick = pickWindow(windows.map(w => w.get_title()), project);
        return {
            appId: app.get_id(),
            appName: app.get_name(),
            window: pick ? windows[pick.index] : null,
            exact: pick?.exact ?? false,
        };
    }

    /**
     * Whether the user is looking at where the session waits: its window
     * focused, or, when that window is not known for sure, any window of
     * its app (unless `exactOnly`).
     */
    isLookingAt(target, {exactOnly = false} = {}) {
        const found = this.resolve(target);
        const focus = global.display.focus_window;
        if (!found || !focus)
            return false;
        if (found.exact)
            return focus === found.window;
        if (exactOnly)
            return false;
        return Shell.WindowTracker.get_default().get_window_app(focus)?.get_id() === found.appId;
    }

    /** Brings the session's window to the front; never starts an app. */
    raise(target) {
        const window = this.resolve(target)?.window;
        if (window)
            Main.activateWindow(window);
    }

    /** Brings an app's most recent window to the front; never starts it. */
    raiseApp(appId) {
        const [window] = Shell.AppSystem.get_default().lookup_app(appId)?.get_windows() ?? [];
        if (window)
            Main.activateWindow(window);
    }

    isClaudeApp(appId) {
        return appId === CLAUDE_APP_ID;
    }

    /**
     * 'focus-changed' when the focus moves to another window, only while
     * asked for. The focus leaving the windows for the Shell (Ctrl+Alt+Tab
     * to the bar, for one) and coming back to the same window is no move:
     * the user went nowhere.
     */
    watchFocus(on) {
        if (on === this._focusWatched)
            return;
        this._focusWatched = on;
        if (on) {
            this._lastFocus = global.display.focus_window;
            global.display.connectObject('notify::focus-window', () => {
                const focus = global.display.focus_window;
                if (!focus || focus === this._lastFocus)
                    return;
                this._lastFocus = focus;
                this.emit('focus-changed');
            }, this);
        } else {
            global.display.disconnectObject(this);
            this._lastFocus = null;
        }
    }

    /**
     * Which GNOME notification sources the bar follows: the Claude app's,
     * and, with `browsers`, web browsers' (an app in the WebBrowser
     * category). A source without an app (notify-send, the "is ready"
     * window-attention source) is never followed. Flatpak browsers notify
     * through the portal, whose sources hide their app: not followed.
     */
    notificationFilter({app, browsers}) {
        return source => {
            const sourceApp = source.app;
            if (!(sourceApp instanceof Shell.App))
                return false;
            if (app && sourceApp.get_id() === CLAUDE_APP_ID)
                return true;
            return browsers && (sourceApp.get_app_info()?.get_categories() ?? '')
                .split(';').includes('WebBrowser');
        };
    }
}
