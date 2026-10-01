// SPDX-License-Identifier: GPL-3.0-or-later
// Notes feature descriptor (docs/features/notes.md).

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {NotesService} from './service.js';
import {NotesView} from './view.js';

export default {
    id: 'notes',
    // A getter: gettext only works once the extension object exists.
    get title() {
        return _('Notes');
    },
    icon: 'document-edit-symbolic',
    enabledKey: 'notes-enabled',
    // Settings → Notes → Size. Defaults 428x319 (user request 2026-09-28:
    // 25% narrower and 25% taller than 570x255).
    hubSizeKeys: {width: 'notes-width', height: 'notes-height'},
    createService: ctx => new NotesService(ctx),
    createView: (ctx, service) => new NotesView(ctx, service),
};
