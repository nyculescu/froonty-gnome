// SPDX-License-Identifier: GPL-3.0-or-later
// Which window has the focus, for the Media service: bringing up a
// player's window shows that player (MediaService._onFocus).
//
// Emits 'changed' when the focus moves to another window.

import Shell from 'gi://Shell';

import {Emitter} from '../../core/emitter.js';

export class WindowFocus extends Emitter {
    constructor() {
        super();
        global.display.connectObject('notify::focus-window', () => this.emit('changed'), this);
    }

    /** @returns {?{pid: number, appId: ?string}} the focused window's */
    current() {
        const window = global.display.focus_window;
        if (!window)
            return null;
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        return {pid: window.get_pid(), appId: app?.get_id() ?? null};
    }

    destroy() {
        global.display.disconnectObject(this);
    }
}
