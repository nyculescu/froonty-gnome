// SPDX-License-Identifier: GPL-3.0-or-later
// An exercise picture that moves (docs/features/break.md, Exercises): its
// frames one after another, each for its own time, fading into the next.
//
// No GLib timer: each frame is a Clutter transition (a fade with a delay,
// GNOME Shell's ease()) chained from the previous one's completion. It
// plays only while it is on screen, break-animate is on and GNOME's
// Animations switch is on; otherwise it shows the first frame. Shell's
// ease() completes at once on an actor that is not mapped or with
// animations off, so the chain is only started while all three hold, and
// stopping removes the transitions (which does not complete them). Frame
// times are the pictures' own (DESIGN.md §2, principle 2's exception).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

// The fade between two frames, at most (and at most half a frame).
const FADE_MS = 250;
// A frame is shown at least this long (a damaged index cannot make the
// chain complete at once).
const MIN_FRAME_MS = 200;

export const FramePlayer = GObject.registerClass(
class FramePlayer extends St.Widget {
    /**
     * @param {object[]} frames [{file: Gio.File, ms, mirror}]
     * @param {object} options
     * @param {number} options.size logical px (square)
     * @param {boolean} [options.animate] break-animate
     */
    _init(frames, {size, animate = true}) {
        super._init({
            style_class: 'froonty-break-picture',
            layout_manager: new Clutter.BinLayout(),
            width: size,
            height: size,
        });
        this._frames = frames;
        this._animate = animate && frames.length > 1;
        this._index = 0;
        this._playing = false;
        // Two layers: the frame shown, and the next one fading in over it.
        this._layers = [0, 1].map(() => {
            const icon = new St.Icon({icon_size: size, x_expand: true, y_expand: true});
            icon.set_pivot_point(0.5, 0.5);
            this.add_child(icon);
            return icon;
        });
        this._show(this._layers[0], 0);
        this._layers[1].opacity = 0;

        this._stSettings = St.Settings.get();
        this._animationsId = this._stSettings.connect('notify::enable-animations', () => this._sync());
        // The layers themselves: Clutter maps a parent before its children
        // (features/media/bars.js), and either layer may be eased.
        for (const icon of this._layers)
            icon.connect('notify::mapped', () => this._sync());
        this.connect('destroy', () => {
            this._stop();
            this._stSettings.disconnect(this._animationsId);
        });
    }

    /** Whether the frames are moving now (for tests). */
    get playing() {
        return this._playing;
    }

    /** The frame shown now (for tests). */
    get index() {
        return this._index;
    }

    _show(icon, i) {
        const frame = this._frames[i];
        icon.gicon = new Gio.FileIcon({file: frame.file});
        icon.scale_x = frame.mirror ? -1 : 1;
    }

    _sync() {
        const play = this._animate && this._stSettings.enable_animations &&
            this._layers.every(icon => icon.mapped);
        if (play && !this._playing)
            this._start();
        else if (!play && this._playing)
            this._stop();
    }

    _start() {
        this._playing = true;
        this._next();
    }

    _stop() {
        this._playing = false;
        for (const icon of this._layers)
            icon.remove_all_transitions();
        // A still: the frame shown, alone.
        const [shown, other] = this._layers;
        shown.opacity = 255;
        other.opacity = 0;
        this.set_child_above_sibling(shown, other);
    }

    // The next frame, on the other layer raised on top, fades in once the
    // shown one's time is up; then the layers swap roles. (St loads a
    // picture asynchronously: it has the shown frame's time to load.)
    _next() {
        const [shown, incoming] = this._layers;
        const ms = Math.max(MIN_FRAME_MS, this._frames[this._index].ms);
        const fade = Math.min(FADE_MS, Math.floor(ms / 2));
        const nextIndex = (this._index + 1) % this._frames.length;
        incoming.opacity = 0;
        this._show(incoming, nextIndex);
        this.set_child_above_sibling(incoming, shown);
        incoming.ease({
            opacity: 255,
            delay: Math.max(0, ms - fade),
            duration: fade,
            mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
            onComplete: () => {
                if (!this._playing)
                    return;
                this._index = nextIndex;
                this._layers = [incoming, shown];
                this._next();
            },
        });
    }
});
