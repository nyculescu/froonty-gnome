// SPDX-License-Identifier: GPL-3.0-or-later
// Clock feature descriptor. The clock is always available: it has no
// enable key, no service of its own (it uses the shared ctx.clock) and no
// settings tab (its options live in the General tab).

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ClockView} from './view.js';

export default {
    id: 'clock',
    // A getter: gettext only works once the extension object exists, not
    // while modules are being imported.
    get title() {
        return _('Clock');
    },
    icon: 'preferences-system-time-symbolic',
    enabledKey: null,
    // null: use the expanded-width/expanded-height settings.
    hubSize: null,
    createView: ctx => new ClockView(ctx),
};
