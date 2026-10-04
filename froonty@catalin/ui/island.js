// SPDX-License-Identifier: GPL-3.0-or-later
// The island: a pill at the top center of the primary monitor that expands
// into the hub on click, keyboard shortcut or Ctrl+Alt+Tab.
//
// Actor tree:
//
//   strip   St.Widget, non-reactive, spans the monitor width.
//    │      Owns the modal grab. Does not take input, so the top bar below
//    │      it keeps working.
//    └ column  St.BoxLayout, vertical, as wide as the strip, non-reactive.
//       │      Centers the pill (also while its width animates).
//       ├ pill St.Button: background, click and Enter/Space activation.
//       │  └ content  BinLayout stacking the collapsed view and the hub,
//       │             and over them the resize grip's layer (resizeGrip.js).
//       └ bars  features' bars under the pill (pillBar), shown only
//              while the island is collapsed.

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as GrabHelper from 'resource:///org/gnome/shell/ui/grabHelper.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {FEATURES} from '../features/registry.js';
import {CalendarMenu} from '../shell/dateMenu.js';
import {crossfade, showOnly} from './animations.js';
import {addIslandChrome, removeIslandChrome} from './chrome.js';
import {CollapsedView} from './collapsedView.js';
import {ContextMenu} from './contextMenu.js';
import {IslandGeometry} from './geometry.js';
import {HoverOpen} from './hoverOpen.js';
import {Hub} from './hub.js';
import {ResizeGrip} from './resizeGrip.js';

const EXPAND_MODE = Clutter.AnimationMode.EASE_OUT_BACK;
const COLLAPSE_MODE = Clutter.AnimationMode.EASE_OUT_QUAD;
const RESIZE_MODE = Clutter.AnimationMode.EASE_OUT_QUAD;

// The pill's widest notice (a feature's peek), logical px.
const PEEK_MAX_WIDTH = 360;

const GEOMETRY_KEYS = [
    'collapsed-width',
    'collapsed-height',
    'expanded-width',
    'expanded-height',
    'corner-radius',
];

export class Island {
    /**
     * @param {Gio.Settings} settings
     * @param {ClockService} clock
     * @param {PanelClock} panelClock the concealed top bar clock the
     *   collapsed pill must cover
     * @param {object} actions
     * @param {Function} actions.openSettings (view) opens Froonty's settings
     *   window on 'settings' or 'all-notes'
     * @param {object} [actions.memory] the extension's in-memory object
     *   (survives screen locks), shared with features as ctx.memory
     * @param {?string} [actions.version] the extension's version-name
     */
    constructor(settings, clock, panelClock, {openSettings, memory = {}, version = null}) {
        this._settings = settings;
        this._clock = clock;
        this._panelClock = panelClock;
        this._openSettingsAction = openSettings;
        this._memory = memory;
        this._version = version;
        this._expanded = false;
        // Context menus features opened (ctx.contextMenu), while they exist.
        this._menus = new Set();
        this._accessory = null;
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        // Features' bars under the pill (pillBar), by feature id.
        this._pillBars = new Map();
        this._geometry = new IslandGeometry(settings, panelClock, this._themeContext);
        // GNOME's own calendar and notification menu: the clock the pill
        // covers would open it.
        this._calendarMenu = new CalendarMenu();
        // Features' cues on the collapsed pill (pillCue): id →
        // {feature, source, id}. The best one shows; a click on the pill
        // then opens its tab (_onPillClicked). Never expands by itself.
        this._cueSources = new Map();
        this._cueTab = null;
        // The open tab's size while its resize grip is dragged (logical
        // px, in place of its hubSizeKeys' values), else null.
        this._liveHubSize = null;

        this._buildActors();
        addIslandChrome(this._strip, this._pill, () => this.expand());

        // GrabHelper (also used by GNOME's app folder dialog and screenshot
        // UI) makes the expanded island behave like a menu: Escape or a click
        // outside the pill ungrabs, and keyboard focus is restored afterwards.
        // The grab owner must be an ancestor of the grabbed actor, and a
        // click counts as "outside" when it does not land in the grabbed
        // actor.
        this._grabHelper = new GrabHelper.GrabHelper(this._strip, {
            actionMode: Shell.ActionMode.POPUP,
        });

        this._hoverOpen = new HoverOpen(this._pill, settings, {
            isExpanded: () => this._expanded,
            expand: () => this.expand({pointer: true}),
        });

        this._connectSignals();
        this._syncAccessory();
        this._syncCueSources();
        this._updateContent();
        this._updateUnread();
        this._syncGeometry();
        for (const feature of FEATURES.filter(f => f.pillBar)) {
            this._pillBars.set(feature.id, feature.pillBar({
                settings: this._settings,
                column: this._column,
                canShow: () => !this._expanded && !this._pill.get_transition('height'),
            }));
        }
    }

