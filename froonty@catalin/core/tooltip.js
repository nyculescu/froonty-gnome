// SPDX-License-Identifier: GPL-3.0-or-later
// A small note-style bubble shown while an actor is hovered. One reusable
// label per owner, no timers. The owner puts `actor` into an overlay layer
// (a plain St.Widget: fixed positions, click-through) above its content.

import Pango from 'gi://Pango';
import St from 'gi://St';

export class Tooltip {
    /**
     * @param {object} [options]
     * @param {number} [options.maxWidth] a longer text wraps at this width
     *   (logical pixels); 0: one line, as wide as it needs
     */
    constructor({maxWidth = 0} = {}) {
        this.actor = new St.Label({style_class: 'froonty-tooltip', visible: false});
        this._maxWidth = maxWidth;
        // The anchor the bubble is shown for, or null.
        this._anchor = null;
        if (maxWidth) {
            this.actor.clutter_text.line_wrap = true;
            this.actor.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            this.actor.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        }
    }

    /**
     * Shows the bubble while `anchor` is hovered.
     *
     * @param {St.Widget} anchor must have track_hover
     * @param {Function} text () → string to show, or null for none
     * @param {'below'|'above'|'right'} side
     */
    attach(anchor, text, side = 'below') {
        anchor.connect('notify::hover', () => {
            const value = anchor.hover ? text() : null;
            if (value)
                this.show(anchor, value, side);
            // Moving straight to another anchor, its hover can come first:
            // only the anchor shown hides the bubble.
            else if (this._anchor === anchor)
                this.hide();
        });
    }

    show(anchor, text, side) {
        const parent = this.actor.get_parent();
        if (!parent || !anchor.mapped) {
            this.hide();
            return;
        }
        this._anchor = anchor;
        this.actor.text = text;
        const [x, y] = anchor.get_transformed_position();
        const [width, height] = anchor.get_transformed_size();
        // A long text wraps at maxWidth (scaled like the anchor's size).
        this.actor.width = -1;
        if (this._maxWidth) {
            const limit = this._maxWidth * St.ThemeContext.get_for_stage(global.stage).scale_factor;
            if (this.actor.get_preferred_width(-1)[1] > limit)
                this.actor.width = limit;
        }
        const labelWidth = this.actor.width > 0 ? this.actor.width : this.actor.get_preferred_width(-1)[1];
        const [, labelHeight] = this.actor.get_preferred_height(labelWidth);
        let [stageX, stageY] = [x, y + height];
        if (side === 'right')
            [stageX, stageY] = [x + width, y + (height - labelHeight) / 2];
        else if (side === 'above')
            stageY = y - labelHeight;
        const [, px, py] = parent.transform_stage_point(stageX, stageY);
        // Keep it inside the parent (the island clips its content).
        this.actor.set_position(
            Math.round(Math.max(0, Math.min(px, parent.width - labelWidth))),
            Math.round(Math.max(0, Math.min(py, parent.height - labelHeight))));
        this.actor.show();
    }

    hide() {
        this._anchor = null;
        this.actor.hide();
    }
}
