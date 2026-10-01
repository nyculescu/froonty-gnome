// SPDX-License-Identifier: GPL-3.0-or-later
// Btop tab: the system monitor (docs/features/sysmon.md).

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {btopIcon} from './icon.js';
import {SysmonService} from './service.js';
import {SysmonView} from './view.js';

export default {
    id: 'sysmon',
    get title() {
        return _('Btop');
    },
    // A getter: no GObject is created when the module loads, before
    // enable() (extensions.gnome.org review guidelines).
    get icon() {
        return btopIcon();
    },
    enabledKey: 'sysmon-enabled',
    // Settings → Btop → Size. Defaults 460x480 (user request 2026-10-01).
    hubSizeKeys: {width: 'sysmon-width', height: 'sysmon-height'},
    createService: ctx => new SysmonService(ctx.settings),
    createView: (_ctx, service) => new SysmonView(service),
};
