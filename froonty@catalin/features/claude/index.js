// SPDX-License-Identifier: GPL-3.0-or-later
// Claude feature descriptor (docs/features/claude.md).

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {sparkIcon} from './icon.js';
import {ClaudeService} from './service.js';
import {ClaudeView} from './view.js';

export default {
    id: 'claude',
    // A getter: gettext only works once the extension object exists.
    get title() {
        return _('Claude');
    },
    icon: sparkIcon(),
    enabledKey: 'claude-enabled',
    // Three limits, each a name, a bar and a reset time.
    hubSize: {width: 380, height: 260},
    createService: () => new ClaudeService(),
    createView: (ctx, service) => new ClaudeView(ctx, service),
};
