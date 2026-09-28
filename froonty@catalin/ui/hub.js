// SPDX-License-Identifier: GPL-3.0-or-later
// The hub: content of the expanded island. It hosts features (see
// docs/FEATURES.md) and contains no feature logic of its own:
//
//   ┌──────────────────────────────────────────┐
//   │ [tab] [tab] [tab]                     ⚙️ │  header: icon tab row
//   ├──────────────────────────────────────────┤
//   │           active feature's view          │  content
//   └──────────────────────────────────────────┘
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

const LAST_TAB_KEY = 'hub-last-tab';

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
        this._setEntryActive(entry, this._shown);
        // Only on change: select() also runs on every enable (screen unlock).
        if (this._settings.get_string(LAST_TAB_KEY) !== id)
            this._settings.set_string(LAST_TAB_KEY, id);
        this.emit('size-changed');
    }

    // Tells the feature (service and view, both optional) whether it is
    // on screen: services can pause work, views can take the key focus.
    _setEntryActive(entry, active) {
        entry?.service?.setActive?.(active);
        entry?.view?.setActive?.(active);
    }

    _buildActors(openSettings) {
        this.actor = new St.BoxLayout({
            style_class: 'froonty-hub',
            vertical: true,
            x_expand: true,
            y_expand: true,
            // Catches clicks on empty parts of the hub so they do not bubble
            // up to the pill (an St.Button that toggles the island, and
            // whose press clears the key focus of editors inside it).
            // Clicking inside the expanded hub never collapses it.
            reactive: true,
        });
        for (const signal of ['button-press-event', 'button-release-event', 'touch-event'])
            this.actor.connect(signal, () => Clutter.EVENT_STOP);

        const header = new St.BoxLayout({style_class: 'froonty-hub-header'});
        this._tabBar = new St.BoxLayout({style_class: 'froonty-tab-bar'});
        header.add_child(this._tabBar);
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

        this.actor.add_child(header);
        this.actor.add_child(this._content);
    }

    // Adds entries for newly enabled features, removes disabled ones, and
    // rebuilds the tab row in registry order.
    _syncTabs() {
        const enabled = this._features.filter(f =>
            !f.enabledKey || this._settings.get_boolean(f.enabledKey));

        for (const id of [...this._entries.keys()]) {
            if (!enabled.some(f => f.id === id))
                this._removeEntry(id);
        }

        this._tabBar.remove_all_children();
        for (const feature of enabled) {
            const entry = this._entries.get(feature.id) ?? this._addEntry(feature);
            this._tabBar.add_child(entry.button);
        }
        // A single tab is not a choice; keep the row out of the way.
        this._tabBar.visible = enabled.length > 1;

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
            child: new St.Icon({icon_name: feature.icon}),
        });
        button.connect('clicked', () => this.select(feature.id));

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
