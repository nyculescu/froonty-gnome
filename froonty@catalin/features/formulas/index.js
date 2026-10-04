// SPDX-License-Identifier: GPL-3.0-or-later
// Formulas tab: LaTeX with a rendered preview, symbol palettes, templates
// and a short guide (docs/features/formulas.md). Working-tree builds only:
// `make pack` leaves it out, with MathJax.

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {FormulasService} from './service.js';
import {FormulasView} from './view.js';

export default {
    id: 'formulas',
    get title() {
        return _('Formulas');
    },
    icon: 'accessories-calculator-symbolic',
    enabledKey: 'formulas-enabled',
    // Settings → Formulas → Size.
    hubSizeKeys: {width: 'formulas-width', height: 'formulas-height'},
    createService: ctx => new FormulasService(ctx.settings),
    createView: (ctx, service) => new FormulasView(ctx, service),
};
