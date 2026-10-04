// SPDX-License-Identifier: GPL-3.0-or-later
// The formatting bar's buttons, in order: shared by the island's bar
// (formatBar.js, St) and the All notes window's (allNotesFormatBar.js,
// GTK). Pure: each process passes its own gettext.
//
// Each action applies one pure edit from markdown.js to {text, start, end}.
// Toggles (every action but Link) also say whether their formatting applies
// at the cursor or selection (`active`).

import * as Md from './markdown.js';

const wrap = marker => ({
    edit: s => Md.toggleWrap(s, marker),
    active: s => Md.isWrapped(s, marker),
});
const prefix = text => ({
    edit: s => Md.toggleLinePrefix(s, text),
    active: s => Md.hasLinePrefix(s, text),
});

/**
 * @param {Function} _ the process's gettext
 * @returns {{icon?: string, label?: string, name: string, edit: Function,
 *   active?: Function}[]}
 */
export function formatActions(_) {
    // Adwaita has no heading or code icons; those use short text labels.
    return [
        {icon: 'format-text-bold-symbolic', name: _('Bold'), ...wrap('**')},
        {icon: 'format-text-italic-symbolic', name: _('Italic'), ...wrap('_')},
        {icon: 'format-text-strikethrough-symbolic', name: _('Strikethrough'), ...wrap('~~')},
        {label: 'H', name: _('Heading'), ...prefix('# ')},
        {icon: 'view-list-bullet-symbolic', name: _('Bulleted list'), ...prefix('- ')},
        {
            icon: 'view-list-ordered-symbolic',
            name: _('Numbered list'),
            edit: s => Md.toggleNumbered(s),
            active: s => Md.isNumbered(s),
        },
        {icon: 'checkbox-checked-symbolic', name: _('Checklist'), ...prefix('- [ ] ')},
        {label: '</>', name: _('Code'), ...wrap('`')},
        // An action, not a toggle: it always inserts a new link.
        {icon: 'insert-link-symbolic', name: _('Link'), edit: s => Md.insertLink(s)},
    ];
}
