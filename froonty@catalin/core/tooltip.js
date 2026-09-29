// SPDX-License-Identifier: GPL-3.0-or-later
// A small note-style bubble shown while an actor is hovered. One reusable
// label per owner, no timers. The owner puts `actor` into an overlay layer
// (a plain St.Widget: fixed positions, click-through) above its content.

import St from 'gi://St';

export class Tooltip {
    constructor() {
        this.actor = new St.Label({style_class: 'froonty-tooltip', visible: false});
    }

    /**
     * Shows the bubble while `anchor` is hovered.
     *
     * @param {St.Widget} anchor must have track_hover
     * @param {Function} text () → string to show, or null for none
     * @param {'below'|'right'} side
     */
    attach(anchor, text, side = 'below') {
        anchor.connect('notify::hover', () => {
            const value = anchor.hover ? text() : null;
            if (value)
                this.show(anchor, value, side);
            else
                this.hide();
        });
    }

    show(anchor, text, side) {
        const parent = this.actor.get_parent();
        if (!parent || !anchor.mapped) {
            this.hide();
            return;
        }
        this.actor.text = text;
        const [x, y] = anchor.get_transformed_position();
        const [width, height] = anchor.get_transformed_size();
        const [, labelWidth] = this.actor.get_preferred_width(-1);
        const [, labelHeight] = this.actor.get_preferred_height(-1);
        const [stageX, stageY] = side === 'right'
            ? [x + width, y + (height - labelHeight) / 2]
            : [x, y + height];
        const [, px, py] = parent.transform_stage_point(stageX, stageY);
        // Keep it inside the parent (the island clips its content).
        this.actor.set_position(
            Math.round(Math.max(0, Math.min(px, parent.width - labelWidth))),
            Math.round(Math.max(0, py)));
        this.actor.show();
    }

    hide() {
        this.actor.hide();
    }
}
