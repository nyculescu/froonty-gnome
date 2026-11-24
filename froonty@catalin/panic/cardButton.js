// SPDX-License-Identifier: GPL-3.0-or-later
// A panic button for a feature with a Widgets card (Markets, Horizon;
// marketsRefresh.js, horizonRefresh.js): a click refreshes it; a
// right-click, the Menu key, or a click while there is nothing to refresh
// drops down a menu under it (owner's request 2026-11-23). The menu: Refresh
// now, toggles that show or hide the card in the Widgets tab and on the
// desktop (on also turns on what it needs: widgets/cards.js), the
// feature's small settings, and its settings page. While a refresh runs
// the icon is GNOME's loading icon.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {isShown, setShown} from '../features/widgets/cards.js';

const BUSY_ICON = 'content-loading-symbolic';

/**
 * A title, then one toggle per choice of a string key, checked on the
 * current one (a click on the checked one keeps it).
 *
 * @param {ContextMenu} menu
 * @param {Gio.Settings} settings
 * @param {string} key
 * @param {string} title
 * @param {Array<[string, string]>} choices [value, label]
 */
export function addChoices(menu, settings, key, title, choices) {
    menu.addTitle(title);
    const section = menu.addSection();
    const items = [];
    const sync = () => {
        const current = settings.get_string(key);
        for (const [value, item] of items)
            item.setChecked(value === current);
    };
    for (const [value, label] of choices) {
        items.push([value, section.addToggle(label, false, () => {
            settings.set_string(key, value);
            sync();
        })]);
    }
    sync();
}

export class CardButton {
    /**
     * @param {object} spec
     * @param {string} spec.title the feature's name
     * @param {string} spec.icon
     * @param {string} spec.card its id in widgets/cards.js
     * @param {string} spec.page its settings page
     * @param {Emitter} spec.events signals after which the button is synced
     * @param {string[]} spec.signals those signals' names
     * @param {Function} spec.busy → whether a refresh runs
     * @param {Function} spec.canRefresh → whether a click can refresh now
     * @param {Function} spec.refresh starts one
     * @param {Function} spec.describe → the accessible name (the tooltip)
     * @param {Function} [spec.fillMenu] (menu, settings) adds its own items
     * @param {object} actions panic/registry.js: settings, ctx
     */
    constructor(spec, {settings, ctx}) {
        this._spec = spec;
        this._settings = settings;
        this._ctx = ctx;
        this._menu = null;
        this._refreshItem = null;
        this._icon = new St.Icon({icon_name: spec.icon, fallback_icon_name: 'view-refresh-symbolic'});
        this.actor = new St.Button({
            style_class: 'froonty-icon-button froonty-panic-button',
            accessible_name: spec.title,
            can_focus: true,
            track_hover: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
            child: this._icon,
        });
        this.actor.connect('clicked', (_button, clicked) => {
            if (clicked === Clutter.BUTTON_SECONDARY || !spec.canRefresh())
                this._openMenu();
            else if (!spec.busy())
                spec.refresh();
        });
        this.actor.connect('popup-menu', () => this._openMenu());
        this._eventIds = spec.signals.map(signal => spec.events.connect(signal, () => this._sync()));
        // A card shown or hidden from Settings changes what a click does.
        this._settings.connectObject('changed', () => this._sync(), this.actor);
        this._sync();
    }

    destroy() {
        for (const id of this._eventIds)
            this._spec.events.disconnect(id);
        this._settings.disconnectObject(this.actor);
        this._menu?.destroy();
        this.actor.destroy();
    }

    _sync() {
        const busy = this._spec.busy();
        this._icon.icon_name = busy ? BUSY_ICON : this._spec.icon;
        this.actor.accessible_name = this._spec.describe(busy);
        if (this._refreshItem) {
            this._refreshItem.label.text = busy ? _('Refreshing…') : _('Refresh now');
            this._refreshItem.setSensitive(this._spec.canRefresh() && !busy);
        }
    }

    _openMenu() {
        if (this._menu)
            return;
        const spec = this._spec;
        // On the icon: the menu takes over its source's Space and Return,
        // and the button keeps its own (ui/contextMenu.js).
        const menu = this._ctx.contextMenu(this._icon, {
            onClosed: () => {
                this._menu = null;
                this._refreshItem = null;
            },
        });
        this._menu = menu;
        menu.addTitle(spec.title);
        this._refreshItem = menu.addAction(_('Refresh now'), () => {
            spec.refresh();
            menu.close();
        });
        menu.addTitle(_('Show'));
        const places = menu.addSection();
        for (const [place, label] of [['tab', _('In the Widgets tab')], ['desktop', _('On the desktop')]]) {
            places.addToggle(label, isShown(this._settings, spec.card, place),
                on => setShown(this._settings, spec.card, place, on));
        }
        spec.fillMenu?.(menu, this._settings);
        menu.addAction(_('%s settings…').format(spec.title), () => {
            menu.close();
            this._ctx.openSettings(spec.page);
        });
        this._sync();
        menu.open();
    }
}
