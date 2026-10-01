// SPDX-License-Identifier: GPL-3.0-or-later
// ZeroTier tab (docs/features/zerotier.md).

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {isInstalled} from './cli.js';
import {zeroTierIcon} from './icon.js';
import {ZeroTierService} from './service.js';
import {ZeroTierView} from './view.js';

export default {
    id: 'zerotier',
    get title() {
        return _('ZeroTier');
    },
    // A getter: no GObject is created when the module loads, before
    // enable() (extensions.gnome.org review guidelines).
    get icon() {
        return zeroTierIcon();
    },
    enabledKey: 'zerotier-enabled',
    // Once, on Froonty's first start: without ZeroTier installed, the tab
    // starts off (it can be turned on in the settings later).
    async setup(settings) {
        if (settings.get_boolean('zerotier-install-checked'))
            return;
        const installed = await isInstalled();
        settings.set_boolean('zerotier-install-checked', true);
        if (!installed)
            settings.set_boolean('zerotier-enabled', false);
    },
    hubSize: {width: 420, height: 280},
    createService: () => new ZeroTierService(),
    createView: (_ctx, service) => new ZeroTierView(service),
};