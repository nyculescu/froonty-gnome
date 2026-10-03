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
//       │  └ content  BinLayout stacking the collapsed view and the hub.
//       └ bar  the Claude attention bar (ui/attentionBar.js), only while
//              that feature is on; shown only while the island is
//              collapsed and something waits.

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as GrabHelper from 'resource:///org/gnome/shell/ui/grabHelper.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AttentionService, removeStateDir} from '../features/claude/attentionService.js';
import {FEATURES} from '../features/registry.js';
import {ClaudeDesktop, screenLocked} from '../shell/claudeAttention.js';
import {CalendarMenu} from '../shell/dateMenu.js';
import {gnomeNotifications} from '../shell/messageTray.js';
import {crossfade, showOnly} from './animations.js';
import {AttentionBar} from './attentionBar.js';
import {addIslandChrome, removeIslandChrome} from './chrome.js';
import {CollapsedView} from './collapsedView.js';
import {ContextMenu} from './contextMenu.js';
import {IslandGeometry} from './geometry.js';
import {HoverOpen} from './hoverOpen.js';
import {Hub} from './hub.js';

const EXPAND_MODE = Clutter.AnimationMode.EASE_OUT_BACK;
const COLLAPSE_MODE = Clutter.AnimationMode.EASE_OUT_QUAD;
const RESIZE_MODE = Clutter.AnimationMode.EASE_OUT_QUAD;

