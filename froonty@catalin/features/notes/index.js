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
    // Wide enough for five tabs showing a full "dd.mm.yy hh.mm" name.
    hubSize: {width: 760, height: 340},
    createService: ctx => new NotesService(ctx),
    createView: (ctx, service) => new NotesView(ctx, service),
};
