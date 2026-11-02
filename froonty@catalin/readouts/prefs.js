// SPDX-License-Identifier: GPL-3.0-or-later
// "Readouts" settings tab: which values the collapsed pill prints (at most
// 8), in which order, and how often. Runs in the preferences process.

import Adw from 'gi://Adw';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {addChoiceGroups} from '../panic/prefs.js';
import {spinRow} from '../prefs/rows.js';
import {MAX_READOUTS, READOUTS, byId, sanitize} from './catalog.js';

export function readoutsPage(settings) {
    const page = new Adw.PreferencesPage({
        name: 'readouts',
        title: _('Readouts'),
        icon_name: 'dialog-information-symbolic',
    });
    addChoiceGroups(page, settings, {
        key: 'readouts',
        entries: READOUTS,
        byId,
        sanitize,
        max: MAX_READOUTS,
        chosenTitle: _('On the pill'),
        chosenDescription: _('Up to 8 values printed on the collapsed island, in this order, ' +
            'split around the time so that both sides come out about as wide. ' +
            'They only show: a click still opens the island.'),
        availableDescription: _('While the collapsed island is on screen these are read in the ' +
            'background, so choose only what you want to see all the time.'),
        emptyText: _('No readouts'),
        allChosenText: _('All readouts are on the pill'),
        fullText: _('The pill holds at most 8 readouts'),
    });
    const refresh = new Adw.PreferencesGroup({title: _('Refresh')});
    const interval = spinRow(settings, 'readouts-interval', _('Refresh every (s)'));
    interval.subtitle = _('For the CPU, graphics cards, memory, disk and network. Claude’s usage ' +
        'and the time zones update on their own.');
    refresh.add(interval);
    page.add(refresh);
    return page;
}