// The pill's widest notice (a new song's title), logical px.
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
        // Whether the user is at the open island: opened on purpose, or
        // since a press, or a key or scroll that counts (_isDeliberate).
        this._engaged = false;
        // Context menus features opened (ctx.contextMenu), while they exist.
        this._menus = new Set();
        this._accessory = null;
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        // "When Claude needs you" (docs/features/claude-attention.md).
        this._attention = null;
        this._geometry = new IslandGeometry(settings, panelClock, this._themeContext);
        // GNOME's own calendar and notification menu: the clock the pill
        // covers would open it.
        this._calendarMenu = new CalendarMenu();

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

        // Opening by hover alone is not a deliberate act (see expand()).
        this._hoverOpen = new HoverOpen(this._pill, settings, {
            isExpanded: () => this._expanded,
            expand: () => this.expand({byHover: true, pointer: true}),
        });

        this._connectSignals();
        this._syncAccessory();
        this._updateContent();
        this._updateUnread();
        this._syncGeometry();
        this._syncAttentionEnabled();
    }

    destroy() {
        // An open context menu holds a modal grab above the island's.
        for (const menu of [...this._menus])
            menu.destroy();

        // Release the modal grab first. Setting _expanded beforehand turns
        // the resulting onUngrab callback into a no-op instead of starting a
        // collapse animation on actors that are about to be destroyed.
        const wasGrabbed = this._grabHelper.grabbed;
        this._expanded = false;
        if (wasGrabbed)
            this._grabHelper.ungrab({actor: this._pill});

        // At a screen lock its files stay, so what waits survives it.
        // Otherwise (Froonty or the island turned off) the folder goes, and
        // with it Claude Code's hooks stop recording.
        this._stopAttention({removeState: !screenLocked()});
        this._clock.disconnectObject(this);
        this._panelClock.disconnectObject(this);
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
     * Opens the island. A click, the keyboard, the shortcut or Ctrl+Alt+Tab
     * is a deliberate act, and the hub hears of it (Hub.noteUserInput: the
     * Notifications tab takes what it lists as seen); opening by hover is
     * not, until the user clicks in the island, moves the key focus into
     * it and types, or scrolls its tab's content (_isDeliberate).
     *
     * @param {object} [options]
     * @param {boolean} [options.byHover] opened by resting on the pill
     * @param {boolean} [options.pointer] opened by a click or hover: while
     *   the pill shows music, the Media tab opens (media-pill-opens-tab)
     */
    expand({byHover = false, pointer = false} = {}) {
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

        const accessory = this._accessory;
        if (pointer && accessory && (accessory.showing || accessory.peekText) &&
            this._settings.get_boolean('media-pill-opens-tab'))
            this._hub.select(accessory.tabId);

        this._setExpanded(true, {byHover});
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

    // GNOME's menu opens first, above the island, and takes the keyboard
    // focus; its 'opened' signal then collapses the island, as for Super+V.
    // Should it not open (e.g. another extension hid the clock), the
    // island simply stays open.
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
        // Feature context (docs/local/ideas.md): the only shared things features see.
        const ctx = {
            settings: this._settings,
            clock: this._clock,
            dataDir: Gio.File.new_for_path(
                GLib.build_filenamev([GLib.get_user_data_dir(), 'froonty'])),
            // GNOME's own notifications (null without a message tray).
            notifications: gnomeNotifications(),
            // Releases the grab, e.g. so a browser or Settings opened from
            // a tab can take the focus.
            collapse: () => this.collapse(),
            // Collapses the island, then opens the settings window on
            // 'settings' or 'all-notes'.
            openSettingsWindow: view => this._openSettings(view),
            // A GNOME popup menu below `source` (ui/contextMenu.js); it is
            // destroyed with the island at the latest.
            contextMenu: (source, params) => this._trackMenu(new ContextMenu(source, params)),
            // Plain data kept across screen locks (Media's chosen player).
            memory: this._memory,
            // The extension's version-name (Media's User-Agent).
            version: this._version,
            // Opens the settings window, on `page` (a tab's name) if given.
            openSettings: page => {
                if (page)
                    this._settings.set_string('prefs-page', page);
                this._openSettings('settings');
            },
        };
        this._ctx = ctx;
        this._hub = new Hub(ctx, FEATURES, {
            openSettings: () => this._openSettings('settings'),
            openCalendar: this._calendarMenu.available
                ? () => this._openCalendar() : null,
        });
        content.add_child(this._collapsedView.actor);
        content.add_child(this._hub.actor);
        this._showViewImmediately();
    }

    _connectSignals() {
        this._pill.connect('clicked', () => this.toggle({pointer: true}));
        // A press, key or scroll inside the open island may be deliberate
        // input (_isDeliberate; Hub.noteUserInput). Escape never gets here:
        // GrabHelper's own handler on the strip, which captures first, stops
        // it; clicks outside the pill target the strip. The handler dies
        // with the pill.
        this._pill.connect('captured-event', (_actor, event) => {
            if (this._expanded && this._isDeliberate(event))
                this._hub?.noteUserInput();
            return Clutter.EVENT_PROPAGATE;
        });
        // Swipes on the collapsed pill (Media: change song).
        this._pill.connect('scroll-event', (_actor, event) =>
            !this._expanded && this._accessory?.handleScroll(event)
                ? Clutter.EVENT_STOP
                : Clutter.EVENT_PROPAGATE);
        // Connected before GrabHelper's own handler (made on each grab), so
        // the open tab can use Escape first (close its source list or
        // lyrics) before Escape closes the island.
        this._strip.connect('captured-event', (_actor, event) =>
            this._expanded && event.type() === Clutter.EventType.KEY_PRESS &&
            event.get_key_symbol() === Clutter.KEY_Escape && this._hub.handleEscape()
                ? Clutter.EVENT_STOP
                : Clutter.EVENT_PROPAGATE);
        // Over fullscreen windows the strip is unmapped: no music on the pill.
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
        // GNOME's calendar menu opening, by any means (📅, Super+V),
        // collapses the island, which releases its grab under the menu's.
        this._calendarMenu.connectObject(
            'opened', () => this.collapse(),
            'unread-changed', () => this._updateUnread(),
            this);
        this._hub.connectObject('size-changed', () => this._onHubSizeChanged(), this);

        for (const key of GEOMETRY_KEYS) {
            this._settings.connectObject(`changed::${key}`,
                () => this._syncGeometry(), this);
        }
        this._settings.connectObject('changed::claude-attention-enabled',
            () => this._syncAttentionEnabled(), this);
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
    }

    // GNOME's clock, under the pill, would show its unread-notifications
    // dot: the pill shows one instead, and so does 📅 in the hub.
    _updateUnread() {
        const unread = this._calendarMenu.hasUnread;
        this._collapsedView.setUnread(unread);
        this._hub.setUnread(unread);
        this._pill.accessible_name = this._collapsedView.accessibleText;
    }

    _targetSize(expanded) {
        if (!expanded)
            return this._geometry.collapsedSize(this._collapsedContentWidth());
        const size = this._geometry.expandedSize(this._hub.activeFeature, this._hub.activeExtraHeight);
        // Tall enough for every feature tab, in one column. (Off stage
        // there is no theme node, and nothing to show yet.)
        if (!this._pill.get_stage())
            return size;
        const node = this._pill.get_theme_node();
        const tabs = this._hub.minHeight + node.get_vertical_padding() +
            node.get_border_width(St.Side.TOP) + node.get_border_width(St.Side.BOTTOM);
        // Wide enough that the centred panic bar clears the tab column and
        // the header's buttons.
        const header = this._hub.minWidth + node.get_horizontal_padding() +
            node.get_border_width(St.Side.LEFT) + node.get_border_width(St.Side.RIGHT);
        return {width: Math.max(size.width, header), height: Math.max(size.height, tabs)};
    }

    // While the pill shows music (or a notice), it is as wide as its
    // content needs (a notice at most PEEK_MAX_WIDTH); otherwise 0, the
    // usual size.
    _collapsedContentWidth() {
        const accessory = this._accessory;
        if (!accessory || !(accessory.showing || accessory.peekText) || !this._pill.get_stage())
            return 0;
        const node = this._pill.get_theme_node();
        const [, natural] = this._collapsedView.actor.get_preferred_width(-1);
        const width = natural + node.get_horizontal_padding() +
            node.get_border_width(St.Side.LEFT) + node.get_border_width(St.Side.RIGHT);
        const scale = this._themeContext.scale_factor;
        return accessory.peekText ? Math.min(width, PEEK_MAX_WIDTH * scale) : width;
    }

    // The accessory of the first feature that wants one (Media's music on
    // the collapsed pill), rebuilt when its settings change.
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

    // Places the strip on the primary monitor and snaps the pill to the
    // size of its current state, cancelling any running animation (a
    // collapse cut short this way never completes, so the attention bar,
    // hidden while the pill's height animates, is synced here).
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
        this._syncAttention();
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

    _setExpanded(expanded, {byHover = false} = {}) {
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
            // Out of the way at once, before the pill grows over its place.
            this._attention?.bar.hide();
        }
        this._engaged = expanded && !byHover;
        this._syncAccessoryShown();
        // The expanded island covers the place where GNOME shows banners.
        this._calendarMenu.holdBanners(expanded);
        this._hub.setShown(expanded);
        if (expanded && !byHover)
            this._hub.noteUserInput();
        this._animate();
    }

    /**
     * Whether `event`, in the open island, shows the user is at it.
     *
     * - A press or a touch: always.
     * - A key: never a modifier alone, nor the keyboard's auto-repeat.
     *   After a hover-open the key focus is still on the pill and the user
     *   may still be typing into their window: a key counts only once the
     *   focus is inside the island (Tab moves it there; Tab itself does
     *   not count, nor does Space or Enter, which close it).
     * - A scroll: after a hover-open, only over the tab's own content (the
     *   pointer rests where the pill was, over the island's header).
     *
     * Once one counts, so do the others, as after a deliberate open.
     */
    _isDeliberate(event) {
        switch (event.type()) {
        case Clutter.EventType.BUTTON_PRESS:
        case Clutter.EventType.TOUCH_BEGIN:
            break;
        case Clutter.EventType.KEY_PRESS: {
            if (event.get_flags() & Clutter.EventFlags.FLAG_REPEATED ||
                isModifierKey(event.get_key_symbol()))
                return false;
            const focus = global.stage.get_key_focus();
            if (!this._engaged &&
                (!focus || focus === this._pill || !this._pill.contains(focus)))
                return false;
            break;
        }
        case Clutter.EventType.SCROLL:
            if (!this._engaged &&
                !this._hub.contentContains(global.stage.get_event_actor(event)))
                return false;
            break;
        default:
            return false;
        }
        this._engaged = true;
        return true;
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
            // (which then also syncs the attention bar).
            onStopped: isFinished => {
                if (this._expanded)
                    return;
                // The clock may have changed size meanwhile; see
                // _onCoverChanged. This also brings the bar back.
                if (isFinished)
                    this._syncGeometry();
                // A crashed Claude Code leaves its file behind.
                this._attention?.service.revalidate();
            },
        });

        crossfade(...this._views(), duration);
    }

    _showViewImmediately() {
        showOnly(...this._views());
    }

    // ---------------------------------------------------------- attention bar

    _syncAttentionEnabled() {
        if (this._settings.get_boolean('claude-attention-enabled')) {
            this._startAttention();
        } else if (this._attention) {
            this._stopAttention({removeState: true});
        } else {
            // Off already, e.g. since a previous session: a folder left
            // behind goes, so the hooks record nothing.
            removeStateDir();
        }
    }

    _startAttention() {
        if (this._attention)
            return;
        const desktop = new ClaudeDesktop();
        const service = new AttentionService({
            settings: this._settings,
            desktop,
            // GNOME's notifications, through the Notifications tab's
            // store (shell/messageTray.js), filtered to the Claude app and
            // web browsers.
            notifications: gnomeNotifications(),
        });
        const bar = new AttentionBar({
            onActivate: id => service.activate(id),
            onDismiss: id => service.dismiss(id),
            animationTime: () => this._settings.get_int('animation-duration'),
        });
        this._column.add_child(bar.actor);
        // Do Not Disturb hides the bar, as it hides banners.
        const notifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._attention = {desktop, service, bar, notifications};

        // A plain GJS emitter (core/emitter.js): no connectObject().
        this._attention.serviceId = service.connect('changed',
            () => this._syncAttention({animate: true}));
        desktop.connectObject('busy-changed', () => this._syncAttention(), this);
        notifications.connectObject('changed::show-banners', () => this._syncAttention(), this);
        service.start();
        this._syncAttention();
    }

    _stopAttention({removeState}) {
        const attention = this._attention;
        if (!attention)
            return;
        this._attention = null;
        attention.service.disconnect(attention.serviceId);
        attention.service.stop();
        if (removeState)
            attention.service.removeState();
        attention.desktop.disconnectObject(this);
        attention.desktop.destroy();
        attention.notifications.disconnectObject(this);
        attention.bar.destroy();
    }

    // Shown while something waits, the island is collapsed (and done
    // collapsing), no banner or overview is on screen and Do Not Disturb
    // is off. Fullscreen hides the whole strip.
    _syncAttention({animate = false} = {}) {
        const attention = this._attention;
        if (!attention)
            return;
        const [first, ...rest] = attention.service.entries;
        const show = first !== undefined && !this._expanded &&
            !this._pill.get_transition('height') && !attention.desktop.busy &&
            attention.notifications.get_boolean('show-banners');
        if (show)
            attention.bar.show(first, rest.length);
        else
            attention.bar.hide({animate});
    }

    /** @returns {Clutter.Actor[]} [view for current state, other view] */
    _views() {
        const collapsed = this._collapsedView.actor;
        const hub = this._hub.actor;
        return this._expanded ? [hub, collapsed] : [collapsed, hub];
    }
}

/**
 * Shift, Control, Caps Lock, Meta, Alt, Super and Hyper; the ISO level
 * and group keys (AltGr is ISO_Level3_Shift); Mode_switch and Num_Lock.
 * Pressed alone, they are not input to the island.
 *
 * @param {number} keyval
 * @returns {boolean}
 */
function isModifierKey(keyval) {
    return (keyval >= Clutter.KEY_Shift_L && keyval <= Clutter.KEY_Hyper_R) ||
        (keyval >= Clutter.KEY_ISO_Lock && keyval <= Clutter.KEY_ISO_Level5_Lock) ||
        keyval === Clutter.KEY_Mode_switch || keyval === Clutter.KEY_Num_Lock;
}
