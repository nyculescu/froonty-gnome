// SPDX-License-Identifier: GPL-3.0-or-later
// Formulas settings tab: show the tab, whether its renderer (MathJax) is
// there, the recent formulas, and the tab's size
// (docs/features/formulas.md). Runs in the preferences process.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {sizeGroup, switchRow} from '../../prefs/rows.js';
import {isMathJaxFetched} from './renderer/client.js';
import {RECENT_KEY} from './service.js';

const SIZE_KEYS = ['formulas-width', 'formulas-height'];

function rendererGroup() {
    const group = new Adw.PreferencesGroup({
        title: _('Renderer'),
        description: _('MathJax draws the formulas, in a helper process that starts with the first preview and stops after a minute without one. It is fetched once from the npm registry by “make mathjax” in Froonty’s source folder (“make install” does it when it is missing), checked against fixed hashes, and never goes online itself.'),
    });
    const row = new Adw.ActionRow({title: _('MathJax'), subtitle: _('Checking…')});
    group.add(row);
    isMathJaxFetched().then(fetched => {
        row.subtitle = fetched
            ? _('Installed: previews are drawn.')
            : _('Not installed: the tab offers symbols, templates and the guide, without previews. Run “make mathjax”, then “make install”.');
    });
    return group;
}

function recentGroup(settings) {
    const group = new Adw.PreferencesGroup({title: _('Saved formulas')});
    const row = new Adw.ActionRow({
        title: _('Recent formulas'),
        subtitle: _('The last 20 copied, put into a note, or shown when the tab was left. Starred formulas stay until unstarred.'),
    });
    const clear = new Gtk.Button({label: _('Clear'), valign: Gtk.Align.CENTER});
    const sync = () => (clear.sensitive = settings.get_strv(RECENT_KEY).length > 0);
    clear.connect('clicked', () => settings.reset(RECENT_KEY));
    row.add_suffix(clear);
    group.add(row);
    sync();
    const id = settings.connect(`changed::${RECENT_KEY}`, sync);
    group.connect('destroy', () => settings.disconnect(id));
    return group;
}

export function formulasPage(settings) {
    const page = new Adw.PreferencesPage({
        name: 'formulas',
        title: _('Formulas'),
        icon_name: 'accessories-calculator-symbolic',
    });
    const group = new Adw.PreferencesGroup({
        title: _('Formulas'),
        description: _('Write LaTeX with a rendered preview, search symbols by name, start from templates, and copy the result as $…$ or $$…$$ or put it into the open note. Everything stays on this computer.'),
    });
    group.add(switchRow(settings, 'formulas-enabled', _('Show the Formulas tab')));
    group.add(switchRow(settings, 'formulas-display', _('Preview in display style'),
        _('As a formula on a line of its own; off, as inside a line of text')));
    page.add(group);
    page.add(rendererGroup());
    page.add(recentGroup(settings));
    page.add(sizeGroup(settings, SIZE_KEYS,
        _('Of the island while the Formulas tab is shown, in logical pixels. Or drag the open island’s bottom-right corner.')));
    return page;
}
