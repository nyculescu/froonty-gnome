// SPDX-License-Identifier: GPL-3.0-or-later
// Kill Process tab: the user's processes, each with a kill button
// (docs/features/kill-process.md).

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {KillProcessService} from './service.js';
import {KillProcessView} from './view.js';

export default {
    id: 'killprocess',
    get title() {
        return _('Kill Process');
    },
    icon: 'process-stop-symbolic',
    // Off by default: a tool that ends programs is the user's choice to show.
    enabledKey: 'killprocess-enabled',
    // Settings → Kill Process → Size.
    hubSizeKeys: {width: 'killprocess-width', height: 'killprocess-height'},
    createService: ctx => new KillProcessService(ctx.settings),
    createView: (_ctx, service) => new KillProcessView(service),
};