    destroy() {
        // An open context menu holds a modal grab above the island's.
        for (const menu of [...this._menus])
            menu.destroy();
        // Ends a drag: its stage grab goes, the keys stay as they were.
        this._resizeGrip.destroy();

        // Release the modal grab first. Setting _expanded beforehand turns
        // the resulting onUngrab callback into a no-op instead of starting a
        // collapse animation on actors that are about to be destroyed.
        const wasGrabbed = this._grabHelper.grabbed;
        this._expanded = false;
        if (wasGrabbed)
            this._grabHelper.ungrab({actor: this._pill});

        for (const bar of this._pillBars.values())
            bar.destroy();
        this._pillBars.clear();
        this._clock.disconnectObject(this);
        this._panelClock.disconnectObject(this);
        for (const id of [...this._cueSources.keys()])
            this._releaseCueSource(id);
        // Also lets banners show again if the island held them back.
        this._calendarMenu.disconnectObject(this);
        this._calendarMenu.destroy();
        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.layoutManager.panelBox.disconnectObject(this);
        this._themeContext.disconnectObject(this);

        this._hoverOpen.destroy();
        removeIslandChrome(this._pill);

        // Before the hub: the accessory holds a feature's shared service.
        this._destroyAccessory();

        // The hub stops feature services and destroys their views.
        this._hub.disconnectObject(this);
        this._hub.destroy();
        this._hub = null;

        // Destroying the strip also destroys the pill; LayoutManager
        // untracks both chrome actors from their 'destroy' signals.
        this._strip.destroy();
        this._strip = null;
        this._pill = null;
        this._grabHelper = null;
    }

    get expanded() {
        return this._expanded;
    }

    /** @param {object} [options] {pointer: opened by a click or hover} */
    toggle(options = {}) {
        if (this._expanded)
            this.collapse();
        else
            this.expand(options);
    }

    /**
     * Opens the island (a click, a hover, the keyboard, the shortcut or
     * Ctrl+Alt+Tab).
     *
     * @param {object} [options]
     * @param {boolean} [options.pointer] opened by a click or hover: the
     *   tab of a pill accessory that asks for it (opensTab) opens
     */
    expand({pointer = false} = {}) {
        if (this._expanded)
            return;

        // One at a time, like GNOME's own top bar menus: GNOME's calendar
        // menu opens where the island expands, with a modal grab of its
        // own. (Its opening collapses the island; see _connectSignals.)
        this._calendarMenu.close();

        // Clutter only emits events on reactive actors, so the grab owner
        // must be reactive for GrabHelper to see Escape and outside clicks.
        // It is made reactive only while expanded; when collapsed the strip
        // must let clicks through to the top bar.
        this._strip.reactive = true;
        const grabbed = this._grabHelper.grab({
            actor: this._pill,
            focus: this._pill,
            onUngrab: () => this._setExpanded(false),
        });
        // Grabbing fails if another client holds an exclusive grab.
        if (!grabbed) {
            this._strip.reactive = false;
            return;
        }

        if (pointer && this._accessory?.opensTab)
            this._hub.select(this._accessory.tabId);

        this._setExpanded(true);
    }

