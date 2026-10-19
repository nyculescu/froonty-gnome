// SPDX-License-Identifier: GPL-3.0-or-later
// Exercises Froonty draws itself, so they need no pictures: eye exercises
// and breathing, for the Break tab's exercise card (docs/features/break.md).
//
// No timers. What stands still is Cairo (an St.DrawingArea, repainted only
// when St asks or the still frame comes or goes); what moves is a small St
// widget moved by Clutter's own endless key-frame transitions (translation,
// scale), so no JavaScript runs per frame. The breathing words change on
// the transition's timeline markers. The motion runs only while all hold:
// the widget is on screen (mapped) and GNOME's enable-animations is on.
// Otherwise a still frame shows the motion: the path with arrows, both
// targets, the breathing counts as words.

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {DRAWN_KINDS} from './drawnKinds.js';

export {DRAWN_KINDS};

const {LINEAR, EASE_IN_SINE, EASE_OUT_SINE, EASE_IN_OUT_SINE} = Clutter.AnimationMode;

// Positions and sizes are shares of the side, from the middle (y down).
const CY = -0.06; // the picture's middle, above a caption
const DOT = 0.09; // the dot's diameter
const EIGHT = [0.36, 0.18]; // the figure eight's half width and half height
const CIRCLE = 0.34; // the circle's radius
const SWING = 0.36; // half the up-down and left-right path
const FAR = 0.3; // the far target's scale
const BOX = 0.3; // half the breathing square
const BREATH_MIN = 0.45; // the breathing circle's scale, breathed out

// Alphas of the strokes over the island's black.
const GUIDE = 0.28;
const ARROW = 0.85;

// Clutter interpolates in the GValue type it is given, and GJS passes a
// whole number as an int (checked): every value goes in as a double, or
// a scale would jump between 0 and 1.
function double(value) {
    const gvalue = new GObject.Value();
    gvalue.init(GObject.TYPE_DOUBLE);
    gvalue.set_double(value);
    return gvalue;
}

// A transition through stops [at (0 to 1), value, easing into it]: the
// first is at 0, the last at 1. Clutter eases into the last with the
// timeline's own mode (its implicit last key frame) and steps at most one
// key frame per frame drawn, so stops are kept well apart.
function keyframes(property, duration, stops, repeatCount) {
    const [first, last, inner] = [stops[0], stops.at(-1), stops.slice(1, -1)];
    const transition = new Clutter.KeyframeTransition({
        property_name: property,
        interval: new Clutter.Interval({value_type: GObject.TYPE_DOUBLE}),
        duration,
        repeat_count: repeatCount,
        progress_mode: last[2],
        remove_on_complete: repeatCount >= 0,
    });
    transition.set_from(double(first[1]));
    transition.set_to(double(last[1]));
    if (inner.length > 0) {
        transition.set_key_frames(inner.map(s => s[0]));
        transition.set_values(inner.map(s => double(s[1])));
        transition.set_modes(inner.map(s => s[2]));
    }
    return transition;
}

// A sine wave of amplitude a, `cycles` times a loop, from 0 rising (or
// from its low point). Between a zero and a peak Clutter's sine easings
// are the sine itself, so the dot keeps to a true circle or figure eight.
function sine(a, cycles, fromLow = false) {
    const values = fromLow ? [-a, 0, a, 0] : [0, a, 0, -a];
    const n = cycles * 4;
    return Array.from({length: n + 1}, (_v, i) => {
        const value = values[i % 4];
        return [i / n, value, value === 0 ? EASE_IN_SINE : EASE_OUT_SINE];
    });
}

// From -a to a and back, resting `hold` (a share of the loop) at each end.
const swing = (a, hold) => [
    [0, -a, LINEAR], [hold, -a, LINEAR], [0.5, a, EASE_IN_OUT_SINE],
    [0.5 + hold, a, LINEAR], [1, -a, EASE_IN_OUT_SINE],
];

// The breathing words, one per second: "Breathe in · 4", "Breathe in · 3"…
function beats(phases) {
    const list = [];
    for (const [words, seconds] of phases) {
        for (let left = seconds; left > 0; left--)
            list.push([list.length * 1000, _('%s · %d').format(words, left)]);
    }
    return list;
}

