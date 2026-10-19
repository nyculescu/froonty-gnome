// SPDX-License-Identifier: GPL-3.0-or-later
// A guided routine (docs/features/break.md, Exercises): a few moves
// (routines.js) one after another, each on its own card with a bar that
// fills over the move's time; Pause, Next and Stop.
//
// No GLib timer: each move's time is its bar's transition (GNOME Shell's
// ease(), with animationRequired so it still takes its time with GNOME's
// animations off), and the next move starts from its completion. Shell's
// ease() completes at once on an actor that is not on screen, so the bar
// runs only while it is mapped: when the island closes, the routine
// pauses (the transition is removed, which does not complete it), and
// Resume continues with the time left. Move times are the catalog's
// (DESIGN.md §2, principle 2's exception).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ExerciseCard} from './card.js';

export class RoutinePlayer {
    /**
     * @param {object[]} steps the moves, in order
     * @param {object} options
     * @param {boolean} [options.animate] break-animate (the pictures)
     * @param {Function} options.onShown (ids) the moves shown, not repeated soon
     * @param {Function} options.onEnd (completed: boolean) finished or stopped
     */
    constructor(steps, {animate = true, onShown, onEnd}) {
        this._steps = steps;
        this._animate = animate;
        this._onShown = onShown;
        this._onEnd = onEnd;
        this._index = 0;
        this._running = false;
        this._remainingMs = 0;
        this._startedUs = 0;
        this.actor = new St.BoxLayout({
            style_class: 'froonty-break-routine',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.actor.connect('destroy', () => {
            this._destroyed = true;
            this._fill?.remove_all_transitions();
        });
        this._showStep(0);
    }

    /** Which move, and whether its time runs (for tests). */
    get state() {
        return {index: this._index, count: this._steps.length, running: this._running};
    }

    _showStep(i) {
        this._index = i;
        this._fill?.remove_all_transitions();
        this.actor.destroy_all_children();
        const move = this._steps[i];
        this._remainingMs = move.seconds * 1000;

        const bar = new St.Widget({style_class: 'froonty-break-bar', layout_manager: new Clutter.BinLayout(),
            x_expand: true});
        this._fill = new St.Widget({style_class: 'froonty-break-bar-fill', x_expand: true, y_expand: true,
            scale_x: 0});
        this._fill.set_pivot_point(0, 0.5);
        bar.add_child(this._fill);
        this._fill.connect('notify::mapped', () => {
            if (!this._fill?.mapped && this._running)
                this._pause();
        });

        this.pauseButton = this._button(_('Pause'), () => (this._running ? this._pause() : this._resume()));
        this.nextButton = this._button(i + 1 < this._steps.length ? _('Next') : _('Done'), () => this._advance());
        this.stopButton = this._button(_('Stop'), () => this._end(false));
        const controls = new St.BoxLayout({style_class: 'froonty-break-row froonty-break-actions'});
        [this.pauseButton, this.nextButton, this.stopButton].forEach(b => controls.add_child(b));
        const extra = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        extra.add_child(bar);
        extra.add_child(controls);

        this.card = new ExerciseCard(move, {animate: this._animate, step: {index: i, count: this._steps.length},
            extra});
        this.actor.add_child(this.card);
        this._onShown([move.id]);
        // Runs once the card is on screen.
        const start = () => {
            if (this._destroyed || this._index !== i)
                return;
            if (this._fill.mapped)
                this._resume();
            else
                this._syncPauseLabel();
        };
        if (this._fill.mapped)
            start();
        else
            this._mapOnce(this._fill, start);
    }

    _mapOnce(actor, callback) {
        const id = actor.connect('notify::mapped', () => {
            if (actor.mapped) {
                actor.disconnect(id);
                callback();
            }
        });
    }

    _button(label, onClick) {
        const b = new St.Button({style_class: 'froonty-break-action', label, can_focus: true, track_hover: true});
        b.connect('clicked', onClick);
        return b;
    }

    _syncPauseLabel() {
        this.pauseButton.label = this._running ? _('Pause') : _('Resume');
    }

    _resume() {
        if (this._running || !this._fill?.mapped)
            return;
        // Paused right at the move's end: on to the next.
        if (this._remainingMs <= 0) {
            this._advance();
            return;
        }
        this._running = true;
        this._startedUs = GLib.get_monotonic_time();
        const fill = this._fill;
        fill.ease({
            scale_x: 1,
            duration: this._remainingMs,
            mode: Clutter.AnimationMode.LINEAR,
            animationRequired: true,
            onComplete: () => {
                if (this._running && fill === this._fill && !this._destroyed)
                    this._advance();
            },
        });
        this._syncPauseLabel();
    }

    _pause() {
        if (!this._running)
            return;
        this._running = false;
        const elapsed = (GLib.get_monotonic_time() - this._startedUs) / 1000;
        const total = this._steps[this._index].seconds * 1000;
        this._remainingMs = Math.max(0, this._remainingMs - elapsed);
        this._fill.remove_all_transitions();
        this._fill.scale_x = 1 - this._remainingMs / total;
        this._syncPauseLabel();
    }

    _advance() {
        this._running = false;
        if (this._index + 1 < this._steps.length)
            this._showStep(this._index + 1);
        else
            this._end(true);
    }

    _end(completed) {
        this._running = false;
        this._fill?.remove_all_transitions();
        this._onEnd(completed);
    }
}
