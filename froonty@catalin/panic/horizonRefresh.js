// SPDX-License-Identifier: GPL-3.0-or-later
// Panic button "Refresh Horizon" (cardButton.js): a click runs Horizon for
// a new briefing, also while no card shows Horizon (the card shows it when
// it next opens); with Horizon off, it opens the menu. The menu's own
// item: which AI writes the briefings.

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {horizonBusy, horizonError, horizonEvents, refreshHorizon} from '../features/horizon/shared.js';
import {addChoices, CardButton} from './cardButton.js';
import {byId} from './catalog.js';

export class HorizonRefreshButton extends CardButton {
    constructor(title, actions) {
        const {settings} = actions;
        const enabled = () => settings.get_boolean('horizon-enabled');
        super({
            title: _('Horizon'),
            icon: byId('horizon-refresh').icon,
            card: 'news',
            page: 'horizon',
            events: horizonEvents,
            signals: ['busy', 'error'],
            busy: horizonBusy,
            canRefresh: enabled,
            refresh: () => refreshHorizon(settings),
            describe: busy => {
                if (busy)
                    return _('Horizon: writing a new briefing…');
                if (!enabled())
                    return _('Horizon is off. Click to choose where it shows');
                const error = horizonError();
                return error
                    ? _('Horizon: %s. Click to try again').format(error.replace(/\.$/, ''))
                    : _('%s. Right-click for more').format(title);
            },
            fillMenu: (menu, s) => addChoices(menu, s, 'horizon-ai', _('AI'), [
                ['local', _('This computer (Writing’s model)')],
                ['chatgpt', _('ChatGPT plan')],
                ['api', _('API key')],
                ['config', _('Horizon’s own setting')],
            ]),
        }, actions);
    }
}