// An almond, w wide and h tall, as a path.
function almond(cr, cx, cy, w, h) {
    const [left, right] = [cx - w / 2, cx + w / 2];
    // A cubic's middle reaches 3/4 of its control points' height.
    const bulge = h / 2 * 4 / 3;
    cr.moveTo(left, cy);
    cr.curveTo(left + w / 4, cy - bulge, right - w / 4, cy - bulge, right, cy);
    cr.curveTo(right - w / 4, cy + bulge, left + w / 4, cy + bulge, left, cy);
    cr.closePath();
}

// An open eye; `look` moves the iris (-1 left, 1 right).
function drawEye(cr, g, cx, cy, w, h, look = 0) {
    const [x, r] = [cx + look * w * 0.2, h * 0.4];
    cr.save();
    almond(cr, cx, cy, w, h);
    cr.clip();
    cr.arc(x, cy, r, 0, 2 * Math.PI);
    g.ink(0.25);
    cr.fillPreserve();
    g.ink(0.9);
    cr.stroke();
    cr.arc(x, cy, r * 0.45, 0, 2 * Math.PI);
    g.ink(1);
    cr.fill();
    cr.restore();
    almond(cr, cx, cy, w, h);
    g.ink(1);
    cr.stroke();
}

// An arrowhead with its tip at x, y, pointing along `angle`.
function arrowHead(cr, x, y, angle, length) {
    const wing = side => [x - length * Math.cos(angle + side * 0.6),
        y - length * Math.sin(angle + side * 0.6)];
    cr.moveTo(...wing(-1));
    cr.lineTo(x, y);
    cr.lineTo(...wing(1));
    cr.stroke();
}

function drawFarLook(cr, g) {
    const y = -0.12;
    drawEye(cr, g, g.X(-0.29), g.Y(y), g.L(0.28), g.L(0.16), 1);
    // The look, dashed, to far hills on the horizon.
    g.ink(ARROW);
    cr.setDash([3 * g.px, 4 * g.px], 0);
    cr.moveTo(g.X(-0.12), g.Y(y));
    cr.lineTo(g.X(0.17), g.Y(y));
    cr.stroke();
    cr.setDash([], 0);
    arrowHead(cr, g.X(0.19), g.Y(y), 0, g.L(0.05));
    g.ink(1);
    cr.moveTo(g.X(0.22), g.Y(-0.05));
    cr.lineTo(g.X(0.46), g.Y(-0.05));
    cr.moveTo(g.X(0.24), g.Y(-0.05));
    cr.lineTo(g.X(0.3), g.Y(-0.16));
    cr.lineTo(g.X(0.36), g.Y(-0.05));
    // The second hill, from behind the first.
    cr.moveTo(g.X(0.347), g.Y(-0.073));
    cr.lineTo(g.X(0.39), g.Y(-0.13));
    cr.lineTo(g.X(0.45), g.Y(-0.05));
    cr.stroke();
}

function drawEight(cr, g, moving) {
    const [a, b] = EIGHT;
    g.ink(GUIDE);
    for (let i = 0; i < 96; i++) {
        const t = i / 96 * 2 * Math.PI;
        cr.lineTo(g.X(a * Math.sin(t)), g.Y(b * Math.sin(2 * t)));
    }
    cr.closePath();
    cr.stroke();
    if (moving)
        return;
    // Up through both ends: the dot starts at the crossing, down-right.
    g.ink(ARROW);
    arrowHead(cr, g.X(a), g.Y(0), -Math.PI / 2, g.L(0.06));
    arrowHead(cr, g.X(-a), g.Y(0), -Math.PI / 2, g.L(0.06));
}

function drawCircle(cr, g, moving) {
    g.ink(GUIDE);
    cr.arc(g.X(0), g.Y(0), g.L(CIRCLE), 0, 2 * Math.PI);
    cr.stroke();
    if (moving)
        return;
    // Clockwise, from the top.
    g.ink(ARROW);
    arrowHead(cr, g.X(CIRCLE), g.Y(0), Math.PI / 2, g.L(0.06));
    arrowHead(cr, g.X(-CIRCLE), g.Y(0), -Math.PI / 2, g.L(0.06));
}

function drawSwing(cr, g, moving, vertical) {
    const at = along => (vertical ? [g.X(0), g.Y(along)] : [g.X(along), g.Y(0)]);
    g.ink(GUIDE);
    cr.moveTo(...at(-SWING));
    cr.lineTo(...at(SWING));
    cr.stroke();
    if (moving)
        return;
    // Both ways, from the middle.
    const angle = vertical ? Math.PI / 2 : 0;
    g.ink(ARROW);
    arrowHead(cr, ...at(0.13), angle, g.L(0.06));
    arrowHead(cr, ...at(-0.13), angle + Math.PI, g.L(0.06));
}

