// SPDX-License-Identifier: GPL-3.0-or-later
// Adapter around GNOME Shell's top bar date menu (ui/dateMenu.js).
//
// PRIVATE / INTERNAL API. Every GNOME Shell internal Froonty touches for the
// date menu is confined to this file. Verified against GNOME Shell 50.1:
//
//   Main.panel.statusArea.dateMenu     DateMenuButton instance registered by
//                                      Panel._ensureIndicator() (ui/panel.js)
//   dateMenu.container                 St.Bin wrapper that PanelMenu.ButtonBox
//                                      places in the panel's center box
//                                      (ui/panelMenu.js)
//   dateMenu._clock                    the GnomeDesktop.WallClock behind the
//                                      top bar clock (ui/dateMenu.js), alive
//                                      as long as the Shell (topBarWallClock)
//   dateMenu._indicator                MessagesIndicator, the clock's
//                                      unread-notifications dot (CalendarMenu)
//
// Why opacity instead of hide(): the date menu's popup is anchored to the
// button (PopupMenu -> BoxPointer.setPosition(sourceActor)), PopupMenu closes
// itself when its source actor is unmapped, and Panel._toggleMenu() refuses
// to open a menu whose indicator is not mapped. Making the clock transparent
// keeps it mapped and allocated at top center, so GNOME's calendar and
// notification menu still opens there, under the island (CalendarMenu).
//
// A transparent clock is still clickable, so the island must cover it
// completely; coverBounds tells the island where it is on screen.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

/**
 * The top bar clock's own WallClock, or null if this Shell has none
 * there. Froonty listens to it rather than making one: a WallClock's
 * timer is only removed when it is disposed, which extensions should not
 * force (run_dispose), so one of its own would tick on after disable().
 */
export function topBarWallClock() {
    const clock = Main.panel?.statusArea?.dateMenu?._clock;
    return clock instanceof GnomeDesktop.WallClock ? clock : null;
}

/** Emits 'cover-changed' when coverBounds may have changed. */
export class PanelClock extends EventEmitter {
    constructor() {
        super();
        this._hiddenContainer = null;
        this._savedOpacity = 0;
        this._watchedActors = [];
        this._coverLaterId = 0;
    }

    /**
     * Box {x1, y1, x2, y2} of the concealed clock button, which the island
     * must cover, in uiGroup coordinates (the island's own space), or null
     * when the clock is visible or not laid out yet.
     *
     * Not stage coordinates: at login GNOME Shell 50 enables extensions
     * while uiGroup is still scaled to 0.75 for the startup animation, and
     * a scale change emits no allocation change to resync on.
     */
    get coverBounds() {
        const container = this._hiddenContainer;
        if (!container?.mapped)
            return null;

        const uiGroup = Main.layoutManager.uiGroup;
        const corner = (x, y) => container.apply_relative_transform_to_point(
            uiGroup, new Graphene.Point3D({x, y, z: 0}));
        const topLeft = corner(0, 0);
        const bottomRight = corner(container.width, container.height);
        const bounds = {x1: topLeft.x, y1: topLeft.y, x2: bottomRight.x, y2: bottomRight.y};
        // Before the first layout pass these are NaN.
        if (!Object.values(bounds).every(Number.isFinite))
            return null;

        return bounds;
    }

    /** Make GNOME's top bar clock invisible (it stays mapped). */
    conceal() {
        const container = this._container();
        if (!container || this._hiddenContainer)
            return;

        this._hiddenContainer = container;
        this._savedOpacity = container.opacity;
        container.opacity = 0;

        // The panel may rebuild its indicators on session mode changes.
        container.connectObject('destroy', () => this._forgetContainer(), this);
        this._watchCoverChanges(container);
        this.emit('cover-changed');
    }

    /** Undo conceal(). Safe to call when nothing is concealed. */
    restore() {
        const container = this._hiddenContainer;
        if (!container)
            return;

        container.opacity = this._savedOpacity;
        this._forgetContainer();
    }

    _container() {
        return Main.panel?.statusArea?.dateMenu?.container ?? null;
    }

