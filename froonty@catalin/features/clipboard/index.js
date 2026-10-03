// SPDX-License-Identifier: GPL-3.0-or-later
// Clipboard tab: the clipboard history (docs/features/clipboard.md).

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {acquireRecorder, releaseRecorder} from './shared.js';
import {ClipboardView} from './view.js';

// The tab's hold on the shared recorder; the extension holds it too while
// the tab is enabled (extension.js), so recording does not wait for the
// tab to be opened.
class ClipboardHandle {
    constructor(settings) {
        this._settings = settings;
        this.recorder = null;
    }

    start() {
        this.recorder = acquireRecorder(this._settings);
    }

    stop() {
        releaseRecorder();
        this.recorder = null;
    }
}

export default {
    id: 'clipboard',
    get title() {
        return _('Clipboard');
    },
    icon: 'edit-paste-symbolic',
    // Off by default: recording what is copied is the user's choice.
    enabledKey: 'clipboard-enabled',
    // Settings → Clipboard → Size.
    hubSizeKeys: {width: 'clipboard-width', height: 'clipboard-height'},
    createService: ctx => new ClipboardHandle(ctx.settings),
    createView: (ctx, handle) => new ClipboardView(ctx, handle.recorder),
    // Records copies as long as the tab is enabled, not only once its tab
    // has been opened (or while it is shown).
    background: {
        acquire: settings => acquireRecorder(settings),
        release: () => releaseRecorder(),
    },
};
