// SPDX-License-Identifier: GPL-3.0-or-later
// The island: a pill at the top center of the primary monitor that expands
// into a small hub on click, keyboard shortcut or Ctrl+Alt+Tab.
//
// Actor tree:
//
//   strip   St.Widget, non-reactive, spans the monitor width.
//    │      Centers the pill (also while its width animates) and owns the
//    │      modal grab. Does not take input, so the top bar below it keeps
//    │      working.
//    └ pill St.Button: background, click and Enter/Space activation.
//       └ content  BinLayout stacking the collapsed and expanded views.

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as GrabHelper from 'resource:///org/gnome/shell/ui/grabHelper.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {CollapsedView} from './collapsedView.js';
import {ExpandedView} from './expandedView.js';

const EXPAND_MODE = Clutter.AnimationMode.EASE_OUT_BACK;
const COLLAPSE_MODE = Clutter.AnimationMode.EASE_OUT_QUAD;
const FADE_MODE = Clutter.AnimationMode.EASE_OUT_QUAD;

// Content cross-fade, as fractions of the resize duration: the outgoing view
// fades out during the first half, the incoming one fades in during the
// second half, when the pill is already close to its final size.
const FADE_OUT_FRACTION = 0.5;
const FADE_IN_DELAY_FRACTION = 0.5;

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
     */
    constructor(settings, clock, panelClock) {
        this._settings = settings;
        this._clock = clock;
        this._panelClock = panelClock;
        this._expanded = false;
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);

        this._buildActors();
        this._addToChrome();

        // GrabHelper (also used by GNOME's app folder dialog and screenshot
        // UI) makes the expanded island behave like a menu: Escape or a click
        // outside the pill ungrabs, and keyboard focus is restored afterwards.
        // The grab owner must be an ancestor of the grabbed actor, and a
        // click counts as "outside" when it does not land in the grabbed
        // actor.
        this._grabHelper = new GrabHelper.GrabHelper(this._strip, {
            actionMode: Shell.ActionMode.POPUP,
        });

        this._connectSignals();
        this._updateContent();
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
        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.layoutManager.panelBox.disconnectObject(this);
        this._themeContext.disconnectObject(this);

        Main.ctrlAltTabManager.removeGroup(this._pill);

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
        this._expandedView = new ExpandedView();
        content.add_child(this._collapsedView.actor);
        content.add_child(this._expandedView.actor);
        this._showViewImmediately();
    }

    _addToChrome() {
        // Only the pill takes input; the strip is click-through.
        Main.layoutManager.addChrome(this._strip, {
            affectsInputRegion: false,
            trackFullscreen: true,
        });
        Main.layoutManager.trackChrome(this._pill, {
            affectsInputRegion: true,
        });

        // Makes the island reachable with Ctrl+Alt+Tab, like the top bar.
        Main.ctrlAltTabManager.addGroup(this._pill, _('Froonty'),
            'x-office-calendar-symbolic', {
                focusCallback: () => this.expand(),
            });
    }

    _connectSignals() {
        this._pill.connect('clicked', () => this.toggle());

        this._clock.connectObject('changed', () => this._updateContent(), this);
        this._panelClock.connectObject('cover-changed',
            () => this._onCoverChanged(), this);

        for (const key of GEOMETRY_KEYS) {
            this._settings.connectObject(`changed::${key}`,
                () => this._syncGeometry(), this);
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
        const snapshot = this._clock.snapshot();
        this._collapsedView.update(snapshot);
        this._expandedView.update(snapshot);
        this._pill.accessible_name = this._collapsedView.accessibleText;
    }

    // Places the strip on the primary monitor and snaps the pill to the
    // size of its current state, cancelling any running animation.
    _syncGeometry() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        this._strip.set_position(monitor.x, monitor.y + this._topOffset());
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

    // Offset of the strip (the pill's top edge) from the monitor top. The
    // collapsed pill is vertically centered on the concealed clock button,
    // or on the top bar when the clock is visible; the expanded island grows
    // downward from the same top edge.
    _topOffset() {
        const bounds = this._panelClock.coverBounds;
        const monitor = Main.layoutManager.primaryMonitor;
        const centerY = bounds
            ? (bounds.y1 + bounds.y2) / 2 - monitor.y
            : Main.layoutManager.panelBox.height / 2;
        const {height} = this._targetSize(false);
        return Math.max(0, Math.floor(centerY - height / 2));
    }

    // Settings are in logical pixels; actor sizes are in stage pixels.
    // (On Wayland the scale factor is 1 and stage pixels are logical.)
    //
    // The concealed top bar clock is transparent but still clickable, so the
    // collapsed pill always covers it completely: collapsed-width and
    // collapsed-height are minimums.
    _targetSize(expanded) {
        const prefix = expanded ? 'expanded' : 'collapsed';
        const scale = this._themeContext.scale_factor;
        let width = this._settings.get_int(`${prefix}-width`) * scale;
        let height = this._settings.get_int(`${prefix}-height`) * scale;
        if (!expanded) {
            const cover = this._coverSize();
            width = Math.max(width, cover.width);
            height = Math.max(height, cover.height);
        }
        return {width, height};
    }

    // The pill is centered on the monitor, but the panel centers the clock
    // with its own rounding and shifts it when the left box is crowded. So
    // the pill must reach the clock's farther edge on both sides of the
    // monitor center. Vertically the pill is centered on the clock itself.
    _coverSize() {
        const bounds = this._panelClock.coverBounds;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!bounds || !monitor)
            return {width: 0, height: 0};

        const centerX = monitor.x + monitor.width / 2;
        let width = Math.ceil(2 * Math.max(centerX - bounds.x1, bounds.x2 - centerX));
        // Same parity as the monitor width keeps the centered pill on whole
        // pixels, so rounding cannot expose a 1px sliver of the clock.
        if ((monitor.width - width) % 2 !== 0)
            width += 1;

        return {width, height: Math.ceil(bounds.y2 - bounds.y1)};
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

    _setExpanded(expanded) {
        if (this._expanded === expanded)
            return;

        this._expanded = expanded;
        if (!expanded)
            this._strip.reactive = false;

        if (expanded) {
            this._pill.add_style_class_name('froonty-pill-expanded');
            this._pill.add_accessible_state(Atk.StateType.EXPANDED);
        } else {
            this._pill.remove_style_class_name('froonty-pill-expanded');
            this._pill.remove_accessible_state(Atk.StateType.EXPANDED);
        }

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

        const [incoming, outgoing] = this._views();

        outgoing.remove_all_transitions();
        outgoing.ease({
            opacity: 0,
            duration: duration * FADE_OUT_FRACTION,
            mode: FADE_MODE,
            onComplete: () => outgoing.hide(),
        });

        incoming.remove_all_transitions();
        incoming.show();
        incoming.ease({
            opacity: 255,
            delay: duration * FADE_IN_DELAY_FRACTION,
            duration: duration * (1 - FADE_IN_DELAY_FRACTION),
            mode: FADE_MODE,
        });
    }

    _showViewImmediately() {
        const [visible, hidden] = this._views();
        for (const actor of [visible, hidden])
            actor.remove_all_transitions();

        visible.opacity = 255;
        visible.show();
        hidden.opacity = 0;
        hidden.hide();
    }

    /** @returns {Clutter.Actor[]} [view for current state, other view] */
    _views() {
        const collapsed = this._collapsedView.actor;
        const expanded = this._expandedView.actor;
        return this._expanded ? [expanded, collapsed] : [collapsed, expanded];
    }
}
