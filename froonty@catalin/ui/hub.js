// SPDX-License-Identifier: GPL-3.0-or-later
// The hub: content of the expanded island. It hosts features (see
// docs/local/ideas.md) and contains no feature logic of its own:
//
//   ┌─────┬────────────────────────────────────┐
//   │ tab │      [panic][panic]…            ⚙️ │  panic bar (max 5), centered
//   │ tab ├────────────────────────────────────┤
//   │ …   │        active feature's view      │  content
//   └─────┴────────────────────────────────────┘
//     tab column: one icon per feature; its name shows in a tooltip on hover
//
// A feature's view (and its service, if any) is created the first time its
// tab is selected, and destroyed when the feature is disabled or the hub is
// destroyed. Services and views are told (setActive) when the feature is
// shown or hidden: services can pause work nobody sees, views can take the
// key focus.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Tooltip} from '../core/tooltip.js';
import {PanicBar} from './panicBar.js';

const LAST_TAB_KEY = 'hub-last-tab';

// Feature tabs fill a grid column by column. One column for now; raising
// this is the planned way to fit more features (placeholder).
const TAB_COLUMNS = 1;

/** Emits 'size-changed' when the active feature's preferred size changes. */
export class Hub extends EventEmitter {
    /**
     * @param {object} ctx feature context, passed to every feature
     * @param {object[]} features descriptors, in tab order
     * @param {object} actions
     * @param {Function} actions.openSettings
     */
    constructor(ctx, features, {openSettings}) {
        super();
        this._ctx = ctx;
        this._settings = ctx.settings;
        this._features = features;
        this._entries = new Map(); // id -> {feature, button, view, service}
        this._activeId = null;
        this._shown = false;

        this._buildActors(openSettings);

        for (const key of features.map(f => f.enabledKey).filter(Boolean))
            this._settings.connectObject(`changed::${key}`, () => this._syncTabs(), this);
        this._syncTabs();
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._panicBar.destroy();
        for (const id of [...this._entries.keys()])
            this._removeEntry(id);
        this.actor.destroy();
    }

    /** Descriptor of the active feature. */
    get activeFeature() {
        return this._entries.get(this._activeId)?.feature ?? null;
    }

    /** Tell the active feature whether the hub is visible. */
    setShown(shown) {
        this._shown = shown;
        if (!shown)
            this._tooltip.hide();
        this._panicBar.setShown(shown);
        this._setEntryActive(this._entries.get(this._activeId), shown);
    }

    select(id) {
        const entry = this._entries.get(id);
        if (!entry || id === this._activeId)
            return;

        const previous = this._entries.get(this._activeId);
        if (previous) {
            previous.button.checked = false;
            previous.view.actor.hide();
            this._setEntryActive(previous, false);
        }

        this._activeId = id;
        entry.button.checked = true;
        this._ensureView(entry);
        entry.view.actor.show();
        this.emit('size-changed');
        this._setEntryActive(entry, this._shown);
        // Only on change: select() also runs on every enable (screen unlock).
        if (this._settings.get_string(LAST_TAB_KEY) !== id)
            this._settings.set_string(LAST_TAB_KEY, id);
    }

    // Tells the feature (service and view, both optional) whether it is
    // on screen: services can pause work, views can take the key focus.
    _setEntryActive(entry, active) {
        entry?.service?.setActive?.(active);
        entry?.view?.setActive?.(active);
    }

