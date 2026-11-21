// SPDX-License-Identifier: GPL-3.0-or-later
// Widgets tab: stock index graphs and Horizon briefings, in the island and
// optionally on the desktop.

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {DesktopPins} from './desktopLayer.js';
import {acquireHorizonService, releaseHorizonService} from './news/shared.js';
import {WidgetsTab} from './tab.js';

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
    createView: (ctx, handle) => new WidgetsTab(ctx, handle.service),
    // Settings → Widgets → the "Pin … to the desktop background" switches.
    createExtensionPart: settings => new DesktopPins(settings),
};
