// SPDX-License-Identifier: GPL-3.0-or-later
// Widgets settings: enable the tab, Horizon repo/data path, desktop pinning
// and the AI Horizon uses.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {sizeGroup, switchRow} from '../../prefs/rows.js';
import {horizonAiGroup} from './aiPrefs.js';
import {defaultHorizonRepoPath} from './news/horizonAi.js';

export function widgetsPage(settings) {
    const page = new Adw.PreferencesPage({
        name: 'widgets',
        title: _('Widgets'),
        icon_name: 'view-list-symbolic',
    });

    const group = new Adw.PreferencesGroup({
        title: _('Widgets'),
        description: _('News and desktop widgets from Horizon, shown in the island and optionally pinned to the desktop background.'),
    });
    group.add(switchRow(settings, 'widgets-enabled', _('Show the Widgets tab')));
    group.add(switchRow(settings, 'widgets-news-pin-desktop', _('Pin the Horizon news card to the desktop background')));

    const defaultRepoPath = defaultHorizonRepoPath();
    const repoRow = new Adw.EntryRow({
        title: _('Horizon repo path'),
        text: settings.get_string('horizon-repo-path') || defaultRepoPath,
        show_apply_button: true,
    });
    repoRow.connect('apply', () => settings.set_string('horizon-repo-path', repoRow.text.trim()));
    settings.connect('changed::horizon-repo-path', () => {
        repoRow.text = settings.get_string('horizon-repo-path') || defaultRepoPath;
    });
    group.add(repoRow);

    const dataRow = new Adw.EntryRow({
        title: _('Horizon data directory'),
        text: settings.get_string('horizon-data-dir'),
        show_apply_button: true,
    });
    dataRow.connect('apply', () => settings.set_string('horizon-data-dir', dataRow.text.trim()));
    settings.connect('changed::horizon-data-dir', () => {
        dataRow.text = settings.get_string('horizon-data-dir');
    });
    group.add(dataRow);
    page.add(group);
    page.add(horizonAiGroup(settings));
    page.add(sizeGroup(settings, ['widgets-width', 'widgets-height'],
        _('Of the island while the Widgets tab is shown, in logical pixels.')));
    return page;
}
