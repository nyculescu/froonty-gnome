// SPDX-License-Identifier: GPL-3.0-or-later
// An exercise card: Workrave's pictures in one row (still, no timer: each
// with its time under it), its title and text, and Froonty's own safety
// line (docs/features/break.md). Mirrored frames are the same picture
// flipped, as Workrave shows them.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {imageFile} from './exercises.js';

// Picture size by how many share the row (logical px).
const FRAME_SIZES = {1: 128, 2: 112};
const MANY_FRAMES_SIZE = 76;

function wrapped(styleClass, text) {
    const label = new St.Label({style_class: styleClass, text, x_expand: true});
    label.clutter_text.set({
        line_wrap: true,
        line_wrap_mode: Pango.WrapMode.WORD_CHAR,
        ellipsize: Pango.EllipsizeMode.NONE,
    });
    return label;
}

export const ExerciseCard = GObject.registerClass(
class ExerciseCard extends St.BoxLayout {
    /**
     * @param {object} exercise one of exercises.json's
     * @param {object} [options]
     * @param {?Function} [options.onAnother] shows a button for the next one
     */
    _init(exercise, {onAnother = null} = {}) {
        super._init({
            style_class: 'froonty-break-card',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.exercise = exercise;
        this.frames = [];

        const row = new St.BoxLayout({style_class: 'froonty-break-frames', x_align: Clutter.ActorAlign.START});
        const count = exercise.frames.length;
        const size = FRAME_SIZES[count] ?? MANY_FRAMES_SIZE;
        exercise.frames.forEach((frame, i) => {
            const icon = new St.Icon({
                gicon: new Gio.FileIcon({file: imageFile(frame.image)}),
                icon_size: size,
            });
            if (frame.mirror) {
                icon.set_pivot_point(0.5, 0.5);
                icon.scale_x = -1;
            }
            const picture = new St.Bin({
                style_class: 'froonty-break-frame',
                child: icon,
                accessible_name: (frame.mirror
                    ? _('%s, picture %d of %d, other side') : _('%s, picture %d of %d'))
                    .format(exercise.title, i + 1, count),
            });
            const column = new St.BoxLayout({
                style_class: 'froonty-break-frame-column',
                orientation: Clutter.Orientation.VERTICAL,
            });
            column.add_child(picture);
            column.add_child(new St.Label({
                style_class: 'froonty-break-caption',
                text: (frame.mirror ? _('%d s, other side') : _('%d s')).format(frame.seconds),
                x_align: Clutter.ActorAlign.CENTER,
            }));
            row.add_child(column);
            this.frames.push({icon, picture, frame});
        });
        this.add_child(row);

        this.add_child(new St.Label({style_class: 'froonty-break-card-title', text: exercise.title}));
        // Workrave's text (exercises/README.md).
        this.add_child(wrapped('froonty-break-card-text', exercise.text));

        const foot = new St.BoxLayout({style_class: 'froonty-break-card-foot'});
        // Froonty's own words; CCOHS's and the NHS's are linked from Settings.
        foot.add_child(wrapped('froonty-break-dim', exercise.kind === 'eyes'
            ? _('Comfort only; there’s no good evidence these prevent eye problems. Stop if anything hurts.')
            : _('Stretch gently to mild tension, hold still about 10–20 s, don’t bounce. Repeat a few times each side. Stop if anything hurts.')));
        if (onAnother) {
            this.anotherButton = new St.Button({
                style_class: 'froonty-break-action',
                label: _('Another'),
                accessible_name: _('Show another stretch'),
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
