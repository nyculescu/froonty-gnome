// SPDX-License-Identifier: GPL-3.0-or-later
// The expanded island's resize grip: a short arc in its bottom-right
// corner, concentric with the island's own rounded corner, shown while the
// open tab's size is the user's to set (its hubSizeKeys).
//
//   layer  BinLayout over the island's content, click-through
//    ├ tip   "Drag to resize, double-click to reset", above the grip
//    └ grip  St.DrawingArea in the island's padding corner: reactive,
//            focusable, a resize cursor
//
// Dragging resizes the island live (the island stays centred: width
// changes on both sides, height downward), clamped to the keys' schema
// ranges, to what the hub needs and to the work area (hubResize.js). The
// keys are written once, on release, so Settings → Size shows the same
// numbers. A double-click resets both keys; on the focused grip the arrow
// keys resize in steps (Shift: larger), Escape during a drag cancels it.
//
// No signals but on its own actors, no timers; the stage grab exists only
// during a drag and goes with destroy().

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {clampHubSize, draggedSize, nudgedSize} from './hubResize.js';

// Logical px: the arc's distance from the island's outer edge, its
// length, its stroke, and the smallest grip (the pointer's target).
const INSET = 5;
const ARC_LENGTH = 16;
const STROKE = 2.5;
const MIN_SIZE = 20;
// A press that moves less than this (logical px) is a click.
const CLICK_SLOP = 3;
// Room between the tip and the grip (logical px).
const TIP_GAP = 4;

const DIRECTIONS = new Map([
    [Clutter.KEY_Left, 'left'],
    [Clutter.KEY_KP_Left, 'left'],
    [Clutter.KEY_Right, 'right'],
    [Clutter.KEY_KP_Right, 'right'],
    [Clutter.KEY_Up, 'up'],
    [Clutter.KEY_KP_Up, 'up'],
    [Clutter.KEY_Down, 'down'],
    [Clutter.KEY_KP_Down, 'down'],
]);

// Keys the pill (an St.Button) would take as a click: the island would
// close under the user's hands.
const SWALLOWED = new Set([
    Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_ISO_Enter, Clutter.KEY_space,
]);

