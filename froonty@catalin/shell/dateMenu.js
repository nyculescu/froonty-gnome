// SPDX-License-Identifier: GPL-3.0-or-later
// Adapter around GNOME Shell's top bar date menu (ui/dateMenu.js).
//
// PRIVATE / INTERNAL API. Every GNOME Shell internal Froonty touches for the
// date menu is confined to this file. Verified against GNOME Shell 46.0:
//
//   Main.panel.statusArea.dateMenu     DateMenuButton instance registered by
//                                      Panel._ensureIndicator() (ui/panel.js)
//   dateMenu.container                 St.Bin wrapper that PanelMenu.ButtonBox
//                                      places in the panel's center box
//                                      (ui/panelMenu.js)
//
// Why opacity instead of hide(): the date menu's popup is anchored to the
// button (PopupMenu -> BoxPointer.setPosition(sourceActor)), PopupMenu closes
// itself when its source actor is unmapped, and Panel._toggleMenu() refuses
// to open a menu whose indicator is not mapped. Making the clock transparent
// keeps it mapped and allocated at top center, so GNOME's calendar and
// notification menu can still be opened under the island in a later phase.
//
// A transparent clock is still clickable, so the island must cover it
// completely; coverBounds tells the island where it is on screen.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

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
     * Stage-pixel box {x1, y1, x2, y2} of the concealed clock button, which
     * the island must cover, or null when the clock is visible or not laid
     * out yet.
     */
    get coverBounds() {
        const container = this._hiddenContainer;
        if (!container?.mapped)
            return null;

        const [x, y] = container.get_transformed_position();
        const [width, height] = container.get_transformed_size();
        // Before the first layout pass these are NaN.
        if (![x, y, width, height].every(Number.isFinite))
            return null;

        return {x1: x, y1: y, x2: x + width, y2: y + height};
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
