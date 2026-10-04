// SPDX-License-Identifier: GPL-3.0-or-later
// Children in rows that wrap at the container's width, each at its natural
// size (the Formulas tab's symbol and template buttons), apart by the
// container's CSS spacing (an St.Widget's). Clutter's own
// FlowLayout gave a section of several rows the height of one when it sat
// in a scrolled box, so its rows overlapped.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

export const WrapLayout = GObject.registerClass(
class WrapLayout extends Clutter.LayoutManager {
    _spacing(container) {
        return container.peek_theme_node?.()?.get_length('spacing') ?? 0;
    }

    // Places the visible children in rows of at most `width`: each one's
    // [x, y, width, height], and the total height.
    _rows(container, width) {
        const spacing = this._spacing(container);
        const places = [];
        let x = 0, y = 0, rowHeight = 0;
        for (const child of container.get_children()) {
            if (!child.visible)
                continue;
            const [, w] = child.get_preferred_width(-1);
            const [, h] = child.get_preferred_height(w);
            if (x > 0 && width >= 0 && x + w > width) {
                x = 0;
                y += rowHeight + spacing;
                rowHeight = 0;
            }
            places.push([child, x, y, w, h]);
            x += w + spacing;
            rowHeight = Math.max(rowHeight, h);
        }
        return {places, height: places.length ? y + rowHeight : 0};
    }

    vfunc_get_preferred_width(container, _forHeight) {
        let min = 0, natural = 0, n = 0;
        for (const child of container.get_children()) {
            if (!child.visible)
                continue;
            const [childMin, childNatural] = child.get_preferred_width(-1);
            min = Math.max(min, childMin);
            natural += childNatural;
            n++;
        }
        return [min, natural + Math.max(0, n - 1) * this._spacing(container)];
    }

    vfunc_get_preferred_height(container, forWidth) {
        const {height} = this._rows(container, forWidth);
        return [height, height];
    }

    vfunc_allocate(container, box) {
        const {places} = this._rows(container, box.get_width());
        for (const [child, x, y, w, h] of places) {
            child.allocate(new Clutter.ActorBox({
                x1: box.x1 + x, y1: box.y1 + y, x2: box.x1 + x + w, y2: box.y1 + y + h,
            }));
        }
    }
});
