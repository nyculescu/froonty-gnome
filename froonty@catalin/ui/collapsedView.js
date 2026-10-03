// SPDX-License-Identifier: GPL-3.0-or-later
// Content of the collapsed pill: the time, optionally preceded by a short
// date, and the unread-notifications dot of GNOME's clock, which the pill
// covers. A feature's pill accessory adds a wing on each side, and may
// briefly show a notice in place of the time (a peek); a feature's cue
// shows after the dot:
//
//   [leading] [cue pad][dot pad][date time | peek][dot][cue] [trailing]
//
// Each pad is an invisible twin of what is on the other side, so the time
// stays centred (GNOME's clock balances its dot the same way).

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const PEEK_FADE_MS = 200;

export class CollapsedView {
    constructor() {
        this.actor = new St.BoxLayout({
            style_class: 'froonty-collapsed-row',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._cuePad = this._addCue(this.actor);
        this._cuePad.opacity = 0;
        this._unreadPad = this._addDot(this.actor);
        this._unreadPad.opacity = 0;

        // The time and, during a peek, the notice, stacked for a cross-fade.
        this._center = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this._center);
        this._labels = new St.BoxLayout({
            style_class: 'froonty-collapsed',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._center.add_child(this._labels);
        this._dateLabel = this._addLabel(this._labels, 'froonty-collapsed-date');
        this._timeLabel = this._addLabel(this._labels, 'froonty-collapsed-time');
        this._peekLabel = this._addLabel(this._center, 'froonty-collapsed-peek');
        this._peekLabel.x_align = Clutter.ActorAlign.CENTER;
        this._peekLabel.visible = false;
        this._peekLabel.opacity = 0;

        this._unreadDot = this._addDot(this.actor);
        this._accessory = null;
        this._peekText = null;
        this._cue = this._addCue(this.actor);
        this._cueText = '';
        this._cueLook = '';
    }

    /** @param {object} clock a ClockService snapshot */
    update(clock) {
        this._timeLabel.text = clock.time;
        this._dateLabel.text = clock.shortDate;
        this._dateLabel.visible = clock.showDate;
    }

    /** @param {boolean} unread whether GNOME's clock would show its dot */
    setUnread(unread) {
        this._unreadDot.visible = unread;
        this._unreadPad.visible = unread;
    }

    /**
     * Puts a pill accessory's wings around the time (null removes them).
     *
     * @param {?object} accessory {leading, trailing, accessibleText}
     */
    setAccessory(accessory) {
        for (const wing of [this._accessory?.leading, this._accessory?.trailing]) {
            if (wing?.get_parent() === this.actor)
                this.actor.remove_child(wing);
        }
        this._accessory = accessory;
        if (accessory?.leading)
            this.actor.insert_child_at_index(accessory.leading, 0);
        if (accessory?.trailing)
            this.actor.add_child(accessory.trailing);
        if (!accessory)
            this.setPeek(null);
    }

    /**
     * Shows a notice in place of the date and time, or (null) them again.
     *
     * @param {?string} text
     */
    setPeek(text) {
        const was = this._peekText ?? null;
        this._peekText = text || null;
        if (text) {
            this._peekLabel.text = text;
            if (was)
                return;
            this._peekLabel.show();
            this._fade(this._peekLabel, 255);
            this._fade(this._labels, 0);
        } else if (was) {
            // Its width goes at once, so the pill can shrink back.
            this._peekLabel.remove_transition('opacity');
            this._peekLabel.opacity = 0;
            this._peekLabel.hide();
            this._fade(this._labels, 255);
        }
    }

    /** The notice shown in place of the time, or null. */
    get peekText() {
        return this._peekText ?? null;
    }

    /**
     * @param {?object} cue {gicon, styleClass, text, accessibleText}, or
     *   null for none
     * @returns {boolean} whether its size may have changed (it appeared,
     *   went, or changed style or text)
     */
    setCue(cue) {
        const look = cue ? `${cue.styleClass}|${cue.text}` : '';
        const resized = look !== this._cueLook;
        this._cueLook = look;
        for (const widget of [this._cue, this._cuePad]) {
            widget.visible = Boolean(cue);
            if (!cue)
                continue;
            widget.style_class = `froonty-pill-cue ${cue.styleClass}`;
            const [icon, text] = widget.get_children();
            icon.gicon = cue.gicon;
            text.text = cue.text;
            text.visible = Boolean(cue.text);
        }
        this._cueText = cue?.accessibleText ?? '';
        return resized;
    }

    /** Whether a cue is shown (the pill may need to widen). */
    get hasCue() {
        return this._cue.visible;
    }

    get accessibleText() {
        let text = this._dateLabel.visible
            ? `${this._dateLabel.text} ${this._timeLabel.text}`
            : this._timeLabel.text;
        const extra = this._accessory?.accessibleText;
        if (extra)
            text = `${text}, ${extra}`;
        if (this._unreadDot.visible)
            text = `${text}, ${_('unread notifications')}`;
        return this._cueText ? `${text}, ${this._cueText}` : text;
    }

    _fade(actor, opacity) {
        actor.remove_transition('opacity');
        actor.ease({
            opacity,
            duration: PEEK_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _addLabel(box, styleClass) {
        const label = new St.Label({
            style_class: styleClass,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(label);
        return label;
    }

    _addDot(box) {
        const dot = new St.Widget({
            style_class: 'froonty-unread-dot',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        box.add_child(dot);
        return dot;
    }

    // An icon and a short text ("25m", "+3m"), styled by its level.
    _addCue(box) {
        const cue = new St.BoxLayout({
            style_class: 'froonty-pill-cue',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        cue.add_child(new St.Icon({y_align: Clutter.ActorAlign.CENTER}));
        cue.add_child(new St.Label({
            style_class: 'froonty-pill-cue-text',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(cue);
        return cue;
    }
}