    _buildActors(openSettings) {
        // Main layout plus an overlay layer (fixed positions, click-through)
        // for the tab tooltips.
        this.actor = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
            // Catches clicks on empty parts of the hub so they do not bubble
            // up to the pill (an St.Button that toggles the island, and
            // whose press clears the key focus of editors inside it).
            // Clicking inside the expanded hub never collapses it.
            reactive: true,
        });
        // On GNOME Shell 50 St.Button clicks through a Clutter.ClickGesture;
        // stopping press/release events here would starve the tabs' own
        // gestures too. A gesture of our own instead wins over the pill's
        // (an ancestor) and loses to the buttons' (descendants).
        this.actor.add_action(new Clutter.ClickGesture({required_button: Clutter.BUTTON_PRIMARY}));

        const main = new St.BoxLayout({style_class: 'froonty-hub', x_expand: true, y_expand: true});
        this._tabGrid = new Clutter.GridLayout({orientation: Clutter.Orientation.VERTICAL});
        this._tabColumn = new St.Widget({
            style_class: 'froonty-tab-column',
            layout_manager: this._tabGrid,
        });
        main.add_child(this._tabColumn);

        const right = new St.BoxLayout({
            style_class: 'froonty-hub-main',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        // The header row holds ⚙️ on the right; the panic bar is centered over
        // the whole island in its own layer (see below).
        const header = new St.BoxLayout({style_class: 'froonty-hub-header'});
        header.add_child(new St.Widget({x_expand: true}));

        this.settingsButton = new St.Button({
            style_class: 'froonty-icon-button',
            accessible_name: _('Settings'),
            can_focus: true,
            track_hover: true,
            child: new St.Icon({icon_name: 'emblem-system-symbolic'}),
        });
        this.settingsButton.connect('clicked', () => openSettings());
        header.add_child(this.settingsButton);

        this._content = new St.Widget({
            style_class: 'froonty-hub-content',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        right.add_child(header);
        right.add_child(this._content);
        main.add_child(right);

        // Panic bar: centered across the island (not just the column right of
        // the tabs), on the header row. Its layer is click-through; only the
        // buttons take input.
        this._tooltip = new Tooltip();
        this._panicBar = new PanicBar(this._settings, this._tooltip, {
            settings: this._settings,
            selectTab: id => {
                this.select(id);
                return this._activeId === id;
            },
        });
        const panicLayer = new St.Widget({
            style_class: 'froonty-panic-layer',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._panicBar.actor.set({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_expand: true,
        });
        panicLayer.add_child(this._panicBar.actor);

        const overlay = new St.Widget({x_expand: true, y_expand: true});
        overlay.add_child(this._tooltip.actor);

        this.actor.add_child(main);
        this.actor.add_child(panicLayer);
        this.actor.add_child(overlay);
    }

    // Adds entries for newly enabled features, removes disabled ones, and
    // rebuilds the tab column in registry order.
    _syncTabs() {
        const enabled = this._features.filter(f =>
            !f.enabledKey || this._settings.get_boolean(f.enabledKey));

        for (const id of [...this._entries.keys()]) {
            if (!enabled.some(f => f.id === id))
                this._removeEntry(id);
        }

        this._tabColumn.remove_all_children();
        const rows = Math.ceil(enabled.length / TAB_COLUMNS);
        enabled.forEach((feature, i) => {
            const entry = this._entries.get(feature.id) ?? this._addEntry(feature);
            this._tabGrid.attach(entry.button, Math.floor(i / rows), i % rows, 1, 1);
        });
        // A single tab is not a choice; keep the column out of the way.
        this._tabColumn.visible = enabled.length > 1;

        if (!this._entries.has(this._activeId)) {
            this._activeId = null;
            const last = this._settings.get_string(LAST_TAB_KEY);
            this.select(this._entries.has(last) ? last : enabled[0].id);
        }
    }

    _addEntry(feature) {
        const button = new St.Button({
            style_class: 'froonty-icon-button froonty-tab',
            accessible_name: feature.title,
            can_focus: true,
            track_hover: true,
            // An icon name, or a Gio.Icon for one the feature bundles.
            child: new St.Icon(typeof feature.icon === 'string'
                ? {icon_name: feature.icon} : {gicon: feature.icon}),
        });
        button.connect('clicked', () => this.select(feature.id));
        this._tooltip.attach(button, () => feature.title, 'right');

        const entry = {feature, button, view: null, service: null};
        this._entries.set(feature.id, entry);
        return entry;
    }

    _ensureView(entry) {
        if (entry.view)
            return;

        entry.service = entry.feature.createService?.(this._ctx) ?? null;
        entry.service?.start();
        entry.view = entry.feature.createView(this._ctx, entry.service);
        this._content.add_child(entry.view.actor);
    }

    _removeEntry(id) {
        const entry = this._entries.get(id);
        entry.view?.destroy();
        entry.service?.stop();
        entry.button.destroy();
        this._entries.delete(id);
        if (this._activeId === id)
            this._activeId = null;
    }
}