    collapse() {
        if (!this._expanded)
            return;

        // ungrab() calls our onUngrab callback, which does the collapse.
        if (this._grabHelper.grabbed)
            this._grabHelper.ungrab({actor: this._pill});
        else
            this._setExpanded(false);
    }

    // Collapsing first releases the modal grab, so the settings window can
    // take keyboard focus when it appears (and saves an open note).
    _openSettings(view = 'settings') {
        this.collapse();
        this._openSettingsAction(view);
    }

    _trackMenu(menu) {
        this._menus.add(menu);
        menu.actor.connect('destroy', () => this._menus.delete(menu));
        return menu;
    }

    // The header's date pill: Froonty closes and GNOME's own menu opens,
    // as a click on the clock under the pill would open it. The menu opens
    // first, above the island, and takes the keyboard focus (its grab
    // holds banners back in turn); its 'opened' signal then collapses the
    // island, as for Super+V, and the island's grab goes from under the
    // menu's. Once the menu closes, the key focus is back where it was
    // before the island opened (Main.popModal shifts it to the menu's
    // grab). Should the menu not open (e.g. another extension hid the
    // clock), the island simply stays open.
    _openCalendar() {
        this._calendarMenu.open();
    }

    _buildActors() {
        this._strip = new St.Widget({
            name: 'froontyStrip',
            layout_manager: new Clutter.BinLayout(),
            reactive: false,
        });
        // The pill and, under it, the attention bar. As wide as the strip,
        // so the pill stays centered on the monitor; a hidden bar takes no
        // room.
        this._column = new St.BoxLayout({
            name: 'froontyColumn',
            style_class: 'froonty-column',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            reactive: false,
        });
        this._strip.add_child(this._column);

        this._pill = new St.Button({
            name: 'froontyPill',
            style_class: 'froonty-pill',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            can_focus: true,
            track_hover: true,
            clip_to_allocation: true,
        });
        this._column.add_child(this._pill);

        const content = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._pill.set_child(content);

        this._collapsedView = new CollapsedView();
        // Feature context: the only shared things features see.
        const ctx = {
            settings: this._settings,
            clock: this._clock,
            dataDir: Gio.File.new_for_path(
                GLib.build_filenamev([GLib.get_user_data_dir(), 'froonty'])),
            // Releases the grab, e.g. so a browser or Settings opened from
            // a tab can take the focus.
            collapse: () => this.collapse(),
            // Collapses the island, then opens the settings window on
            // 'settings' or 'all-notes'.
            openSettingsWindow: view => this._openSettings(view),
            // A GNOME popup menu below `source` (ui/contextMenu.js); it is
            // destroyed with the island at the latest.
            contextMenu: (source, params) => this._trackMenu(new ContextMenu(source, params)),
            // Plain data a feature keeps in memory (extension.js).
            memory: this._memory,
            // The extension's version-name.
            version: this._version,
            // Opens the settings window, on `page` (a tab's name) if given.
            openSettings: page => {
                if (page)
                    this._settings.set_string('prefs-page', page);
                this._openSettings('settings');
            },
            // Another tab's view (by feature id) if it was opened, else
            // null: a tab can hand something to another (text for the
            // open note).
            featureView: id => this._hub?.viewOf(id) ?? null,
        };
        this._ctx = ctx;
        this._hub = new Hub(ctx, FEATURES, {
            clockOffset: () => this._geometry.clockOffset(),
            openSettings: () => this._openSettings('settings'),
            openCalendar: this._calendarMenu.available
                ? () => this._openCalendar() : null,
        });
        content.add_child(this._collapsedView.actor);
        content.add_child(this._hub.actor);
        this._resizeGrip = new ResizeGrip(this._settings, this._pill, {
            sizeKeys: () => (this._expanded ? this._hub.activeFeature?.hubSizeKeys ?? null : null),
            bounds: () => this._resizeBounds(),
            preview: size => this._previewHubSize(size),
        });
        content.add_child(this._resizeGrip.actor);
        this._showViewImmediately();
    }

