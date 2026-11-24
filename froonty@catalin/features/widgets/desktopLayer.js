// SPDX-License-Identifier: GPL-3.0-or-later
// The desktop layer: the widget cards and the notes pinned to the desktop
// as stickies (features/notes/stickies.js), above the wallpaper and behind
// normal windows, each at its own position and size
// (widgets-desktop-positions, placement.js), in the primary monitor's work
// area (clear of the top bar and a fixed dock, or beside a dock that covers
// only part of its strip), never overlapping. Each item exists while
// "Show widgets on the desktop" and its own switch are on, whatever the
// Widgets tab's switch says; the stickies also need the Notes tab. While
// anything shows, "Widget Lock" in Quick Settings can make it all ignore
// the pointer.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {desktopIconsActor} from '../../shell/desktopIcons.js';
import {dockActor, dockRect} from '../../shell/dock.js';
import {acquireHorizonService, releaseHorizonService} from '../horizon/shared.js';
import {HorizonView} from '../horizon/view.js';
import {acquireMarketsService, releaseMarketsService} from '../markets/shared.js';
import {MarketsView} from '../markets/view.js';
import {Stickies} from '../notes/stickies.js';
import {WidgetLockToggle} from './lockToggle.js';
import {ITEMS, layoutItems, normalizePlacement, stickyId} from './placement.js';
import {forgetHistory} from './system/service.js';
import {SystemView} from './system/view.js';

const PLACEMENT_KEY = 'widgets-desktop-positions';
const GEOMETRY_KEY = 'widgets-desktop-geometry';

// Each makes its view and holds its service until destroyed; `id` is its
// name in the placement. `feature`: the switch of the feature it belongs
// to, which must be on too. `forget` drops what a card keeps across screen
// locks, when it is switched off.
const CARDS = [
    {
        id: 'markets',
        key: 'widgets-markets-pin-desktop',
        feature: 'markets-enabled',
        create: settings => {
            const view = new MarketsView(acquireMarketsService(settings), {scroll: true});
            return {actor: view.actor, view, destroy: () => {
                view.destroy();
                releaseMarketsService();
            }};
        },
    },
    {
        id: 'news',
        key: 'widgets-news-pin-desktop',
        feature: 'horizon-enabled',
        create: settings => {
            const view = new HorizonView(null, acquireHorizonService(settings), {refresh: false});
            return {actor: view.actor, view, destroy: () => {
                view.destroy();
                releaseHorizonService();
            }};
        },
    },
    {
        id: 'system',
        key: 'widgets-system-pin-desktop',
        create: settings => {
            const view = new SystemView(settings);
            return {actor: view.actor, view, destroy: () => view.destroy()};
        },
        forget: forgetHistory,
    },
];

const rect = r => [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];

export class DesktopPins {
    constructor(settings) {
        this._settings = settings;
        // key -> {id, frame, card}: card is what CARDS' create() made.
        this._cards = new Map();
        this._stickies = null;
        this._lockToggle = null;
        // The Ubuntu dock's container, while watched (_watchDock).
        this._dock = null;
        this._laterId = 0;
        // The geometry last written, as JSON.
        this._written = null;
        // Kept while Froonty runs, hidden while empty, so it keeps its place
        // in the stacking. Its children are the items, placed by _layout.
        this._layer = new St.Widget({style_class: 'froonty-desktop-widgets', visible: false});
        this._settings.connectObject(
            'changed::widgets-desktop-enabled', () => this._sync(),
            'changed::widgets-stickies-on-desktop', () => this._sync(),
            'changed::notes-enabled', () => this._sync(),
            'changed::widgets-desktop-locked', () => this._syncLock(),
            'changed::widgets-desktop-actions', () => this._syncActions(),
            `changed::${PLACEMENT_KEY}`, () => this._queueLayout(),
            ...CARDS.flatMap(card => [card.key, card.feature].filter(Boolean)
                .flatMap(key => [`changed::${key}`, () => this._sync()])),
            this);
        Main.layoutManager.connectObject('monitors-changed', () => this._queueLayout(), this);
        // A dock reserves its space after Froonty starts (and after each
        // unlock), so the work area changes then.
        global.display.connectObject(
            'workareas-changed', () => this._queueLayout(),
            'restacked', () => this._stack(),
            this);
        this._stack();
        this._sync();
        this._syncLock();
    }

