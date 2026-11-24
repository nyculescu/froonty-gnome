// SPDX-License-Identifier: GPL-3.0-or-later
// Panic button "Refresh Markets" (cardButton.js): a click fetches every
// symbol again, while a card shows Markets; with none, it opens the menu,
// where the card can be shown. The menu's own items: live prices and the
// graph span.

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {marketsBusy, marketsEvents, marketsHeld, refreshMarkets} from '../features/markets/shared.js';
import {addChoices, CardButton} from './cardButton.js';
import {byId} from './catalog.js';

export class MarketsRefreshButton extends CardButton {
    constructor(title, actions) {
        super({
            title: _('Markets'),
            icon: byId('markets-refresh').icon,
            card: 'markets',
            page: 'markets',
            events: marketsEvents,
            signals: ['busy', 'held'],
            busy: marketsBusy,
            canRefresh: marketsHeld,
            refresh: refreshMarkets,
            describe: busy => {
                if (busy)
                    return _('Markets: refreshing…');
                if (!marketsHeld())
                    return _('Markets shows nowhere. Click to choose where');
                return _('%s. Right-click for more').format(title);
            },
            fillMenu: (menu, settings) => {
                menu.addTitle(_('Prices'));
                menu.addSection().addToggle(_('Live prices'), settings.get_boolean('markets-live'),
                    on => settings.set_boolean('markets-live', on));
                addChoices(menu, settings, 'widgets-markets-range', _('Graph span'), [
                    ['1d', _('Today')], ['5d', _('5 days')], ['1mo', _('1 month')],
                    ['6mo', _('6 months')], ['1y', _('1 year')],
                ]);
            },
        }, actions);
    }
}
