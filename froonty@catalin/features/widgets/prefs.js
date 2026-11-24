// SPDX-License-Identifier: GPL-3.0-or-later
// Widgets settings: the island's tab, how the Markets and Horizon cards
// look (each is a feature with its own page: markets/prefs.js,
// horizon/prefs.js), what shows on the desktop and where
// (desktopPrefs.js), and the System card.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {choiceRow, sizeGroup, switchRow} from '../../prefs/rows.js';
import {desktopGroups} from './desktopPrefs.js';
import {systemGroup} from './system/prefs.js';

export function widgetsPage(settings) {
    const page = new Adw.PreferencesPage({
        name: 'widgets',
        title: _('Widgets'),
        icon_name: 'view-list-symbolic',
    });

    const group = new Adw.PreferencesGroup({
        title: _('Widgets'),
        description: _('Markets and news from Horizon, in the island\'s Widgets tab and on the desktop. ' +
            'What they show is set on their own pages.'),
    });
    group.add(switchRow(settings, 'widgets-enabled', _('Widgets tab in the island'),
        _('Off, the tab goes; the desktop widgets stay as set below')));
    page.add(group);
    page.add(marketsGroup(settings));
    page.add(horizonGroup(settings));
    for (const group of desktopGroups(settings))
        page.add(group);
    page.add(systemGroup(settings));
    page.add(sizeGroup(settings, ['widgets-width', 'widgets-height'],
        _('Of the island while the Widgets tab is shown, in logical pixels.')));
    return page;
}

function marketsGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('Markets'),
        description: _('How the Markets card looks. Its symbols and where the prices come from are on the Markets page.'),
    });
    const tab = switchRow(settings, 'widgets-markets-enabled', _('Show Markets in the Widgets tab'));
    group.add(tab);
    group.add(choiceRow(settings, 'widgets-markets-range', _('Graph span'),
        ['1d', '5d', '1mo', '6mo', '1y'],
        [_('Today'), _('5 days'), _('1 month'), _('6 months'), _('1 year')]));
    // Markets off: nothing of it shows anywhere.
    settings.bind('markets-enabled', group, 'sensitive', Gio.SettingsBindFlags.GET);
    return group;
}

function horizonGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('Horizon'),
        description: _('Where the Horizon card shows. Its Horizon folder and the AI that writes the briefings are on the Horizon page.'),
    });
    group.add(switchRow(settings, 'widgets-news-enabled', _('Show Horizon in the Widgets tab')));
    // Horizon off: nothing of it shows anywhere.
    settings.bind('horizon-enabled', group, 'sensitive', Gio.SettingsBindFlags.GET);
    return group;
}