export class ResizeGrip {
    /**
     * @param {Gio.Settings} settings
     * @param {St.Widget} pill the island; its padding corner holds the grip
     * @param {object} hooks
     * @param {Function} hooks.sizeKeys () → the open tab's hubSizeKeys,
     *   or null when the island is closed or the tab's size is fixed
     * @param {Function} hooks.bounds () → {width: {need, room}, height:
     *   {need, room}}, logical px for those keys
     * @param {Function} hooks.preview (size) shows the island at that
     *   size of the keys (logical px) at once; null: back to the keys
     */
    constructor(settings, pill, {sizeKeys, bounds, preview}) {
        this._settings = settings;
        this._pill = pill;
        this._sizeKeys = sizeKeys;
        this._bounds = bounds;
        this._preview = preview;
        this._drag = null;
        this._grab = null;
        this._lastClick = null;
        // The grip's side and the arc drawn in it (stage px): _size() and
        // _place().
        this._side = 0;
        this._arc = null;

        this.actor = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
            reactive: false,
        });
        const corner = {
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true,
        };
        this._tip = new St.Label({
            style_class: 'froonty-tooltip froonty-resize-grip-tip',
            text: _('Drag to resize, double-click to reset'),
            visible: false,
            ...corner,
        });
        this.grip = new St.DrawingArea({
            style_class: 'froonty-resize-grip',
            accessible_name: _('Resize'),
            reactive: true,
            can_focus: true,
            track_hover: true,
            visible: false,
            ...corner,
        });
        this.grip.set_cursor_type(Clutter.CursorType.SE_RESIZE);
        this.actor.add_child(this._tip);
        this.actor.add_child(this.grip);

        // The corner moves with every frame of a resize, and the radius St
        // draws may change with the island's size.
        this.actor.connect('notify::allocation', () => {
            if (this.grip.visible)
                this._place();
        });
        this.grip.connect('repaint', () => this._repaint());
        this.grip.connect('notify::hover', () => this._syncTip());
        this.grip.connect('key-press-event', (_actor, event) => this._onKeyPress(event));

        // As GNOME's sliders: a pan from the first pixel, so a press on the
        // grip never reaches the pill's own click gesture (which would
        // close the island).
        this._pan = new Clutter.PanGesture({
            begin_threshold: 0,
            required_button: Clutter.BUTTON_PRIMARY,
        });
        this._pan.connect('recognize', () => this._onDragBegin());
        this._pan.connect('pan-update', () => this._onDragUpdate());
        this._pan.connect('end', () => this._onDragEnd());
        this._pan.connect('cancel', () => this._cancelDrag());
        this.grip.add_action(this._pan);
    }

    destroy() {
        this._cancelDrag();
        this.actor.destroy();
        this.grip = null;
    }

    /**
     * Shows the grip while the open tab's size can be set, and follows the
     * island's corner. A drag ends (cancelled) when the island closes or
     * the tab goes.
     *
     * @param {number} [fade] ms: fades in over its second half, as the
     *   hub does when the island opens
     */
    sync(fade = 0) {
        const keys = this._sizeKeys();
        if (this._drag && keys?.width !== this._drag.keys.width)
            this._cancelDrag();
        const show = keys !== null;
        if (show) {
            this._size();
            this._place();
        }
        if (show === this.grip.visible)
            return;

        if (!show && this.grip.has_key_focus())
            this._pill.grab_key_focus();
        this._lastClick = null;
        this._tip.hide();
        this.grip.remove_all_transitions();
        this.grip.visible = show;
        if (show && fade > 0) {
            this.grip.opacity = 0;
            this.grip.ease({
                opacity: 255,
                delay: fade / 2,
                duration: fade / 2,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            this.grip.opacity = 255;
        }
    }

    // The grip's side, for the largest arc the corner-radius setting can
    // draw. Never set from _place(), which runs during an allocation.
    _size() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const side = arcGeometry(this._settings.get_int('corner-radius') * scale, scale).side;
        if (side !== this._side) {
            this._side = side;
            this.grip.set_size(side, side);
        }
    }

    // Puts the grip in the island's padding corner (its bottom-right on the
    // island's outer corner) and the arc where St draws the corner.
    _place() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const node = this._pill.get_theme_node();
        const right = node.get_padding(St.Side.RIGHT) + node.get_border_width(St.Side.RIGHT);
        const bottom = node.get_padding(St.Side.BOTTOM) + node.get_border_width(St.Side.BOTTOM);
        // St clamps the island's radius to half its shorter side.
        const [width, height] = this._pill.get_size();
        const radius = Math.min(this._settings.get_int('corner-radius') * scale,
            Math.min(width, height) / 2);
        if (this._arc?.radius !== radius) {
            this._arc = arcGeometry(radius, scale);
            this.grip.queue_repaint();
        }
        // Unchanged values: no redraw on every frame of a resize.
        const place = (actor, x, y) => {
            if (actor.translation_x !== x)
                actor.translation_x = x;
            if (actor.translation_y !== y)
                actor.translation_y = y;
        };
        place(this.grip, right, bottom);
        place(this._tip, right - INSET * scale, bottom - this._side - TIP_GAP * scale);
    }

    _repaint() {
        const cr = this.grip.get_context();
        const arc = this._arc;
        if (arc) {
            const [size] = this.grip.get_surface_size();
            // Drawn in the grip's own px; its bottom-right is the corner.
            const {center, rho, inset, length, stroke} = arc;
            const c = size - center;
            const edge = size - inset;
            cr.setLineWidth(stroke);
            cr.setLineCap(1); // Cairo.LineCap.ROUND
            const arcLength = rho * Math.PI / 2;
            if (arcLength >= length) {
                const half = length / 2 / rho;
                cr.arc(c, c, rho, Math.PI / 4 - half, Math.PI / 4 + half);
            } else {
                const straight = (length - arcLength) / 2;
                cr.moveTo(edge, c - straight);
                cr.lineTo(edge, c);
                if (rho > 0)
                    cr.arc(c, c, rho, 0, Math.PI / 2);
                cr.lineTo(c - straight, edge);
            }
            cr.setSourceColor(this.grip.get_theme_node().get_foreground_color());
            cr.stroke();
        }
        cr.$dispose();
    }

    _syncTip() {
        if (this.grip.hover && !this._drag && this.grip.visible)
            this._tip.show();
        else
            this._tip.hide();
    }

    // Per axis: the schema range of the key, and the island's bounds.
    _limits(keys) {
        const bounds = this._bounds();
        const range = key => {
            const [, [min, max]] = this._settings.settings_schema.get_key(key)
                .get_range().recursiveUnpack();
            return {min, max};
        };
        return {
            width: {...range(keys.width), ...bounds.width},
            height: {...range(keys.height), ...bounds.height},
        };
    }

    _read(keys) {
        return {
            width: this._settings.get_int(keys.width),
            height: this._settings.get_int(keys.height),
        };
    }

    _write(keys, size) {
        for (const axis of ['width', 'height']) {
            if (this._settings.get_int(keys[axis]) !== size[axis])
                this._settings.set_int(keys[axis], size[axis]);
        }
    }

    _onDragBegin() {
        const keys = this._sizeKeys();
        if (!keys || this._drag)
            return;
        const limits = this._limits(keys);
        // From the size on screen: a key below what the hub needs would
        // otherwise leave the island still for the first pixels.
        this._drag = {
            keys,
            limits,
            start: clampHubSize(this._read(keys), limits),
            origin: this._pan.get_begin_centroid_abs(),
            time: Clutter.get_current_event_time(),
            moved: false,
            size: null,
        };
        this._grab = global.stage.grab(this.grip);
        this.grip.add_style_pseudo_class('active');
        this._syncTip();
    }

    _onDragUpdate() {
        const drag = this._drag;
        if (!drag)
            return;
        const point = this._pan.get_centroid_abs();
        const [dx, dy] = [point.x - drag.origin.x, point.y - drag.origin.y];
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        if (!drag.moved && Math.hypot(dx, dy) < CLICK_SLOP * scale)
            return;
        drag.moved = true;
        const size = clampHubSize(draggedSize(drag.start, dx, dy, scale), drag.limits);
        if (size.width === drag.size?.width && size.height === drag.size?.height)
            return;
        drag.size = size;
        this._preview(size);
    }

    _onDragEnd() {
        const drag = this._endDrag();
        if (!drag)
            return;
        if (!drag.moved) {
            this._onClick(drag.time);
            return;
        }
        // Written while the preview still holds: the island, already at
        // this size, does not move when the keys change.
        if (drag.size)
            this._write(drag.keys, drag.size);
        this._preview(null);
    }

    // Escape, the island closing, the tab going, destroy(): the keys stay.
    _cancelDrag() {
        const drag = this._endDrag();
        if (!drag)
            return;
        if (this._pan.state === Clutter.GestureState.RECOGNIZING)
            this._pan.cancel();
        if (drag.size)
            this._preview(null);
    }

    _endDrag() {
        const drag = this._drag;
        this._drag = null;
        this._grab?.dismiss();
        this._grab = null;
        if (drag && this.grip) {
            this.grip.remove_style_pseudo_class('active');
            this._syncTip();
        }
        return drag;
    }

    // A second click within GNOME's double-click time resets both keys.
    _onClick(time) {
        const last = this._lastClick;
        if (last !== null && time - last <= Clutter.Settings.get_default().double_click_time) {
            this._lastClick = null;
            const keys = this._sizeKeys();
            if (keys) {
                this._settings.reset(keys.width);
                this._settings.reset(keys.height);
            }
        } else {
            this._lastClick = time;
        }
    }

    _onKeyPress(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Escape && this._drag) {
            this._cancelDrag();
            return Clutter.EVENT_STOP;
        }
        if (SWALLOWED.has(key))
            return Clutter.EVENT_STOP;
        const direction = DIRECTIONS.get(key);
        const keys = this._sizeKeys();
        if (!direction || !keys || this._drag)
            return Clutter.EVENT_PROPAGATE;
        const large = (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const limits = this._limits(keys);
        const current = clampHubSize(this._read(keys), limits);
        this._write(keys, clampHubSize(nudgedSize(current, direction, large), limits));
        return Clutter.EVENT_STOP;
    }
}

/**
 * Where the arc goes, in stage px: the island's corner offset inward by
 * INSET (concentric with it), ARC_LENGTH long around its middle, in a
 * square grip whose bottom-right is the island's outer corner.
 *
 * @param {number} radius the island's corner radius, stage px
 * @param {number} scale
 */
function arcGeometry(radius, scale) {
    const inset = INSET * scale;
    const length = ARC_LENGTH * scale;
    const stroke = STROKE * scale;
    // Distance of the arc's centre from the corner, on each axis.
    const center = Math.max(radius, inset);
    const rho = center - inset;
    const arcLength = rho * Math.PI / 2;
    // How far up (and left) of the corner the stroke reaches.
    const reach = arcLength >= length
        ? center - rho * Math.cos(Math.PI / 4 + length / 2 / rho)
        : center + (length - arcLength) / 2;
    const side = Math.ceil(Math.max(MIN_SIZE * scale, reach + stroke));
    return {radius, center, rho, inset, length, stroke, side};
}