    // Under the lock screen the cards go but keep their history.
    destroy({locked = false} = {}) {
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        global.display.disconnectObject(this);
        this._dock?.disconnectObject(this);
        this._dock = null;
        for (const card of CARDS)
            this._hide(card, {forget: !locked});
        this._stickies?.destroy();
        this._stickies = null;
        this._lockToggle?.destroy();
        this._lockToggle = null;
        this._layer.destroy();
        this._layer = null;
        this._settings = null;
    }

    _sync() {
        const desktop = this._settings.get_boolean('widgets-desktop-enabled');
        for (const card of CARDS) {
            const want = desktop && this._settings.get_boolean(card.key) &&
                (!card.feature || this._settings.get_boolean(card.feature));
            if (want && !this._cards.has(card.key))
                this._show(card);
            else if (!want && this._cards.has(card.key))
                this._hide(card);
        }
        const notes = desktop && this._settings.get_boolean('notes-enabled') &&
            this._settings.get_boolean('widgets-stickies-on-desktop');
        if (notes && !this._stickies) {
            this._stickies = new Stickies(this._settings);
            this._stickies.connect('changed', () => this._syncShown());
        } else if (!notes && this._stickies) {
            this._stickies.destroy();
            this._stickies = null;
        }
        this._syncShown();
    }

    _show(card) {
        const frame = new St.BoxLayout({
            style_class: `froonty-desktop-widget froonty-desktop-${card.id}`,
            vertical: true,
            reactive: true,
        });
        const made = card.create(this._settings);
        // A card without links has no setActions.
        made.view.setActions?.(this._settings.get_boolean('widgets-desktop-actions'));
        frame.add_child(made.actor);
        this._layer.add_child(frame);
        this._watchSize(frame);
        this._cards.set(card.key, {id: card.id, frame, card: made});
    }

    _hide(card, {forget = true} = {}) {
        const shown = this._cards.get(card.key);
        if (!shown)
            return;
        this._cards.delete(card.key);
        shown.card.destroy();
        shown.frame.destroy();
        if (forget)
            card.forget?.();
    }

    // An item's size changes as it fills (news arrive, a note is pinned):
    // a right or bottom corner's far edge, and what stacks after it, move.
    _watchSize(actor) {
        actor.connect('notify::width', () => this._queueLayout());
        actor.connect('notify::height', () => this._queueLayout());
    }

    // The item actors that show, by placement id.
    // The widgets in ITEMS order (positions that tie keep it), then the
    // stickies in the order they were pinned (Settings numbers them so).
    _shownItems() {
        const frames = new Map([...this._cards.values()].map(({id, frame}) => [id, frame]));
        const items = new Map(ITEMS.filter(id => frames.has(id)).map(id => [id, frames.get(id)]));
        for (const [name, card] of this._stickies?.cards ?? [])
            items.set(stickyId(name), card);
        return items;
    }

    // The layer and the lock show while there is a card or a sticky.
    _syncShown() {
        // New sticky cards join the layer (the old ones were destroyed).
        for (const card of this._stickies?.cards.values() ?? []) {
            if (!card.get_parent()) {
                this._layer.add_child(card);
                this._watchSize(card);
            }
        }
        const shown = this._shownItems().size > 0;
        this._layer.visible = shown;
        this._queueLayout();
        if (shown && !this._lockToggle) {
            this._lockToggle = new WidgetLockToggle(this._settings);
            // Before GNOME's Background Apps item, which it keeps last, as its
            // addExternalIndicator does (private: panel.js _backgroundApps).
            const quickSettings = Main.panel.statusArea.quickSettings;
            quickSettings.menu.insertItemBefore(this._lockToggle,
                quickSettings._backgroundApps?.quickSettingsItems?.at(-1) ?? null);
        } else if (!shown && this._lockToggle) {
            this._lockToggle.destroy();
            this._lockToggle = null;
        }
    }

