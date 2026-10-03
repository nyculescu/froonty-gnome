// SPDX-License-Identifier: GPL-3.0-or-later
// Writing tab: paraphrase, fix grammar, shorten, change the tone of, or
// summarise text, with Claude Code, LanguageTool or Ollama
// (docs/features/writing.md). Working-tree builds only: `make pack` leaves
// it out.

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {peekRecorder} from '../clipboard/shared.js';
import {WritingService} from './service.js';
import {WritingView} from './view.js';

export default {
    id: 'writing',
    get title() {
        return _('Writing');
    },
    icon: 'tools-check-spelling-symbolic',
    // Off by default: sending text anywhere is the user's choice.
    enabledKey: 'writing-enabled',
    // Settings → Writing → Size.
    hubSizeKeys: {width: 'writing-width', height: 'writing-height'},
    createService: ctx => new WritingService({settings: ctx.settings, peekRecorder}),
    createView: (ctx, service) => new WritingView(ctx, service),
};