function drawNearFar(cr, g, moving) {
    if (moving)
        return;
    // Between the near target and the far one.
    g.ink(ARROW);
    cr.moveTo(g.X(0.03), g.Y(CY));
    cr.lineTo(g.X(0.19), g.Y(CY));
    cr.stroke();
    arrowHead(cr, g.X(0.03), g.Y(CY), Math.PI, g.L(0.05));
    arrowHead(cr, g.X(0.19), g.Y(CY), 0, g.L(0.05));
}

// A face, faint; closed eyes with lashes; a cupped palm over each.
function drawPalming(cr, g) {
    g.ink(GUIDE);
    cr.arc(g.X(0), g.Y(-0.05), g.L(0.35), 0, 2 * Math.PI);
    cr.stroke();
    for (const cx of [-0.15, 0.15]) {
        const [x, y, r] = [g.X(cx), g.Y(-0.05), g.L(0.08)];
        g.ink(1);
        cr.arc(x, y, r, 0.2 * Math.PI, 0.8 * Math.PI);
        cr.stroke();
        for (const turn of [0.35, 0.5, 0.65]) {
            const [c, s] = [Math.cos(turn * Math.PI), Math.sin(turn * Math.PI)];
            cr.moveTo(x + r * c, y + r * s);
            cr.lineTo(x + r * 1.45 * c, y + r * 1.45 * s);
        }
        cr.stroke();
    }
    for (const cx of [-0.15, 0.15]) {
        cr.moveTo(g.X(cx - 0.18), g.Y(0.1));
        cr.curveTo(g.X(cx - 0.18), g.Y(-0.27), g.X(cx + 0.18), g.Y(-0.27),
            g.X(cx + 0.18), g.Y(0.1));
        g.ink(0.12);
        cr.fillPreserve();
        g.ink(0.6);
        cr.stroke();
    }
}

function drawBreathBox(cr, g, moving) {
    g.ink(GUIDE);
    cr.rectangle(g.X(-BOX), g.Y(CY - BOX), g.L(2 * BOX), g.L(2 * BOX));
    cr.stroke();
    if (moving)
        return;
    // In up the left, hold across the top, out down the right, hold back.
    g.ink(ARROW);
    arrowHead(cr, g.X(-BOX), g.Y(CY), -Math.PI / 2, g.L(0.05));
    arrowHead(cr, g.X(0), g.Y(CY - BOX), 0, g.L(0.05));
    arrowHead(cr, g.X(BOX), g.Y(CY), Math.PI / 2, g.L(0.05));
    arrowHead(cr, g.X(0), g.Y(CY + BOX), Math.PI, g.L(0.05));
}

// The breathed-in and breathed-out sizes.
function drawBreathSlow(cr, g) {
    g.ink(GUIDE);
    cr.arc(g.X(0), g.Y(CY), g.L(0.28), 0, 2 * Math.PI);
    cr.stroke();
    cr.setDash([3 * g.px, 4 * g.px], 0);
    cr.arc(g.X(0), g.Y(CY), g.L(0.28 * BREATH_MIN), 0, 2 * Math.PI);
    cr.stroke();
    cr.setDash([], 0);
}

