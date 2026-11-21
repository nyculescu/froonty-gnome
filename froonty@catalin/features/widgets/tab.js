// SPDX-License-Identifier: GPL-3.0-or-later
// The Widgets tab: the Markets card (while its switch is on) above the
// Horizon briefings.

import St from 'gi://St';

import {acquireMarketsService, releaseMarketsService} from './markets/shared.js';
import {MarketsView} from './markets/view.js';
import {WidgetsView} from './view.js';

export class WidgetsTab {
    constructor(ctx, newsService) {
        this._settings = ctx.settings;
        this._markets = null;
        this.actor = new St.BoxLayout({
            style_class: 'froonty-widgets-tab',
            vertical: true,
            x_expand: true,
            y_expand: true,
        });
        this._news = new WidgetsView(ctx, newsService);
        this.actor.add_child(this._news.actor);
        this._settingsId = this._settings.connect('changed::widgets-markets-enabled', () => this._syncMarkets());
        this._syncMarkets();
    }

    destroy() {
        this._settings.disconnect(this._settingsId);
        this._hideMarkets();
        this._news.destroy();
        this.actor.destroy();
    }

    _syncMarkets() {
        const want = this._settings.get_boolean('widgets-markets-enabled');
        if (want && !this._markets) {
            this._markets = new MarketsView(acquireMarketsService(this._settings));
            this.actor.insert_child_at_index(this._markets.actor, 0);
        } else if (!want && this._markets) {
            this._hideMarkets();
        }
    }

    _hideMarkets() {
        if (!this._markets)
            return;
        this._markets.destroy();
        this._markets = null;
        releaseMarketsService();
    }
}
