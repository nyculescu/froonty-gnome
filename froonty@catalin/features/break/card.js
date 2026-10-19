// SPDX-License-Identifier: GPL-3.0-or-later
// An exercise card (docs/features/break.md, Exercises): one move of the
// catalog with its picture (moving frames, player.js; or drawn by
// Froonty, drawn.js; or none), its title, time and text, Froonty's own
// safety line, and where the picture comes from. In a routine
// (routine.js) it also shows "2 of 5".

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {createDrawn} from './drawn.js';
import {subjectIcon} from './icons.js';
import {FramePlayer} from './player.js';

// The picture's side (logical px).
export const PICTURE_SIZE = 168;

function wrapped(styleClass, text) {
    const label = new St.Label({style_class: styleClass, text, x_expand: true});
    label.clutter_text.set({
        line_wrap: true,
        line_wrap_mode: Pango.WrapMode.WORD_CHAR,
        ellipsize: Pango.EllipsizeMode.NONE,
    });
    return label;
}

/** "30 s", "40 s, each side". */
function timeText(move) {
    return (move.sides ? _('%d s, each side') : _('%d s')).format(move.seconds);
}

// Froonty's own words; CCOHS's and the NHS's are linked from Settings.
function safetyText(move) {
    switch (move.kind) {
    case 'eyes':
        return _('Comfort only; there’s no good evidence these prevent eye problems. Stop if anything hurts.');
    case 'breath':
        return _('Comfort only. Breathe gently; stop if you feel dizzy or short of breath.');
    case 'move':
        return _('Move gently, within what is comfortable. Stop if anything hurts.');
    default:
        return _('Stretch gently to mild tension, hold still about 10–20 s, don’t bounce. Repeat a few times each side. Stop if anything hurts.');
    }
}

function creditText(picture) {
    switch (picture?.source) {
    case 'workoutlabs':
        return _('Picture: WorkoutLabs (fetched to this computer; not part of Froonty)');
    case 'workrave':
        return _('Picture: Workrave (GPL-3.0-or-later)');
    default:
        return '';
    }
}

/** The move's picture actor, `size` px square. */
export function pictureActor(move, {size = PICTURE_SIZE, animate = true} = {}) {
    const p = move.picture;
    if (p?.kind === 'frames')
        return new FramePlayer(p.frames, {size, animate});
    if (p?.kind === 'drawn')
        return createDrawn(p.drawn, {size, seconds: move.seconds});
    return new St.Icon({
        style_class: 'froonty-break-picture-none',
        gicon: subjectIcon(move.kind === 'eyes' ? 'eyesight' : 'movement'),
        icon_size: Math.round(size / 3),
    });
}

export const ExerciseCard = GObject.registerClass(
class ExerciseCard extends St.BoxLayout {
    /**
     * @param {object} move one of the catalog's (exercises.js loadCatalog)
     * @param {object} [options]
     * @param {boolean} [options.animate] break-animate
     * @param {?Function} [options.onAnother] shows a button for the next one
     * @param {?{index: number, count: number}} [options.step] its place in a routine
     * @param {?St.Widget} [options.extra] shown under the text (a routine's controls)
     */
    _init(move, {animate = true, onAnother = null, step = null, extra = null} = {}) {
        super._init({
            style_class: 'froonty-break-card',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.move = move;

        this.picture = pictureActor(move, {animate});
        const frame = new St.Bin({
            style_class: 'froonty-break-picture-frame',
            child: this.picture,
            x_align: Clutter.ActorAlign.CENTER,
            accessible_name: move.title,
        });
        this.add_child(frame);

        const head = new St.BoxLayout({style_class: 'froonty-break-card-head', x_expand: true});
        head.add_child(new St.Label({style_class: 'froonty-break-card-title', text: move.title,
            x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        const time = step ? _('%d of %d · %s').format(step.index + 1, step.count, timeText(move)) : timeText(move);
        head.add_child(new St.Label({style_class: 'froonty-break-dim', text: time,
            y_align: Clutter.ActorAlign.CENTER}));
        this.add_child(head);
        this.add_child(wrapped('froonty-break-card-text', move.text));
        if (extra)
            this.add_child(extra);

        const foot = new St.BoxLayout({style_class: 'froonty-break-card-foot'});
        const notes = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        notes.add_child(wrapped('froonty-break-dim', safetyText(move)));
        const credit = creditText(move.picture);
        if (credit)
            notes.add_child(wrapped('froonty-break-credit', credit));
        foot.add_child(notes);
        if (onAnother) {
            this.anotherButton = new St.Button({
                style_class: 'froonty-break-action',
                label: _('Another'),
                accessible_name: _('Show another exercise'),
                can_focus: true,
                track_hover: true,
                y_align: Clutter.ActorAlign.START,
            });
            this.anotherButton.connect('clicked', () => onAnother());
            foot.add_child(this.anotherButton);
        }
        this.add_child(foot);
    }
});
