// SPDX-License-Identifier: GPL-3.0-or-later
// The hub: content of the expanded island. It hosts features
// (features/registry.js) and contains no feature logic of its own:
//
//   ┌─────┬──────────────────────────────────────────────────────┐
//   │ tab │ [p1][p2][p3][p4] (Sat Oct 3 14:05) [p5]…[p8]     [a] │  header
//   │ tab ├──────────────────────────────────────────────────────┤
//   │ …   │               active feature's view                  │  content
//   │     │                                                      │
//   │ ⚙️  │                                                      │
//   └─────┴──────────────────────────────────────────────────────┘
//     side column: the tab column (one icon per feature; its name shows in
//       a tooltip on hover), and ⚙️ at its bottom: Froonty's settings
//       window, the same size as a tab but never the active one
//     header (hubHeader.js): a pill with the date and the time that opens
//       GNOME's own calendar and notification menu (with GNOME's unread
//       dot), exactly over GNOME's clock under the island; the panic bar
//       (max 8) on its two sides, half each (the right one more when
//       odd), both sides equally wide; [a] the active feature's own
//       buttons (view.headerActions), at the right end
//
// Every tab can be turned off. With none on, the side column (⚙️) and the
// header stay, and the content says so, with a button that opens Settings.
// The tab column itself shows only while more than one tab is on.
//
// The date pill never leaves GNOME's clock: the island is made wider
// (minWidth) until both halves around it fit PANIC_GAP clear of the side
// column and the feature's buttons, and taller (minHeight) when the side
// column needs it.
//
// Keyboard (Tab): the tabs, ⚙️, the header row from left to right (panic
// 1–4, the date pill, panic 5–8, the feature's buttons), then the view.
//
// A feature's view (and its service, if any) is created the first time its
// tab is selected, and destroyed when the feature is disabled or the hub is
// destroyed. Services and views are told (setActive) when the feature is
// shown or hidden: services can pause work nobody sees, views can take the
// key focus.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {Emitter} from '../core/emitter.js';
import {Tooltip} from '../core/tooltip.js';
import {HubHeader, PANIC_GAP} from './hubHeader.js';
import {PanicBar} from './panicBar.js';

const LAST_TAB_KEY = 'hub-last-tab';

// Feature tabs fill a grid column by column. One column: the island grows
// taller when the tabs need it (minHeight).
const TAB_COLUMNS = 1;

/** Emits 'size-changed' when the active feature's preferred size changes. */
export class Hub extends EventEmitter {
    /**
     * @param {object} ctx feature context, passed to every feature
     * @param {object[]} features descriptors, in tab order
     * @param {object} actions
     * @param {Function} actions.openSettings
     * @param {Function} [actions.clockOffset] → how far right of the
     *   island's middle GNOME's top bar clock is centred (stage px): the
     *   header's date pill sits exactly on it
     * @param {?Function} actions.openCalendar opens GNOME's calendar and
     *   notification menu; null when this Shell has none (no date pill)
     */
    constructor(ctx, features, {openSettings, openCalendar, clockOffset = () => 0}) {
        super();
        this._clockOffset = clockOffset;
        this._ctx = ctx;
        this._settings = ctx.settings;
        this._features = features;
        this._entries = new Map(); // id -> {feature, button, view, service}
        this._activeId = null;
        this._shown = false;

        this._buildActors(openSettings, openCalendar);

        for (const key of features.map(f => f.enabledKey).filter(Boolean))
            this._settings.connectObject(`changed::${key}`, () => this._syncTabs(), this);
        this._syncTabs();
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._header.destroy();
        this._panicBar.destroy();
        for (const id of [...this._entries.keys()])
            this._removeEntry(id);
        this.actor.destroy();
    }

    /** Descriptor of the active feature; null while no tab is on. */
    get activeFeature() {
        return this._entries.get(this._activeId)?.feature ?? null;
    }

    /**
     * The view of a tab opened before (its feature on), or null. Never
     * creates one.
     *
     * @param {string} id the feature's id
     */
    viewOf(id) {
        return this._entries.get(id)?.view ?? null;
    }

    /** Logical px the active feature adds to its size for now (view.extraHeight). */
    get activeExtraHeight() {
        return this._entries.get(this._activeId)?.view?.extraHeight ?? 0;
    }

    /**
     * Escape in the open island: the active view may close something of
     * its own first (view.handleEscape()).
     *
     * @returns {boolean} true when the view used it
     */
    handleEscape() {
        return this._entries.get(this._activeId)?.view?.handleEscape?.() ?? false;
    }

