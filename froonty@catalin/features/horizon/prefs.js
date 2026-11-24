// SPDX-License-Identifier: GPL-3.0-or-later
// Settings → Horizon: the feature's switch, where Horizon is and keeps its
// briefings, and the AI that writes them (aiPrefs.js). Where the card
// shows is under Widgets (widgets/prefs.js, desktopPrefs.js).

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {switchRow} from '../../prefs/rows.js';
import {horizonAiGroup} from './aiPrefs.js';
import {defaultHorizonRepoPath} from './horizonAi.js';

export function horizonPage(settings) {
    const page = new Adw.PreferencesPage({
        name: 'horizon',
        title: _('Horizon'),
        icon_name: 'application-rss+xml-symbolic',
    });

    const group = new Adw.PreferencesGroup({
        title: _('Horizon'),
        description: _('News briefings that Horizon writes with an AI from the sources it follows, ' +
            'shown in the Widgets tab and on the desktop. A refresh runs Horizon for a new briefing: ' +
            'the card\'s Refresh button, or the Horizon panic button.'),
    });
    group.add(switchRow(settings, 'horizon-enabled', _('Horizon'),
        _('Off, the card shows nowhere and Horizon is not run')));

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
    for (const row of [repoRow, dataRow])
        settings.bind('horizon-enabled', row, 'sensitive', Gio.SettingsBindFlags.GET);
    page.add(group);
    page.add(horizonAiGroup(settings));
    return page;
}
