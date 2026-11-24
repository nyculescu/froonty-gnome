// SPDX-License-Identifier: GPL-3.0-or-later
// A wrapping label held to a number of lines, cut with "…".

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

// Caps its child's height at `lines` times one line's (the child measured
// without a width), as GNOME's notifications do (ui/messageList.js); a
// wrapping, ellipsizing Clutter.Text then cuts at the last line that fits.
// The capped height is the minimum too: a scroll view's content gets its
// minimum, and an ellipsizing label's own minimum is one line.
const LinesLayout = GObject.registerClass(
class LinesLayout extends Clutter.BinLayout {
    _init(lines) {
        super._init();
        this._lines = lines;
    }

    vfunc_get_preferred_height(container, forWidth) {
        const child = container.get_first_child();
        if (!child)
            return [0, 0];
        const [, line] = child.get_preferred_height(-1);
        const [, nat] = child.get_preferred_height(forWidth);
        const height = Math.min(nat, line * this._lines);
        return [height, height];
    }
});

/**
 * @param {object} params St.Label properties
 * @param {number} lines at most this many lines are shown
 * @returns {{box: St.Widget, label: St.Label}} add `box`; set `label.text`
 */
export function linesLabel(params, lines) {
    const label = new St.Label({x_expand: true, ...params});
    label.clutter_text.set({
        line_wrap: true,
        line_wrap_mode: Pango.WrapMode.WORD_CHAR,
        ellipsize: Pango.EllipsizeMode.END,
    });
    const box = new St.Widget({layout_manager: new LinesLayout(lines), x_expand: true});
    box.add_child(label);
    return {box, label};
}