    _connectSignals() {
        this._pill.connect('clicked', () => this._onPillClicked());
        // Swipes on the collapsed pill go to its accessory.
        this._pill.connect('scroll-event', (_actor, event) =>
            !this._expanded && this._accessory?.handleScroll(event)
                ? Clutter.EVENT_STOP
                : Clutter.EVENT_PROPAGATE);
        // Connected before GrabHelper's own handler (made on each grab), so
        // the open tab can use Escape first (close something of its own)
        // before Escape closes the island.
        this._strip.connect('captured-event', (_actor, event) =>
            this._expanded && event.type() === Clutter.EventType.KEY_PRESS &&
            event.get_key_symbol() === Clutter.KEY_Escape && this._hub.handleEscape()
                ? Clutter.EVENT_STOP
                : Clutter.EVENT_PROPAGATE);
        // Over fullscreen windows the strip is unmapped: no accessory on the pill.
        this._strip.connect('notify::mapped', () => this._syncAccessoryShown());
        // Tab/arrow focus navigation is normally driven from the stage, which
        // the expanded island's modal grab keeps key events away from, so
        // forward them to the focus manager (as PanelMenu.Button does).
        this._pill.connect('key-press-event', (_actor, event) =>
            global.focus_manager.navigate_from_event(event)
                ? Clutter.EVENT_STOP
                : Clutter.EVENT_PROPAGATE);

        this._clock.connectObject('changed', () => this._updateContent(), this);
        this._panelClock.connectObject('cover-changed',
            () => this._onCoverChanged(), this);
        // GNOME's calendar menu opening, by any means (the header's date
        // pill, Super+V), collapses the island, which releases its grab
        // under the menu's.
        this._calendarMenu.connectObject(
            'opened', () => this.collapse(),
            'unread-changed', () => this._updateUnread(),
            this);
        this._hub.connectObject('size-changed', () => this._onHubSizeChanged(), this);
        for (const feature of FEATURES.filter(f => f.pillCue && f.enabledKey)) {
            this._settings.connectObject(`changed::${feature.enabledKey}`,
                () => this._syncCueSources(), this);
        }

        for (const key of GEOMETRY_KEYS) {
            this._settings.connectObject(`changed::${key}`,
                () => this._syncGeometry(), this);
        }
        // Feature sizes set in Settings resize the open island like a tab
        // switch does (a no-op unless that feature is the one shown).
        for (const {hubSizeKeys} of FEATURES) {
            for (const key of Object.values(hubSizeKeys ?? {})) {
                this._settings.connectObject(`changed::${key}`,
                    () => this._onHubSizeChanged(), this);
            }
        }
        // A feature's pill accessory comes and goes with its settings.
        const accessoryKeys = new Set(FEATURES.flatMap(f => f.pillAccessoryKeys ?? []));
        for (const key of accessoryKeys) {
            this._settings.connectObject(`changed::${key}`,
                () => this._syncAccessory(), this);
        }

        Main.layoutManager.connectObject(
            'monitors-changed', () => this._syncGeometry(),
            // Emitted e.g. when the end-session dialog opens; GNOME's
            // popup menus close on it too.
            'system-modal-opened', () => this.collapse(),
            this);
        Main.layoutManager.panelBox.connectObject('notify::height',
            () => this._syncGeometry(), this);
        this._themeContext.connectObject('notify::scale-factor',
            () => this._syncGeometry(), this);
    }

    _updateContent() {
        this._collapsedView.update(this._clock.snapshot());
        this._pill.accessible_name = this._collapsedView.accessibleText;
        // Minute texts ("25m") follow the clock too.
        this._updateCue();
    }

    // A click on the collapsed pill opens the tab its cue is about; hover
    // and the shortcut keep the last tab.
    // A cue's tab wins over the accessory's (expand({pointer})).
    _onPillClicked() {
        const cueTab = !this._expanded ? this._cueTab : null;
        if (cueTab)
            this._hub.select(cueTab);
        this.toggle({pointer: !cueTab});
    }