    // Clicks on Markets' rows and Horizon's headlines, or scrolling only.
    _syncActions() {
        const on = this._settings.get_boolean('widgets-desktop-actions');
        for (const {card} of this._cards.values())
            card.view.setActions?.(on);
    }

    _syncLock() {
        Shell.util_set_hidden_from_pick(this._layer, this._settings.get_boolean('widgets-desktop-locked'));
    }

    // Right above Desktop Icons' window where it runs, or it takes the
    // pointer (clicks, scrolling); else on the background group, whose
    // background actors stay at its bottom when the wallpaper is reloaded.
    // Mutter puts window actors back in order on each restack, leaving
    // other actors of the window group above them, so this runs after it.
    _stack() {
        const icons = desktopIconsActor();
        const parent = icons?.get_parent() ?? Main.layoutManager._backgroundGroup;
        if (this._layer.get_parent() !== parent) {
            this._layer.get_parent()?.remove_child(this._layer);
            parent.add_child(this._layer);
        }
        if (icons)
            parent.set_child_above_sibling(this._layer, icons);
    }

    // The dock appears after Froonty starts, may be made again, and moves
    // or grows as apps are added: the room beside it follows.
    _watchDock() {
        const dock = dockActor();
        if (dock === this._dock)
            return;
        this._dock?.disconnectObject(this);
        this._dock = dock;
        dock?.connectObject(
            'notify::y', () => this._queueLayout(),
            'notify::height', () => this._queueLayout(),
            'notify::visible', () => this._queueLayout(),
            this);
    }

    // Once before the next redraw, however many changes asked for it.
    _queueLayout() {
        if (this._laterId || !this._layer)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._layout();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Each item at its place, no taller than the room left (its content
    // scrolls within); then the geometry for Settings' picture.
    _layout() {
        if (!this._layer)
            return;
        this._watchDock();
        const items = this._shownItems();
        const placement = normalizePlacement(this._settings.get_value(PLACEMENT_KEY).deepUnpack(), [...items.keys()]);
        const screen = {
            work: Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex),
            monitor: Main.layoutManager.primaryMonitor,
            dock: dockRect(this._dock),
        };
        const placed = layoutItems(screen, [...items.keys()].map(id => ({id, ...placement[id]})),
            (id, cap) => this._measure(id, items.get(id), placement[id], cap));
        for (const [id, at] of placed) {
            const actor = items.get(id);
            if (actor.x !== at.x || actor.y !== at.y)
                actor.set_position(at.x, at.y);
        }
        this._writeGeometry(screen, new Map([...items.keys()].map(id => [id, placed.get(id)])));
    }

    // The item's outer size once it may be at most `cap` tall: its content
    // width and height cap in its style (padding and border are outside
    // them; St takes `width` as the least natural width, so `max-width`
    // holds it). A sticky is sized like a widget card.
    _measure(id, actor, {width, height}, cap) {
        const node = actor.get_theme_node();
        const outside = node.get_vertical_padding() +
            node.get_border_width(St.Side.TOP) + node.get_border_width(St.Side.BOTTOM);
        const style = `width: ${width}px; max-width: ${width}px; max-height: ${Math.max(0, cap - outside)}px;`;
        if (actor.style !== style)
            actor.style = style;
        if (id === 'markets')
            [...this._cards.values()].find(shown => shown.id === id).card.view.limitRows(height === 0);
        const [, , naturalWidth, naturalHeight] = actor.get_preferred_size();
        return {width: Math.round(naturalWidth), height: Math.round(naturalHeight)};
    }

    _writeGeometry({work, monitor, dock}, placed) {
        const geometry = {monitor: rect(monitor), work: rect(work)};
        if (dock)
            geometry.dock = rect(dock);
        for (const [id, at] of placed)
            geometry[id] = rect(at);
        const json = JSON.stringify(geometry);
        if (json === this._written)
            return;
        this._written = json;
        this._settings.set_value(GEOMETRY_KEY, new GLib.Variant('a{s(iiii)}', geometry));
    }
}