    // The clock's on-screen bounds change when the button's content changes
    // (date/seconds settings, the unread-notifications dot) but also when
    // any ancestor moves, e.g. the panel moving to a new primary monitor.
    // Allocation is relative to the parent, so every ancestor up to the
    // panel box is watched.
    _watchCoverChanges(container) {
        const panelBox = Main.layoutManager.panelBox;
        for (let actor = container; actor; actor = actor.get_parent()) {
            actor.connectObject('notify::allocation',
                () => this._queueCoverChanged(), this);
            this._watchedActors.push(actor);
            if (actor === panelBox)
                break;
        }
    }

    // Allocation notifications arrive in bursts in the middle of a layout
    // pass, when the transformed positions are not final yet. Emit once,
    // after layout and before the next frame is painted.
    _queueCoverChanged() {
        if (this._coverLaterId)
            return;

        const laters = global.compositor.get_laters();
        this._coverLaterId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._coverLaterId = 0;
            this.emit('cover-changed');
            return GLib.SOURCE_REMOVE;
        });
    }

    _forgetContainer() {
        for (const actor of this._watchedActors)
            actor.disconnectObject(this);
        this._watchedActors = [];

        if (this._coverLaterId) {
            global.compositor.get_laters().remove(this._coverLaterId);
            this._coverLaterId = 0;
        }

        this._hiddenContainer = null;
        this.emit('cover-changed');
    }
}

/**
 * GNOME's own calendar and notification menu: the one the top bar clock
 * opens, with the notification list, the calendar, events, world clocks
 * and weather. Froonty only opens and closes it and reads the clock's
 * unread-notifications dot. GNOME keeps the notifications, their actions
 * and Do Not Disturb; nothing here dismisses or destroys a notification.
 *
 * Emits 'opened' when the menu opens, by any means (the island, Super+V, a
 * click on a visible clock), and 'unread-changed' when the dot appears or
 * goes.
 */
export class CalendarMenu extends EventEmitter {
    constructor() {
        super();
        const button = Main.panel?.statusArea?.dateMenu;
        this._menu = button?.menu ?? null;
        // GNOME's MessagesIndicator. It is visible while notifications are
        // unseen and not waiting for their banner, unless Do Not Disturb is
        // on. Following it keeps GNOME's rules in one place.
        const indicator = button?._indicator;
        this._indicator = indicator instanceof St.Widget ? indicator : null;
        this._holdingBanners = false;

        this._menu?.connectObject('open-state-changed', (_menu, open) => {
            if (open)
                this.emit('opened');
        }, this);
        this._indicator?.connectObject(
            'notify::visible', () => this.emit('unread-changed'),
            'destroy', () => {
                this._indicator = null;
                this.emit('unread-changed');
            },
            this);
    }

    destroy() {
        this.holdBanners(false);
        this._menu?.disconnectObject(this);
        this._indicator?.disconnectObject(this);
        this._menu = null;
        this._indicator = null;
    }

    /** Whether this Shell has the menu at all. */
    get available() {
        return this._menu !== null;
    }

    get isOpen() {
        return this._menu?.isOpen ?? false;
    }

    /** Whether GNOME's clock would show its unread-notifications dot. */
    get hasUnread() {
        return this._indicator?.visible ?? false;
    }

    /**
     * Opens the menu the way Super+V does (Panel.toggleCalendar(), which
     * also moves the keyboard focus into it). It points at the transparent
     * clock under the island, and a menu raises itself to the top of
     * uiGroup when it opens, so it shows above the island.
     */
    open() {
        if (!this.isOpen)
            Main.panel.toggleCalendar();
    }

    close() {
        if (this.isOpen)
            Main.panel.closeCalendar();
    }

    /**
     * Banners show at top center, under the clock: where the expanded
     * island is. GNOME holds them back while a menu is open in their place
     * (Panel._onMenuSet); the island does the same while it is expanded.
     * A banner then waits in GNOME's queue instead of showing, and being
     * marked as seen, underneath the island.
     *
     * @param {boolean} hold
     */
    holdBanners(hold) {
        if (hold === this._holdingBanners)
            return;
        this._holdingBanners = hold;

        const tray = Main.messageTray;
        if (tray?.bannerAlignment !== Clutter.ActorAlign.CENTER)
            return;
        // The open date menu holds them too; never release them under it.
        tray.bannerBlocked = hold || this.isOpen;
    }
}