    // Holds each enabled feature's cue source (and lets go of disabled ones).
    _syncCueSources() {
        for (const feature of FEATURES.filter(f => f.pillCue)) {
            const want = !feature.enabledKey || this._settings.get_boolean(feature.enabledKey);
            if (want && !this._cueSources.has(feature.id)) {
                const source = feature.pillCue.acquire(this._settings);
                const id = source.connect('changed', () => this._updateCue());
                this._cueSources.set(feature.id, {feature, source, id});
            } else if (!want && this._cueSources.has(feature.id)) {
                this._releaseCueSource(feature.id);
            }
        }
        this._updateCue();
    }

    _releaseCueSource(featureId) {
        const {feature, source, id} = this._cueSources.get(featureId);
        source.disconnect(id);
        feature.pillCue.release();
        this._cueSources.delete(featureId);
    }

    // The most urgent cue on the collapsed pill; the pill widens only when
    // it no longer fits. Eased only when the cue itself changed, never
    // while the pill is resizing anyway, and re-synced afterwards (the
    // clock it covers may have changed meanwhile; see _onCoverChanged).
    _updateCue() {
        if (!this._collapsedView)
            return;
        const now = Date.now();
        let best = null;
        for (const {source} of this._cueSources.values()) {
            const cue = source.current(now);
            if (cue && (!best || cue.rank > best.rank))
                best = cue;
        }
        const resized = this._collapsedView.setCue(best);
        this._cueTab = best?.tab ?? null;
        this._pill.accessible_name = this._collapsedView.accessibleText;
        if (!resized || this._expanded ||
            this._pill.get_transition('width') || this._pill.get_transition('height'))
            return;
        const {width, height} = this._targetSize(false);
        if (width !== this._pill.width || height !== this._pill.height) {
            this._pill.ease({
                width,
                height,
                duration: this._settings.get_int('animation-duration'),
                mode: RESIZE_MODE,
                onComplete: () => {
                    if (!this._expanded)
                        this._syncGeometry();
                },
            });
        }
    }

    // GNOME's clock, under the pill, would show its unread-notifications
    // dot: the pill shows one instead, and so does the hub header's date
    // pill.
    _updateUnread() {
        const unread = this._calendarMenu.hasUnread;
        this._collapsedView.setUnread(unread);
        this._hub.setUnread(unread);
        this._pill.accessible_name = this._collapsedView.accessibleText;
    }

    _targetSize(expanded) {
        if (!expanded)
            return this._collapsedSize();
        const size = this._geometry.expandedSize(this._hub.activeFeature,
            this._hub.activeExtraHeight, this._liveHubSize);
        const needs = this._hubNeeds();
        return {width: Math.max(size.width, needs.width), height: Math.max(size.height, needs.height)};
    }

    // The expanded island's smallest size (stage px): tall enough for every
    // feature tab and ⚙️, in one column; wide enough that the centred date
    // pill and the panic buttons beside it clear the side column and the
    // feature's header buttons (Hub.minWidth). (Off stage there is
    // no theme node, and nothing to show yet.)
    _hubNeeds() {
        if (!this._pill.get_stage())
            return {width: 0, height: 0};
        const node = this._pill.get_theme_node();
        return {
            width: this._hub.minWidth + node.get_horizontal_padding() +
                node.get_border_width(St.Side.LEFT) + node.get_border_width(St.Side.RIGHT),
            height: this._hub.minHeight + node.get_vertical_padding() +
                node.get_border_width(St.Side.TOP) + node.get_border_width(St.Side.BOTTOM),
        };
    }

