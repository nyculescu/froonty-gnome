// SPDX-License-Identifier: GPL-3.0-or-later
// LocalSend tab: files between this computer and a phone running the
// LocalSend app, over the local network (docs/features/localsend.md).

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {acquireService, releaseService} from './shared.js';
import {LocalSendView} from './view.js';

// The tab's hold on the shared service (shared.js).
class LocalSendHandle {
    constructor(settings) {
        this._settings = settings;
        this.service = null;
    }

    start() {
        this.service = acquireService(this._settings);
    }

    stop() {
        releaseService();
        this.service = null;
    }
}

export default {
    id: 'localsend',
    get title() {
        return _('LocalSend');
    },
    icon: 'send-to-symbolic',
    // Off by default: it opens a port on the local network.
    enabledKey: 'localsend-enabled',
    hubSize: {width: 440, height: 380},
    createService: ctx => new LocalSendHandle(ctx.settings),
    createView: (ctx, handle) => new LocalSendView(ctx, handle.service),
    // Receives as long as the tab is enabled, not only once it was opened.
    background: {
        acquire: settings => acquireService(settings),
        release: () => releaseService(),
    },
};
