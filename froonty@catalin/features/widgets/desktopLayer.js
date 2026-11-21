// SPDX-License-Identifier: GPL-3.0-or-later
// Widgets pinned to the desktop: a column of cards on GNOME's background
// actor group, above the wallpaper and behind normal windows. Each card
// exists while the Widgets tab and its own "Pin … to the desktop" switch
// are both on.

import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {acquireMarketsService, releaseMarketsService} from './markets/shared.js';
import {MarketsView} from './markets/view.js';
import {acquireHorizonService, releaseHorizonService} from './news/shared.js';
import {WidgetsView} from './view.js';

const MARGIN = 40;

// In column order: each makes its view and holds its service until destroyed.
const CARDS = [
    {
        key: 'widgets-markets-pin-desktop',
        create: settings => {
            const view = new MarketsView(acquireMarketsService(settings));
            return {actor: view.actor, destroy: () => {
                view.destroy();
                releaseMarketsService();
            }};
        },
    },
    {
        key: 'widgets-news-pin-desktop',
        create: settings => {
            const view = new WidgetsView(null, acquireHorizonService(settings));
            return {actor: view.actor, destroy: () => {
                view.destroy();
                releaseHorizonService();
            }};
        },
    },
];

export class DesktopPins {
    constructor(settings) {
        this._settings = settings;
        this._column = null;
        // key -> {frame, view}
        this._cards = new Map();
        this._settings.connectObject(
            'changed::widgets-enabled', () => this._sync(),
            ...CARDS.flatMap(card => [`changed::${card.key}`, () => this._sync()]),
            this);
        Main.layoutManager.connectObject('monitors-changed', () => this._place(), this);
        this._sync();
    }

    destroy() {
        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        for (const card of CARDS)
            this._hide(card);
        this._settings = null;
    }

    _sync() {
        const tab = this._settings.get_boolean('widgets-enabled');
        CARDS.forEach((card, index) => {
            const want = tab && this._settings.get_boolean(card.key);
            if (want && !this._cards.has(card.key))
                this._show(card, index);
            else if (!want && this._cards.has(card.key))
                this._hide(card);
        });
    }

    _show(card, index) {
        if (!this._column) {
            this._column = new St.BoxLayout({style_class: 'froonty-desktop-widgets', vertical: true});
            // Background actors are kept at the bottom of this group, so the
            // column stays above the wallpaper when it is reloaded.
            Main.layoutManager._backgroundGroup.add_child(this._column);
            this._place();
        }
        const frame = new St.BoxLayout({style_class: 'froonty-desktop-widget', vertical: true, reactive: true});
        const view = card.create(this._settings);
        frame.add_child(view.actor);
        // Before the first card shown that comes later in CARDS.
        const later = CARDS.slice(index + 1).map(c => this._cards.get(c.key)).find(Boolean);
        if (later)
            this._column.insert_child_below(frame, later.frame);
        else
            this._column.add_child(frame);
        this._cards.set(card.key, {frame, view});
    }

    _hide(card) {
        const shown = this._cards.get(card.key);
        if (!shown)
            return;
        this._cards.delete(card.key);
        shown.view.destroy();
        shown.frame.destroy();
        if (!this._cards.size) {
            this._column.destroy();
            this._column = null;
        }
    }

    // Top left of the primary monitor's work area, clear of the top bar.
    _place() {
        if (!this._column)
            return;
        const area = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        this._column.set_position(area.x + MARGIN, area.y + MARGIN);
    }
}
