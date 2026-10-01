// SPDX-License-Identifier: GPL-3.0-or-later
// Claude feature descriptor (docs/features/claude.md).

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {sparkIcon} from './icon.js';
import {LivenerfService} from './livenerfService.js';
import {ClaudeService} from './service.js';
import {ClaudeView} from './view.js';

export default {
    id: 'claude',
    // A getter: gettext only works once the extension object exists.
    get title() {
        return _('Claude');
    },
    // A getter: no GObject is created when the module loads, before
    // enable() (extensions.gnome.org review guidelines).
    get icon() {
        return sparkIcon();
    },
    enabledKey: 'claude-enabled',
    // Three limits and the cloud session credits, each a name, a bar and a
    // reset time; then livenerf's Opus 5.5 row with its chart.
    hubSize: {width: 380, height: 465},
    createService: ctx => new ClaudeService({
        benchmark: new LivenerfService(),
        settings: ctx.settings,
    }),
    createView: (ctx, service) => new ClaudeView(ctx, service),
};
