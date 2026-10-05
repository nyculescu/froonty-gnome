// SPDX-License-Identifier: GPL-3.0-or-later
// Adapter around GNOME Shell's input method, for the clipboard switcher
// (features/clipboard/switcher.js, docs/features/clipboard.md): where the
// text cursor is, whether a text field has the focus, and typing text
// into it.
//
// Verified against GNOME Shell 50.1:
//
//   Main.inputMethod                 the Shell's Clutter.InputMethod
//                                    (misc/inputMethod.js); its getter
//                                    currentFocus is the text field of a
//                                    client using Wayland's text-input
//                                    protocol (GTK, Qt, Firefox), or null
//   'cursor-location-changed'        Clutter.InputMethod's signal, a
//                                    Graphene.Rect in stage pixels; the
//                                    on-screen keyboard follows it
//                                    (ui/keyboard.js)
//   commit(text)                     Clutter.InputMethod: types `text` into
//                                    that field, as the on-screen keyboard
//                                    does (ui/keyboard.js commit())
//   content_purpose                  TERMINAL for a terminal's field (VTE)
//   IBusManager 'set-cursor-location' {x, y, width, height} of an X11
//                                    client's cursor when it uses IBus
//                                    (misc/ibusManager.js; keyboard.js uses
//                                    it for X11 clients only)
//
// PRIVATE / INTERNAL API:
//
//   Main.inputMethod._cursorRect     {x, y, width, height}, the last cursor
//                                    a client reported, kept by
//                                    vfunc_set_cursor_location (only while
//                                    IBus runs). Read when the signal has
//                                    not been seen for this window yet
//                                    (the field had the cursor before the
//                                    switcher turned on).
//
// A cursor is only believed inside the focused window: both the signal's
// last rectangle and _cursorRect outlive the field they came from.
//
// Nothing is created at module load.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {getIBusManager} from 'resource:///org/gnome/shell/misc/ibusManager.js';

const asRect = rect => rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    ? {x: rect.x, y: rect.y, width: Math.max(0, rect.width), height: Math.max(0, rect.height)}
    : null;

function inside(rect, window) {
    if (!rect || !window)
        return false;
    const frame = window.get_frame_rect();
    return rect.x >= frame.x - 1 && rect.y >= frame.y - 1 &&
        rect.x <= frame.x + frame.width + 1 && rect.y <= frame.y + frame.height + 1;
}

/** Follows the text cursor for as long as it lives; destroy() stops. */
export class TextInput {
    constructor() {
        this._rect = null;
        this._x11Rect = null;
        Main.inputMethod.connectObject('cursor-location-changed', (_im, rect) => {
            this._rect = asRect({x: rect.get_x(), y: rect.get_y(),
                width: rect.get_width(), height: rect.get_height()});
        }, this);
        getIBusManager().connectObject('set-cursor-location', (_manager, rect) => {
            this._x11Rect = asRect(rect);
        }, this);
    }

    destroy() {
        Main.inputMethod.disconnectObject(this);
        getIBusManager().disconnectObject(this);
    }

    /** Whether a text field of a text-input client has the focus. */
    hasFocus() {
        return Boolean(Main.inputMethod.currentFocus);
    }

    /** Whether that field belongs to a terminal. */
    terminalPurpose() {
        return this.hasFocus() &&
            Main.inputMethod.content_purpose === Clutter.InputContentPurpose.TERMINAL;
    }

    /**
     * The text cursor in stage pixels, or null when no field of the focused
     * window has told where it is.
     */
    cursor() {
        const window = global.display.focus_window;
        if (this.hasFocus()) {
            for (const rect of [this._rect, asRect(Main.inputMethod._cursorRect)]) {
                if (inside(rect, window))
                    return rect;
            }
            return null;
        }
        if (window?.get_client_type() === Meta.WindowClientType.X11 && inside(this._x11Rect, window))
            return this._x11Rect;
        return null;
    }

    /** Types `text` into the focused field. */
    commit(text) {
        Main.inputMethod.commit(text);
    }
}