// What each kind draws (draw), the parts that move (St widgets: a CSS
// class, a size, where they rest; `still` overrides that in the still
// frame, `stillOnly` shows a part only there) and their loops. A loop's
// `beats` are captions on its timeline's markers; `done` is the caption
// once a one-off loop (repeat 0) has run.
const KINDS = {
    'far-look': seconds => ({
        name: _('Look at something at least 6 m away'),
        caption: _('6 m or more · %d s').format(seconds),
        parts: [
            {id: 'track', style: 'track', w: 0.72, h: 0.045, y: 0.17},
            {id: 'fill', style: 'fill', w: 0.72, h: 0.045, y: 0.17, pivot: [0, 0.5]},
        ],
        loops: [{
            part: 'fill', property: 'scale-x', duration: seconds * 1000, repeat: 0,
            stops: [[0, 1, LINEAR], [1, 0, LINEAR]], done: _('Done'),
        }],
        draw: drawFarLook,
    }),
    'dot-eight': () => ({
        name: _('Follow the dot along a figure eight'),
        parts: [{id: 'dot', style: 'dot', w: DOT}],
        loops: [
            {part: 'dot', property: 'translation-x', duration: 8000, stops: sine(EIGHT[0], 1)},
            {part: 'dot', property: 'translation-y', duration: 8000, stops: sine(EIGHT[1], 2)},
        ],
        draw: drawEight,
    }),
    'dot-circle': () => ({
        name: _('Follow the dot around a circle'),
        parts: [{id: 'dot', style: 'dot', w: DOT, y: -CIRCLE}],
        loops: [
            {part: 'dot', property: 'translation-x', duration: 8000, stops: sine(CIRCLE, 1)},
            {part: 'dot', property: 'translation-y', duration: 8000, stops: sine(CIRCLE, 1, true)},
        ],
        draw: drawCircle,
    }),
    'dot-updown': () => ({
        name: _('Follow the dot up and down'),
        parts: [{id: 'dot', style: 'dot', w: DOT, y: -SWING}],
        loops: [{part: 'dot', property: 'translation-y', duration: 6000, stops: swing(SWING, 0.1)}],
        draw: (cr, g, moving) => drawSwing(cr, g, moving, true),
    }),
    'dot-leftright': () => ({
        name: _('Follow the dot left and right'),
        parts: [{id: 'dot', style: 'dot', w: DOT, x: -SWING}],
        loops: [{part: 'dot', property: 'translation-x', duration: 6000, stops: swing(SWING, 0.1)}],
        draw: (cr, g, moving) => drawSwing(cr, g, moving, false),
    }),
    'near-far': () => {
        const target = {style: 'target', w: 0.5, y: CY, inner: {style: 'target-dot', w: 0.14}};
        return {
            name: _('Focus on the target as it comes near, then goes far'),
            caption: _('Near, then far: 5 s each'),
            parts: [
                {...target, id: 'target', scale: FAR, still: {x: -0.22, scale: 0.8}},
                {...target, id: 'far', stillOnly: true, still: {x: 0.3, scale: FAR}},
            ],
            loops: [{
                part: 'target', property: 'scale', duration: 10000,
                stops: [[0, FAR, LINEAR], [0.12, 1, EASE_IN_OUT_SINE], [0.5, 1, LINEAR],
                    [0.62, FAR, EASE_IN_OUT_SINE], [1, FAR, LINEAR]],
                beats: [[0, _('Near')], [5000, _('Far')]],
            }],
            draw: drawNearFar,
        };
    },
    'blink': () => ({
        name: _('An eye blinking: blink fully and gently'),
        caption: _('Blink fully, about every 3 s'),
        // The eye closes to a line and opens: about 1 s, every 3 s.
        parts: [{id: 'eye', w: 0.7, h: 0.4, y: CY,
            draw: (cr, g) => drawEye(cr, g, g.X(0), g.Y(0), g.L(0.62), g.L(0.32))}],
        loops: [{
            part: 'eye', property: 'scale-y', duration: 3000,
            stops: [[0, 1, LINEAR], [0.62, 1, LINEAR], [0.75, 0.08, EASE_IN_SINE],
                [0.8, 0.08, LINEAR], [1, 1, EASE_OUT_SINE]],
        }],
    }),
    'palming': seconds => ({
        name: _('Palms cupped over closed eyes'),
        caption: _('%d s').format(seconds),
        draw: drawPalming,
    }),
    'breath-box': () => ({
        name: _('Box breathing: in for 4 seconds, hold 4, out 4, hold 4'),
        caption: _('In 4 · hold 4 · out 4 · hold 4'),
        parts: [
            {id: 'circle', style: 'breath', w: 0.44, y: CY, scale: BREATH_MIN, still: {scale: 1}},
            {id: 'dot', style: 'dot', w: 0.07, x: -BOX, y: CY + BOX},
        ],
        loops: [
            {
                part: 'circle', property: 'scale', duration: 16000,
                stops: [[0, BREATH_MIN, LINEAR], [0.25, 1, EASE_IN_OUT_SINE], [0.5, 1, LINEAR],
                    [0.75, BREATH_MIN, EASE_IN_OUT_SINE], [1, BREATH_MIN, LINEAR]],
                beats: beats([[_('Breathe in'), 4], [_('Hold'), 4], [_('Breathe out'), 4], [_('Hold'), 4]]),
            },
            // The dot goes round the square in step, a side per phase.
            {
                part: 'dot', property: 'translation-x', duration: 16000,
                stops: [[0, -BOX, LINEAR], [0.25, -BOX, LINEAR], [0.5, BOX, LINEAR],
                    [0.75, BOX, LINEAR], [1, -BOX, LINEAR]],
            },
            {
                part: 'dot', property: 'translation-y', duration: 16000,
                stops: [[0, CY + BOX, LINEAR], [0.25, CY - BOX, LINEAR], [0.5, CY - BOX, LINEAR],
                    [0.75, CY + BOX, LINEAR], [1, CY + BOX, LINEAR]],
            },
        ],
        draw: drawBreathBox,
    }),
    'breath-slow': () => ({
        name: _('Slow breathing: in for 5 seconds, out for 5'),
        caption: _('In 5 · out 5'),
        parts: [{id: 'circle', style: 'breath', w: 0.56, y: CY, scale: BREATH_MIN, still: {scale: 1}}],
        loops: [{
            part: 'circle', property: 'scale', duration: 10000,
            stops: [[0, BREATH_MIN, LINEAR], [0.5, 1, EASE_IN_OUT_SINE], [1, BREATH_MIN, EASE_IN_OUT_SINE]],
            beats: beats([[_('Breathe in'), 5], [_('Breathe out'), 5]]),
        }],
        draw: drawBreathSlow,
    }),
};