    /**
     * The height the side column needs (physical pixels: every tab, and
     * ⚙️ below them), so the island can grow to show them; 0 off stage.
     */
    get minHeight() {
        // Kept in step on every path, as for minWidth.
        this._reportedMinHeight = this._side.get_stage() ? this._side.get_preferred_height(-1)[1] : 0;
        return this._reportedMinHeight;
    }

    /**
     * The width the island's content needs (physical pixels) so that the
     * date pill and the panic buttons beside it fit between the side
     * column and the feature's header buttons with PANIC_GAP on each side;
     * 0 off stage or with neither a date pill nor panic buttons.
     */
    get minWidth() {
        // Whatever it returns is what was reported: the allocation watches
        // below compare against it, and a stale value made them report a
        // change on every frame of an animation.
        this._reportedMinWidth = this._measureMinWidth();
        return this._reportedMinWidth;
    }

    _measureMinWidth() {
        if (!this.actor.get_stage() || !this._header.centred.some(actor => actor.visible))
            return 0;
        const natural = actor => (actor.visible ? actor.get_preferred_width(-1)[1] : 0);
        const gap = PANIC_GAP * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const spacing = this._main.get_theme_node().get_length('spacing');
        const [before, after] = this._header.halves();
        // The date pill never moves off the clock: the island, centred on
        // the monitor, is made wide enough for both halves around that
        // point, the side column before it and the feature's actions after.
        const lead = natural(this._side) + spacing + gap + before;
        const trail = after + gap + natural(this._header.actions);
        const rtl = this.actor.get_text_direction() === Clutter.TextDirection.RTL;
        const offset = rtl ? -this._clockOffset() : this._clockOffset();
        return Math.ceil(2 * Math.max(lead - offset, trail + offset));
    }

    // Where the date pill's middle goes, from the header row's left edge
    // (stage px): over GNOME's top bar clock, which is the island's middle
    // shifted by the clock's offset. The allocations of the header and its
    // parents are this layout pass's, set before the header places its
    // parts.
    _headerMiddle() {
        let x = 0;
        for (let actor = this._header.actor; actor && actor !== this.actor; actor = actor.get_parent())
            x += actor.get_allocation_box().x1;
        return this.actor.get_allocation_box().get_width() / 2 + this._clockOffset() - x;
    }

