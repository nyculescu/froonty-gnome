// SPDX-License-Identifier: GPL-3.0-or-later
// Widgets tab: a compact collection of desktop and island widgets.

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {HorizonService} from './news/horizonService.js';
import {WidgetsView} from './view.js';

export default {
    id: 'widgets',
    get title() {
        return _('Widgets');
    },
    icon: 'view-list-symbolic',
    enabledKey: 'widgets-enabled',
    hubSizeKeys: {width: 'widgets-width', height: 'widgets-height'},
    createService: ctx => new HorizonService(ctx.settings),
    createView: (_ctx, service) => new WidgetsView(_ctx, service),
};
