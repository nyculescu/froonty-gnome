// SPDX-License-Identifier: GPL-3.0-or-later
// The hub: content of the expanded island. It hosts features
// (features/registry.js) and contains no feature logic of its own:
//
//   ┌─────┬──────────────────────────────────────────────┐
//   │ tab │      [panic][panic]…   (Sat Oct 3 14:05) [a] ⚙️ │  panic bar (max 5), centered
//   │ tab ├──────────────────────────────────────────────┤
//   │ …   │            active feature's view             │  content
//   └─────┴──────────────────────────────────────────────┘
//     tab column: one icon per feature; its name shows in a tooltip on hover
//     header (hubHeader.js): a pill with the date and the time that opens
//       GNOME's own calendar and notification menu (with GNOME's unread
//       dot, as on the tab of a feature that asks for it: unreadDot),
//       [a] the active feature's own buttons (view.headerActions), ⚙️
//
// Every tab can be turned off. With none on, the header stays and the
// content says so, with a button that opens Settings.
//
// The panic bar is centred on the island. On an island too narrow for
// that (a narrow tab beside the header's date pill and buttons) it moves
// left just enough to stay clear of the header's buttons (PanicLayout);
// the island is only made wider (minWidth) when the bar does not fit
// between the tab column and those buttons at all.
//
// A feature's view (and its service, if any) is created the first time its
// tab is selected, and destroyed when the feature is disabled or the hub is
// destroyed. Services and views are told (setActive) when the feature is
// shown or hidden: services can pause work nobody sees, views can take the
// key focus. The active view also hears of deliberate input in the open
// hub (onUserInput): the island opened by click, keyboard or shortcut, or
// a press, key or scroll inside it (Island._isDeliberate: not a modifier
// alone, not a hover-open alone).

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {Emitter} from '../core/emitter.js';
import {Tooltip} from '../core/tooltip.js';
import {HubHeader} from './hubHeader.js';
import {PanicBar} from './panicBar.js';

const LAST_TAB_KEY = 'hub-last-tab';

// Room kept on each side of the panic bar (logical px).
const PANIC_GAP = 8;

