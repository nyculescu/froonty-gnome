// SPDX-License-Identifier: GPL-3.0-or-later
// Widgets tab: a compact collection of desktop and island widgets.

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {DesktopNewsPin} from './desktopLayer.js';
import {acquireHorizonService, releaseHorizonService} from './news/shared.js';
import {WidgetsView} from './view.js';

// The tab's hold on the service it shares with the desktop card.
class HorizonHandle {
    constructor(settings) {
        this._settings = settings;
        this.service = null;
    }

    start() {
        this.service = acquireHorizonService(this._settings);
    }

    stop() {
        releaseHorizonService();
        this.service = null;
    }
}

export default {
    id: 'widgets',
    get title() {
        return _('Widgets');
    },
    icon: 'view-list-symbolic',
    enabledKey: 'widgets-enabled',
    hubSizeKeys: {width: 'widgets-width', height: 'widgets-height'},
    createService: ctx => new HorizonHandle(ctx.settings),
    createView: (ctx, handle) => new WidgetsView(ctx, handle.service),
    // Settings → Widgets → "Pin the Horizon news card to the desktop".
    createExtensionPart: settings => new DesktopNewsPin(settings),
};
