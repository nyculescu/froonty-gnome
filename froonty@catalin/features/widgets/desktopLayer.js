// SPDX-License-Identifier: GPL-3.0-or-later
// The Horizon card pinned to the desktop: on GNOME's background actor
// group, above the wallpaper and behind normal windows. It exists while
// the Widgets tab and "Pin to the desktop" are both on.

import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {acquireHorizonService, releaseHorizonService} from './news/shared.js';
import {WidgetsView} from './view.js';

const MARGIN = 40;

export class DesktopNewsPin {
    constructor(settings) {
        this._settings = settings;
        this._card = null;
        this._view = null;
        this._settings.connectObject(
            'changed::widgets-enabled', () => this._sync(),
            'changed::widgets-news-pin-desktop', () => this._sync(),
            this);
        Main.layoutManager.connectObject('monitors-changed', () => this._place(), this);
        this._sync();
    }

    destroy() {
        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._hide();
        this._settings = null;
    }

    _sync() {
        const want = this._settings.get_boolean('widgets-enabled') &&
            this._settings.get_boolean('widgets-news-pin-desktop');
        if (want && !this._card)
            this._show();
        else if (!want && this._card)
            this._hide();
    }

    _show() {
        this._card = new St.BoxLayout({
            style_class: 'froonty-desktop-widget',
            vertical: true,
            reactive: true,
        });
        this._view = new WidgetsView(null, acquireHorizonService(this._settings));
        this._card.add_child(this._view.actor);
        // Background actors are kept at the bottom of this group, so the
        // card stays above the wallpaper when it is reloaded.
        Main.layoutManager._backgroundGroup.add_child(this._card);
        this._place();
    }

    _hide() {
        if (!this._card)
            return;
        this._view.destroy();
        this._view = null;
        this._card.destroy();
        this._card = null;
        releaseHorizonService();
    }

    // Top left of the primary monitor's work area, clear of the top bar.
    _place() {
        if (!this._card)
            return;
        const index = Main.layoutManager.primaryIndex;
        const area = Main.layoutManager.getWorkAreaForMonitor(index);
        this._card.set_position(area.x + MARGIN, area.y + MARGIN);
    }
}
