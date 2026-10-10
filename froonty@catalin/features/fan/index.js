// SPDX-License-Identifier: GPL-3.0-or-later
// Fan tab: the llano V12 Ultra cooling pad and the temperatures it is
// there for (docs/features/fan.md). Working tree only.

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {fanIcon} from './icon.js';
import {FanService} from './service.js';
import {FanView} from './view.js';

export default {
    id: 'fan',
    get title() {
        return _('Fan');
    },
    get icon() {
        return fanIcon();
    },
    enabledKey: 'fan-enabled',
    // Drag the open island's corner to change it.
    hubSizeKeys: {width: 'fan-width', height: 'fan-height'},
    createService: ctx => new FanService(ctx.settings),
    createView: (_ctx, service) => new FanView(service),
};