    /**
     * Shows GNOME's unread dot on the header's date pill, whose name then
     * says so.
     *
     * @param {boolean} unread whether GNOME's clock would show its dot
     */
    setUnread(unread) {
        this._header.setUnread(unread);
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
        // Its header buttons, before the size: they may widen the island.
        this._header.showActions(id);
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

    _buildActors(openSettings, openCalendar) {
        // Main layout plus an overlay layer (fixed positions, click-through)
        // for the tooltips.
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
        this._tooltip = new Tooltip();

        const main = new St.BoxLayout({style_class: 'froonty-hub', x_expand: true, y_expand: true});
        this._main = main;
        // The side column: the tabs at the top, ⚙️ at the bottom. It shows
        // with any number of tabs on (⚙️ is always there); the tab column
        // in it only with more than one.
        this._side = new St.BoxLayout({
            style_class: 'froonty-hub-side',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._tabGrid = new Clutter.GridLayout({orientation: Clutter.Orientation.VERTICAL});
        this._tabColumn = new St.Widget({
            style_class: 'froonty-tab-column',
            layout_manager: this._tabGrid,
        });
        this._side.add_child(this._tabColumn);
        this._side.add_child(new St.Widget({y_expand: true}));
        this.settingsButton = this._buildSettingsButton(openSettings);
        this._side.add_child(this.settingsButton);
        main.add_child(this._side);
        // Before they are first shown (styled), the tabs measure short.
        // Once laid out they are measured again, and the island follows if
        // that changed; their own height does not change while the island
        // animates, so this does not fire then.
        this._reportedMinHeight = 0;
        this._side.connect('notify::allocation', () => {
            const reported = this._reportedMinHeight;
            if (this._side.mapped && this.minHeight !== reported)
                this.emit('size-changed');
        });

        const right = new St.BoxLayout({
            style_class: 'froonty-hub-main',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        // The header row: the date pill centred on the island with the
        // panic buttons on its two sides, and the active feature's buttons
        // at the right end (hubHeader.js places them). Only the buttons
        // take input.
        this._panicBar = new PanicBar(this._settings, this._tooltip, {
            settings: this._settings,
            ctx: this._ctx,
            selectTab: id => {
                this.select(id);
                return this._activeId === id;
            },
        });
        this._header = new HubHeader(this._tooltip, {
            clock: this._ctx.clock,
            openCalendar,
            panic: this._panicBar.groups,
            centre: () => this._headerMiddle(),
        });
        this.calendarButton = this._header.calendarButton;

        this._content = new St.Widget({
            style_class: 'froonty-hub-content',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._empty = this._buildEmptyNotice(openSettings);
        this._content.add_child(this._empty);
        right.add_child(this._header.actor);
        right.add_child(this._content);
        main.add_child(right);

        // The panic buttons, the date pill's text, the feature's buttons and
        // the side column change width with the settings, the clock and the
        // active tab; once laid out, the island follows if the room they
        // need changed (as for minHeight).
        this._reportedMinWidth = 0;
        for (const actor of [...this._header.centred, this._header.actions, this._side]) {
            actor.connect('notify::allocation', () => {
                const reported = this._reportedMinWidth;
                if (actor.mapped && this.minWidth !== reported)
                    this.emit('size-changed');
            });
        }

        const overlay = new St.Widget({x_expand: true, y_expand: true});
        overlay.add_child(this._tooltip.actor);

        this.actor.add_child(main);
        this.actor.add_child(overlay);
    }

    // ⚙️: a tab's size and look (never checked: it opens a window, it is
    // not a page of the hub), its name in a tooltip on its right as theirs.
    _buildSettingsButton(openSettings) {
        const button = new St.Button({
            style_class: 'froonty-icon-button froonty-tab froonty-hub-settings',
            accessible_name: _('Settings'),
            can_focus: true,
            track_hover: true,
            child: new St.Icon({icon_name: 'emblem-system-symbolic'}),
        });
        button.connect('clicked', () => openSettings());
        this._tooltip.attach(button, () => button.accessible_name, 'right');
        return button;
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
        // A single tab is not a choice; keep the column out of the way
        // (the side column stays, for ⚙️).
        this._tabColumn.visible = enabled.length > 1;
        // No tab on: the header stays, and the content says so.
        this._empty.visible = enabled.length === 0;
        // More or fewer tabs may need another island height (minHeight).
        this.emit('size-changed');

        if (!this._entries.has(this._activeId)) {
            this._activeId = null;
            // The tab shown last; if it is gone or off (the Clock tab, which
            // is no more), the first one that is on.
            const last = this._settings.get_string(LAST_TAB_KEY);
            if (enabled.length)
                this.select(this._entries.has(last) ? last : enabled[0].id);
            else
                this._header.showActions(null);
        }
    }

    // What the content shows while every tab is off: a short notice and
    // the way back to them.
    _buildEmptyNotice(openSettings) {
        const box = new St.BoxLayout({
            style_class: 'froonty-hub-empty',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        box.add_child(new St.Label({
            style_class: 'froonty-hub-empty-title',
            text: _('No tabs are on'),
            x_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(new St.Label({
            style_class: 'froonty-hub-empty-body',
            text: _('Each tab has a switch on its page in Settings.'),
            x_align: Clutter.ActorAlign.CENTER,
        }));
        this.emptySettingsButton = new St.Button({
            style_class: 'froonty-hub-empty-button',
            label: _('Open Settings'),
            x_align: Clutter.ActorAlign.CENTER,
            can_focus: true,
            track_hover: true,
        });
        this.emptySettingsButton.connect('clicked', () => openSettings());
        box.add_child(this.emptySettingsButton);
        return box;
    }

    _addEntry(feature) {
        // An icon name, or a Gio.Icon for one the feature bundles.
        const iconParams = typeof feature.icon === 'string'
            ? {icon_name: feature.icon} : {gicon: feature.icon};
        const button = new St.Button({
            style_class: 'froonty-icon-button froonty-tab',
            accessible_name: feature.title,
            can_focus: true,
            track_hover: true,
            child: new St.Icon(iconParams),
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
        // Header buttons of its own (view contract: owned and destroyed by
        // the view; shown only while its tab is active).
        this._header.addActions(entry.feature.id, entry.view.headerActions ?? []);
        // A view whose size changes by itself (an Emitter) says so.
        if (entry.view instanceof Emitter)
            entry.viewSizeId = entry.view.connect('size-changed', () => this.emit('size-changed'));
    }

    _removeEntry(id) {
        const entry = this._entries.get(id);
        if (entry.viewSizeId)
            entry.view.disconnect(entry.viewSizeId);
        // The view destroys its own header buttons; then their box goes.
        entry.view?.destroy();
        this._header.removeActions(id);
        entry.service?.stop();
        entry.button.destroy();
        this._entries.delete(id);
        if (this._activeId === id)
            this._activeId = null;
    }
}