// Cairo, in the CSS colour. `paint(cr, g)` draws with g.X and g.Y (a
// share of `side` from the middle to surface px), g.L (a share to a
// length), g.px (one logical px) and g.ink(alpha) (the colour).
const DrawnArea = GObject.registerClass(
class DrawnArea extends St.DrawingArea {
    /**
     * @param {number} width logical px
     * @param {number} height logical px
     * @param {number} side logical px the shares are of
     * @param {Function} paint (cr, g)
     */
    _init(width, height, side, paint) {
        super._init({
            style_class: 'froonty-break-drawn-area',
            style: `width: ${width}px; height: ${height}px;`,
        });
        this._side = side;
        this._paint = paint;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        if (width > 0 && height > 0) {
            // In stage px, as the parts' motion; centred, whatever the
            // allocation.
            const px = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const side = this._side * px;
            const {red, green, blue, alpha} = this.get_theme_node().get_foreground_color();
            const g = {
                px,
                X: f => width / 2 + f * side,
                Y: f => height / 2 + f * side,
                L: f => f * side,
                ink: a => cr.setSourceRGBA(red / 255, green / 255, blue / 255, alpha / 255 * a),
            };
            cr.setLineWidth(2 * px);
            cr.setLineCap(1); // Cairo.LineCap.ROUND
            cr.setLineJoin(1); // Cairo.LineJoin.ROUND
            this._paint(cr, g);
        }
        cr.$dispose();
    }
});

