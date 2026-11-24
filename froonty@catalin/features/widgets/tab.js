// SPDX-License-Identifier: GPL-3.0-or-later
// The Widgets tab: the Markets card above the Horizon briefings, each while
// its feature and its tab switch are on (cards.js), scrolled together, so
// a long list of symbols does not push the briefings out of the tab's
// fixed height. Each card holds its feature's service while it shows.

import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {acquireHorizonService, releaseHorizonService} from '../horizon/shared.js';
import {HorizonView} from '../horizon/view.js';
import {acquireMarketsService, releaseMarketsService} from '../markets/shared.js';
import {MarketsView} from '../markets/view.js';
import {CARDS} from './cards.js';

// In the tab's order.
const TAB_CARDS = [
    {
        id: 'markets',
        create: ctx => ({
            view: new MarketsView(acquireMarketsService(ctx.settings)),
            release: releaseMarketsService,
        }),
    },
    {
        id: 'news',
        create: ctx => ({
            view: new HorizonView(ctx, acquireHorizonService(ctx.settings), {scroll: false}),
            release: releaseHorizonService,
        }),
    },
];

export class WidgetsTab {
    constructor(ctx) {
        this._ctx = ctx;
        this._settings = ctx.settings;
        // id -> {view, release} of the cards shown.
        this._shown = new Map();
        this._box = new St.BoxLayout({
            style_class: 'froonty-widgets-tab',
            vertical: true,
            x_expand: true,
        });
        this.actor = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            child: this._box,
        });
        this._empty = new St.Label({
            style_class: 'froonty-widgets-status',
            text: _('Nothing to show here. Turn Markets or Horizon on for this tab in Settings → Widgets, or right-click their panic buttons.'),
            visible: false,
        });
        this._empty.clutter_text.line_wrap = true;
        this._box.add_child(this._empty);
        this._settingsIds = TAB_CARDS.flatMap(card => [CARDS[card.id].feature, CARDS[card.id].tab])
            .map(key => this._settings.connect(`changed::${key}`, () => this._sync()));
        this._sync();
    }

    destroy() {
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        for (const id of [...this._shown.keys()])
            this._hide(id);
        this.actor.destroy();
    }

    _sync() {
        TAB_CARDS.forEach((card, index) => {
            const keys = CARDS[card.id];
            const want = this._settings.get_boolean(keys.feature) && this._settings.get_boolean(keys.tab);
            if (want && !this._shown.has(card.id)) {
                const made = card.create(this._ctx);
                // After the cards before it that show.
                const at = TAB_CARDS.slice(0, index).filter(c => this._shown.has(c.id)).length;
                this._box.insert_child_at_index(made.view.actor, at);
                this._shown.set(card.id, made);
            } else if (!want && this._shown.has(card.id)) {
                this._hide(card.id);
            }
        });
        this._empty.visible = this._shown.size === 0;
    }

    _hide(id) {
        const made = this._shown.get(id);
        this._shown.delete(id);
        made.view.destroy();
        made.release();
    }
}