    // What the resize grip may give the open tab's keys, in logical px:
    // at least what the hub needs, at most the room the primary monitor's
    // work area has around the island (centred on the monitor, from its
    // top edge down). A view's extra height (view.extraHeight) comes on
    // top of its height key.
    _resizeBounds() {
        const scale = this._themeContext.scale_factor;
        const needs = this._hubNeeds();
        const extra = this._hub.activeExtraHeight;
        const layout = Main.layoutManager;
        const monitor = layout.primaryMonitor;
        if (!monitor) {
            return {
                width: {need: Math.ceil(needs.width / scale)},
                height: {need: Math.ceil(needs.height / scale) - extra},
            };
        }
        const area = layout.getWorkAreaForMonitor(layout.primaryIndex);
        const centerX = monitor.x + monitor.width / 2;
        const top = monitor.y + this._geometry.topOffset(monitor);
        return {
            width: {
                need: Math.ceil(needs.width / scale),
                room: Math.floor(2 * Math.min(centerX - area.x, area.x + area.width - centerX) / scale),
            },
            height: {
                need: Math.ceil(needs.height / scale) - extra,
                room: Math.floor((area.y + area.height - top) / scale) - extra,
            },
        };
    }

    // The resize grip, while dragged: the island takes `size` (the open
    // tab's keys, logical px) at once, without animation; null goes back
    // to the keys.
    _previewHubSize(size) {
        this._liveHubSize = size;
        if (!this._expanded)
            return;
        this._pill.remove_transition('width');
        this._pill.remove_transition('height');
        const {width, height} = this._targetSize(true);
        this._pill.set_size(width, height);
    }

    // While the pill shows an accessory (or a notice), it is as wide as its
    // content needs (a notice at most PEEK_MAX_WIDTH); otherwise 0, the
    // usual size.
    _collapsedContentWidth() {
        const accessory = this._accessory;
        const shown = accessory && (accessory.showing || accessory.peekText);
        if ((!shown && !this._collapsedView.hasCue) || !this._pill.get_stage())
            return 0;
        const node = this._pill.get_theme_node();
        const [, natural] = this._collapsedView.actor.get_preferred_width(-1);
        const width = natural + node.get_horizontal_padding() +
            node.get_border_width(St.Side.LEFT) + node.get_border_width(St.Side.RIGHT);
        const scale = this._themeContext.scale_factor;
        return accessory?.peekText ? Math.min(width, PEEK_MAX_WIDTH * scale) : width;
    }

    // The accessory of the first feature that wants one (wings around the
    // time on the collapsed pill), rebuilt when its settings change.
    _syncAccessory() {
        this._destroyAccessory();
        const feature = FEATURES.find(f => f.createPillAccessory && f.wantsPillAccessory?.(this._settings));
        if (feature) {
            this._accessory = feature.createPillAccessory(this._ctx, {pill: this._pill});
            this._accessoryId = this._accessory.connect('changed', () => this._onAccessoryChanged());
            this._collapsedView.setAccessory(this._accessory);
            this._syncAccessoryShown();
        }
        this._onAccessoryChanged();
    }

    _destroyAccessory() {
        if (!this._accessory)
            return;
        this._accessory.disconnect(this._accessoryId);
        this._collapsedView.setAccessory(null);
        this._accessory.destroy();
        this._accessory = null;
    }

    _syncAccessoryShown() {
        this._accessory?.setPillShown(!this._expanded && this._strip.mapped);
    }

    // Music came or went on the collapsed pill: its width follows (while
    // expanded, the collapse picks it up).
    _onAccessoryChanged() {
        this._collapsedView.setPeek(this._accessory?.peekText ?? null);
        this._pill.accessible_name = this._collapsedView.accessibleText;
        if (this._expanded || !this._pill.get_stage() ||
            this._pill.get_transition('height'))
            return;
        const {width} = this._targetSize(false);
        this._pill.ease({
            width,
            duration: this._settings.get_int('animation-duration'),
            mode: RESIZE_MODE,
        });
    }

    // At least the geometry's (covering the clock), and wide enough for
    // the collapsed row with an accessory or a cue in it.
    _collapsedSize() {
        return this._geometry.collapsedSize(this._collapsedContentWidth());
    }

