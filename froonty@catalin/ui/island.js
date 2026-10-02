// SPDX-License-Identifier: GPL-3.0-or-later
// The island: a pill at the top center of the primary monitor that expands
// into the hub on click, keyboard shortcut or Ctrl+Alt+Tab.
//
// Actor tree:
//
//   strip   St.Widget, non-reactive, spans the monitor width.
//    │      Centers the pill (also while its width animates) and owns the
//    │      modal grab. Does not take input, so the top bar below it keeps
//    │      working.
//    └ pill St.Button: background, click and Enter/Space activation.
//       └ content  BinLayout stacking the collapsed view and the hub.

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
import {IslandGeometry} from './geometry.js';
import {HoverOpen} from './hoverOpen.js';
import {Hub} from './hub.js';

const EXPAND_MODE = Clutter.AnimationMode.EASE_OUT_BACK;
const COLLAPSE_MODE = Clutter.AnimationMode.EASE_OUT_QUAD;
const RESIZE_MODE = Clutter.AnimationMode.EASE_OUT_QUAD;

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
     * @param {Function} actions.openSettings opens Froonty's settings window
     */
    constructor(settings, clock, panelClock, {openSettings}) {
        this._settings = settings;
        this._clock = clock;
        this._panelClock = panelClock;
        this._openSettingsAction = openSettings;
        this._expanded = false;
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
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

        this._hoverOpen = new HoverOpen(this._pill, settings, {
            isExpanded: () => this._expanded,
            expand: () => this.expand(),
        });

        this._connectSignals();
        this._updateContent();
        this._updateUnread();
        this._syncGeometry();
    }

    destroy() {
        // Release the modal grab first. Setting _expanded beforehand turns
        // the resulting onUngrab callback into a no-op instead of starting a
        // collapse animation on actors that are about to be destroyed.
        const wasGrabbed = this._grabHelper.grabbed;
        this._expanded = false;
        if (wasGrabbed)
            this._grabHelper.ungrab({actor: this._pill});

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

    toggle() {
        if (this._expanded)
            this.collapse();
        else
            this.expand();
    }

    expand() {
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
    // take keyboard focus when it appears.
    _openSettings() {
        this.collapse();
        this._openSettingsAction();
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

        this._pill = new St.Button({
            style_class: 'froonty-pill',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
            can_focus: true,
            track_hover: true,
            clip_to_allocation: true,
        });
        this._strip.add_child(this._pill);

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
        };
        this._hub = new Hub(ctx, FEATURES, {
            openSettings: () => this._openSettings(),
            openCalendar: this._calendarMenu.available
                ? () => this._openCalendar() : null,
        });
        content.add_child(this._collapsedView.actor);
        content.add_child(this._hub.actor);
        this._showViewImmediately();
    }

    _connectSignals() {
        this._pill.connect('clicked', () => this.toggle());
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
        // Feature sizes set in Settings resize the open island like a tab
        // switch does (a no-op unless that feature is the one shown).
        for (const {hubSizeKeys} of FEATURES) {
            for (const key of Object.values(hubSizeKeys ?? {})) {
                this._settings.connectObject(`changed::${key}`,
                    () => this._onHubSizeChanged(), this);
            }
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
            return this._geometry.collapsedSize();
        const size = this._geometry.expandedSize(this._hub.activeFeature);
        // Tall enough for every feature tab, in one column. (Off stage
        // there is no theme node, and nothing to show yet.)
        if (!this._pill.get_stage())
            return size;
        const node = this._pill.get_theme_node();
        const tabs = this._hub.minHeight + node.get_vertical_padding() +
            node.get_border_width(St.Side.TOP) + node.get_border_width(St.Side.BOTTOM);
        return {width: size.width, height: Math.max(size.height, tabs)};
    }

    // Places the strip on the primary monitor and snaps the pill to the
    // size of its current state, cancelling any running animation.
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

        if (expanded)
            this._hoverOpen.cancel();
        // The expanded island covers the place where GNOME shows banners.
        this._calendarMenu.holdBanners(expanded);
        this._hub.setShown(expanded);
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
            // The clock may have changed size meanwhile; see _onCoverChanged.
            onComplete: () => {
                if (!this._expanded)
                    this._syncGeometry();
            },
        });

        crossfade(...this._views(), duration);
    }

    _showViewImmediately() {
        showOnly(...this._views());
    }

    /** @returns {Clutter.Actor[]} [view for current state, other view] */
    _views() {
        const collapsed = this._collapsedView.actor;
        const hub = this._hub.actor;
        return this._expanded ? [hub, collapsed] : [collapsed, hub];
    }
}