function createPart(part, size) {
    const [width, height] = [part.w * size, (part.h ?? part.w) * size];
    let actor;
    if (part.draw) {
        actor = new DrawnArea(width, height, size, part.draw);
    } else {
        actor = new St.Widget({
            style_class: `froonty-break-drawn-${part.style}`,
            style: `width: ${width}px; height: ${height}px;`,
        });
        if (part.inner) {
            actor.layout_manager = new Clutter.BinLayout();
            actor.add_child(createPart(part.inner, size));
        }
    }
    actor.set({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
    actor.set_pivot_point(...(part.pivot ?? [0.5, 0.5]));
    return actor;
}

const DrawnExercise = GObject.registerClass(
class DrawnExercise extends St.Widget {
    _init(kind, spec, size) {
        super._init({
            style_class: 'froonty-break-drawn',
            style: `width: ${size}px; height: ${size}px; min-width: ${size}px; min-height: ${size}px;`,
            layout_manager: new Clutter.BinLayout(),
            // Square, not stretched by a parent box (the caller may change it).
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: spec.name,
            accessible_role: spec.loops ? Atk.Role.ANIMATION : Atk.Role.IMAGE,
        });
        this.kind = kind;
        this._spec = {parts: [], loops: [], ...spec};
        this._size = size;
        this._moving = false;
        this._destroyed = false;

        // Fills the square (St's default alignment); no expand flags, which
        // Clutter would pass up to the card.
        this._area = new DrawnArea(size, size, size,
            (cr, g) => this._spec.draw?.(cr, g, this._moving));
        this.add_child(this._area);
        this._parts = new Map();
        for (const part of this._spec.parts) {
            const actor = createPart(part, size);
            this.add_child(actor);
            this._parts.set(part.id, actor);
        }
        // Last, and never hidden: Clutter tells a parent it is mapped before
        // its children, and the last child is mapped last (and unmapped
        // before its parent), so every part is on screen when motion starts.
        this._caption = new St.Label({
            style_class: 'froonty-break-drawn-caption',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
        });
        this.add_child(this._caption);
        this._caption.connect('notify::mapped', () => this._sync());

        this._stSettings = St.Settings.get();
        this._animationsId = this._stSettings.connect('notify::enable-animations', () => this._sync());
        // Motion is in stage px: a new scale factor restarts it.
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        this._scaleId = this._themeContext.connect('notify::scale-factor', () => this._sync(true));
        this.connect('destroy', () => {
            this._destroyed = true;
            // A playing transition holds its actor.
            this._stop();
            this._stSettings.disconnect(this._animationsId);
            this._themeContext.disconnect(this._scaleId);
        });
        this._sync(true);
    }

    /** Whether it moves now (else it shows its still frame). */
    get moving() {
        return this._moving;
    }

    _sync(force = false) {
        if (this._destroyed)
            return;
        const moving = this._spec.loops.length > 0 && this._stSettings.enable_animations &&
            this._caption.mapped;
        if (moving === this._moving && !force)
            return;
        this._moving = moving;
        this._stop();
        this._place();
        if (moving)
            this._start();
        this._area.queue_repaint();
    }

    _stop() {
        for (const actor of this._parts.values())
            actor.remove_all_transitions();
    }

    // Where the parts rest: where the motion starts, or the still frame.
    _place() {
        const side = this._size * this._themeContext.scale_factor;
        for (const part of this._spec.parts) {
            const actor = this._parts.get(part.id);
            const {x = 0, y = 0, scale = 1} = this._moving ? part : {...part, ...part.still};
            actor.visible = !(this._moving && part.stillOnly);
            actor.set_translation(x * side, y * side, 0);
            actor.set_scale(scale, scale);
        }
        const beats = this._moving ? this._spec.loops.find(loop => loop.beats)?.beats : null;
        this._caption.text = beats?.[0][1] ?? this._spec.caption ?? '';
    }

    _start() {
        const side = this._size * this._themeContext.scale_factor;
        for (const loop of this._spec.loops) {
            const actor = this._parts.get(loop.part);
            const unit = loop.property.startsWith('translation') ? side : 1;
            const stops = loop.stops.map(([at, value, mode]) => [at, value * unit, mode]);
            const properties = loop.property === 'scale' ? ['scale-x', 'scale-y'] : [loop.property];
            properties.forEach((property, i) => {
                const transition = keyframes(property, loop.duration, stops, loop.repeat ?? -1);
                if (i === 0)
                    this._followLoop(transition, loop);
                // Started here; removed in _stop().
                actor.add_transition(property, transition);
            });
        }
    }

    // The loop's words: on its markers (each loop, a marker at 0 comes a
    // frame late; the first words are already shown), and once it is done.
    _followLoop(transition, {beats, done}) {
        if (beats) {
            beats.forEach(([ms], i) => transition.add_marker_at_time(`${i}`, ms));
            transition.connect('marker-reached', (t, name) => {
                this._caption.text = beats[Number(name)][1];
            });
        }
        if (done) {
            transition.connect('stopped', (t, finished) => {
                if (finished)
                    this._caption.text = done;
            });
        }
    }
});

/**
 * A drawn exercise: an St.Widget subclass, `size` logical px square, with
 * a `moving` getter (whether it moves now).
 *
 * @param {string} kind one of DRAWN_KINDS
 * @param {object} [options]
 * @param {number} [options.size] logical px
 * @param {number} [options.seconds] how long far-look's bar takes to empty;
 *   palming shows it; the other kinds have their own fixed loops
 * @returns {St.Widget}
 */
export function createDrawn(kind, {size = 160, seconds = 20} = {}) {
    const spec = KINDS[kind];
    if (!spec)
        throw new Error(`Unknown drawn exercise: ${kind}`);
    return new DrawnExercise(kind, spec(Math.max(1, Math.round(seconds))), size);
}