    // Places the strip on the primary monitor and snaps the pill to the
    // size of its current state, cancelling any running animation (a
    // collapse cut short this way never completes, so the bars under the
    // pill, hidden while its height animates, are synced here).
    _syncGeometry() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        this._strip.set_position(monitor.x, monitor.y + this._geometry.topOffset(monitor));
        this._strip.width = monitor.width;

        const radius = this._settings.get_int('corner-radius');
        // St clamps an oversized radius to half the shorter side, so the
        // collapsed pill stays fully rounded and the radius grows smoothly
        // while the island expands.
        this._pill.style = `border-radius: ${radius}px;`;

        this._pill.remove_all_transitions();
        const {width, height} = this._targetSize(this._expanded);
        this._pill.set_size(width, height);
        this._showViewImmediately();
        this._syncPillBars();
        this._resizeGrip.sync();
    }

    // The clock button's size and position change with its content (e.g.
    // the unread-notifications dot appearing) and with the panel layout.
    // Only the collapsed geometry depends on it. A running animation is
    // left alone; _animate() re-syncs when a collapse completes.
    _onCoverChanged() {
        if (this._expanded ||
            this._pill.get_transition('width') ||
            this._pill.get_transition('height'))
            return;

        this._syncGeometry();
    }

    // Switching tabs resizes the expanded island to the new feature's size.
    _onHubSizeChanged() {
        // Another tab: the grip shows only for one whose size can be set.
        this._resizeGrip.sync();
        if (!this._expanded)
            return;

        const {width, height} = this._targetSize(true);
        this._pill.ease({
            width,
            height,
            duration: this._settings.get_int('animation-duration'),
            mode: RESIZE_MODE,
        });
    }

    _setExpanded(expanded) {
        if (this._expanded === expanded)
            return;

        this._expanded = expanded;
        if (!expanded)
            this._strip.reactive = false;

        // St does not navigate focus into a widget that is itself focusable,
        // so while expanded the pill stops being focusable and Tab reaches
        // the controls inside it. It keeps key focus, so Enter/Space still
        // collapse it.
        this._pill.can_focus = !expanded;

        if (expanded) {
            this._pill.add_style_class_name('froonty-pill-expanded');
            this._pill.add_accessible_state(Atk.StateType.EXPANDED);
        } else {
            this._pill.remove_style_class_name('froonty-pill-expanded');
            this._pill.remove_accessible_state(Atk.StateType.EXPANDED);
        }

        if (expanded) {
            this._hoverOpen.cancel();
            // Out of the way at once, before the pill grows over them.
            for (const bar of this._pillBars.values())
                bar.hide();
        }
        this._syncAccessoryShown();
        // The expanded island covers the place where GNOME shows banners.
        this._calendarMenu.holdBanners(expanded);
        this._hub.setShown(expanded);
        this._resizeGrip.sync(expanded ? this._settings.get_int('animation-duration') : 0);
        this._animate();
    }

    _animate() {
        const duration = this._settings.get_int('animation-duration');
        const {width, height} = this._targetSize(this._expanded);

        this._pill.ease({
            width,
            height,
            duration,
            mode: this._expanded ? EXPAND_MODE : COLLAPSE_MODE,
            // However a collapse ends: done, or cut short by _syncGeometry()
            // (which then also syncs the bars under the pill).
            onStopped: isFinished => {
                if (this._expanded)
                    return;
                // The clock may have changed size meanwhile; see
                // _onCoverChanged. This also brings the bar back.
                if (isFinished)
                    this._syncGeometry();
                for (const bar of this._pillBars.values())
                    bar.collapsed?.();
            },
        });

        crossfade(...this._views(), duration);
    }

    _showViewImmediately() {
        showOnly(...this._views());
    }

    _syncPillBars() {
        for (const bar of this._pillBars.values())
            bar.sync();
    }

    /** @returns {Clutter.Actor[]} [view for current state, other view] */
    _views() {
        const collapsed = this._collapsedView.actor;
        const hub = this._hub.actor;
        return this._expanded ? [hub, collapsed] : [collapsed, hub];
    }
}