// Places the panic bar (the layer's one child) on the header row: centred
// on the island, or, where that would bring it closer than PANIC_GAP to
// the header's buttons, moved left until it is not, but never closer than
// PANIC_GAP to the tab column (Hub.minWidth makes room for both). Mirrored
// right to left.
const PanicLayout = GObject.registerClass(
class PanicLayout extends Clutter.BinLayout {
    /** @param {Function} span → [left, right]: px kept free at each side */
    _init(span) {
        super._init();
        this._span = span;
    }

    vfunc_allocate(container, box) {
        const bar = container.get_first_child();
        if (!bar)
            return;
        const [, width] = bar.get_preferred_width(-1);
        const [, height] = bar.get_preferred_height(width);
        let [start, end] = this._span();
        if (container.get_text_direction() === Clutter.TextDirection.RTL)
            [start, end] = [end, start];
        const room = box.get_width();
        const x = Math.round(Math.max(start, Math.min((room - width) / 2, room - end - width)));
        bar.allocate(new Clutter.ActorBox({x1: x, y1: 0, x2: x + width, y2: height}));
    }
});

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
     * @param {?Function} actions.openCalendar opens GNOME's calendar and
     *   notification menu; null when this Shell has none (no date pill)
     */
    constructor(ctx, features, {openSettings, openCalendar}) {
        super();
        this._ctx = ctx;
        this._settings = ctx.settings;
        this._features = features;
        this._entries = new Map(); // id -> {feature, button, dot, view, service}
        this._activeId = null;
        this._shown = false;
        this._unread = false;

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
     * The height the tab column needs (physical pixels), so the island
     * can grow to show every tab; 0 while there is no column.
     */
    get minHeight() {
        const visible = this._tabColumn.visible && this._tabColumn.get_stage();
        // Kept in step on every path, as for minWidth.
        this._reportedMinHeight = visible ? this._tabColumn.get_preferred_height(-1)[1] : 0;
        return this._reportedMinHeight;
    }

    /**
     * The width the island's content needs (physical pixels) so that the
     * panic bar fits between the tab column and the header's buttons with
     * PANIC_GAP on each side; 0 off stage or without panic buttons.
     */
    get minWidth() {
        // Whatever it returns is what was reported: the allocation watches
        // below compare against it, and a stale value made them report a
        // change on every frame of an animation.
        this._reportedMinWidth = this._measureMinWidth();
        return this._reportedMinWidth;
    }

    _measureMinWidth() {
        const panic = this._panicBar.actor;
        if (!this.actor.get_stage() || !panic.visible || panic.get_n_children() === 0)
            return 0;
        const [left, right] = this._panicSpan();
        return left + panic.get_preferred_width(-1)[1] + right;
    }

    // The room the panic bar keeps free (physical pixels): [from the left
    // edge, past the tab column; from the right edge, past the header's
    // buttons], PANIC_GAP included.
    _panicSpan() {
        const natural = actor => (actor.visible ? actor.get_preferred_width(-1)[1] : 0);
        const gap = PANIC_GAP * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const spacing = this._main.get_theme_node().get_length('spacing');
        const left = this._tabColumn.visible ? natural(this._tabColumn) + spacing : 0;
        return [left + gap, natural(this._header.end) + gap];
    }

    /**
     * Shows GNOME's unread dot on the header's date pill and on the tabs of
     * features that ask for it (unreadDot), whose names then say so.
     *
     * @param {boolean} unread whether GNOME's clock would show its dot
     */
    setUnread(unread) {
        this._unread = unread;
        this._header.setUnread(unread);
        for (const entry of this._entries.values())
            this._syncEntryUnread(entry);
    }

    /**
     * The user opened the island on purpose, or pressed, typed or scrolled
     * in it: the active view may take what it shows as seen.
     */
    noteUserInput() {
        if (this._shown)
            this._entries.get(this._activeId)?.view?.onUserInput?.();
    }

    /**
     * Whether `actor` is in the tabs' content area (a view), not the tab
     * column or the header row.
     *
     * @param {?Clutter.Actor} actor
     */
    contentContains(actor) {
        return !!actor && this._content.contains(actor);
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
        this._main = main;
        this._tabGrid = new Clutter.GridLayout({orientation: Clutter.Orientation.VERTICAL});
        this._tabColumn = new St.Widget({
            style_class: 'froonty-tab-column',
            layout_manager: this._tabGrid,
        });
        main.add_child(this._tabColumn);
        // Before they are first shown (styled), the tabs measure short.
        // Once laid out they are measured again, and the island follows if
        // that changed; their own height does not change while the island
        // animates, so this does not fire then.
        this._reportedMinHeight = 0;
        this._tabColumn.connect('notify::allocation', () => {
            const reported = this._reportedMinHeight;
            if (this._tabColumn.mapped && this.minHeight !== reported)
                this.emit('size-changed');
        });

        const right = new St.BoxLayout({
            style_class: 'froonty-hub-main',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        // The header row holds the date pill, the active feature's buttons
        // and ⚙️ on the right; the panic bar is centred over the whole
        // island in its own layer (see below).
        this._tooltip = new Tooltip();
        this._header = new HubHeader(this._tooltip, {
            clock: this._ctx.clock,
            openSettings,
            openCalendar,
        });
        this.settingsButton = this._header.settingsButton;
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

        // Panic bar: centred across the island (not just the column right of
        // the tabs), on the header row, as far as the header's buttons let
        // it (PanicLayout). Its layer is click-through; only the buttons
        // take input.
        this._panicBar = new PanicBar(this._settings, this._tooltip, {
            settings: this._settings,
            ctx: this._ctx,
            selectTab: id => {
                this.select(id);
                this.noteUserInput();
                return this._activeId === id;
            },
        });
        const panicLayer = new St.Widget({
            style_class: 'froonty-panic-layer',
            layout_manager: new PanicLayout(() => this._panicSpan()),
            x_expand: true,
            y_expand: true,
        });
        panicLayer.add_child(this._panicBar.actor);
        // The layer is laid out after the tab column and the header (later
        // siblings), but only when its own box changes: when they change
        // width (a tab's buttons, the pill's text), it places the bar
        // again in the same pass.
        // Only when a width changed: a relayout queued on every allocation
        // would never let the island settle.
        let widths = '';
        for (const actor of [this._tabColumn, this._header.end]) {
            actor.connect('notify::allocation', () => {
                const now = `${this._tabColumn.width}x${this._header.end.width}`;
                if (now === widths)
                    return;
                widths = now;
                panicLayer.queue_relayout();
            });
        }
        // The panic bar and the header's buttons change width with the
        // settings and the active tab; once laid out, the island follows
        // if the room they need changed (as for minHeight).
        this._reportedMinWidth = 0;
        for (const actor of [this._panicBar.actor, this._header.end]) {
            actor.connect('notify::allocation', () => {
                const reported = this._reportedMinWidth;
                if (actor.mapped && this.minWidth !== reported)
                    this.emit('size-changed');
            });
        }

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
        const {child, dot} = feature.unreadDot
            ? iconWithDot(iconParams) : {child: new St.Icon(iconParams), dot: null};
        const button = new St.Button({
            style_class: 'froonty-icon-button froonty-tab',
            accessible_name: feature.title,
            can_focus: true,
            track_hover: true,
            child,
        });
        button.connect('clicked', () => {
            this.select(feature.id);
            this.noteUserInput();
        });
        this._tooltip.attach(button, () => feature.title, 'right');

        const entry = {feature, button, dot, view: null, service: null};
        this._entries.set(feature.id, entry);
        this._syncEntryUnread(entry);
        return entry;
    }

    _syncEntryUnread(entry) {
        if (!entry.dot)
            return;
        entry.dot.visible = this._unread;
        const title = entry.feature.title;
        entry.button.accessible_name = this._unread
            ? _('%s, unread notifications').format(title) : title;
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

/**
 * An icon with GNOME's unread dot in its top-right corner (hidden), as on
 * the clock: the tabs of features with unreadDot.
 *
 * @param {object} iconParams St.Icon properties
 * @returns {{child: St.Widget, dot: St.Widget}}
 */
function iconWithDot(iconParams) {
    const dot = new St.Widget({
        style_class: 'froonty-unread-dot',
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.START,
        x_expand: true,
        y_expand: true,
        visible: false,
    });
    const child = new St.Widget({layout_manager: new Clutter.BinLayout()});
    child.add_child(new St.Icon(iconParams));
    child.add_child(dot);
    return {child, dot};
}
