// SPDX-License-Identifier: GPL-3.0-or-later
// Widgets tab: the Markets and Horizon cards (features of their own), in
// the island and optionally on the desktop with the System card and the
// notes' stickies.

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {DesktopPins} from './desktopLayer.js';
import {WidgetsTab} from './tab.js';

export default {
    id: 'widgets',
    get title() {
        return _('Widgets');
    },
    icon: 'view-list-symbolic',
    enabledKey: 'widgets-enabled',
    hubSizeKeys: {width: 'widgets-width', height: 'widgets-height'},
    // Each card holds its own feature's service while it shows (tab.js).
    createView: ctx => new WidgetsTab(ctx),
    // Settings → Widgets → the "Pin … to the desktop background" switches.
    createExtensionPart: settings => new DesktopPins(settings),
};
