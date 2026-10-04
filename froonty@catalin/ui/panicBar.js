// SPDX-License-Identifier: GPL-3.0-or-later
// The panic bar: up to eight quick-action buttons in the hub's header row,
// chosen and ordered in Settings (panic-buttons). Unused slots are not shown.
// Two groups, on either side of the date pill (hubHeader.js places them):
// half on each side, the right one more when the count is odd (panicGroups,
// panic/catalog.js). Both groups are as wide as the wider one: the
// narrower spreads its buttons apart (PanicGroupLayout). Each button's name
// shows on hover.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {panicGroups, sanitize} from '../panic/catalog.js';
import {createPanicButton} from '../panic/registry.js';

const KEY = 'panic-buttons';

// A group's buttons in a row, the CSS spacing apart at their natural width.
// Given more room (the other group is wider), the gaps between the buttons
// grow; a lone button goes to the group's outer end, away from the date
// pill, so the two groups' outer edges mirror each other.
const PanicGroupLayout = GObject.registerClass(
class PanicGroupLayout extends Clutter.LayoutManager {
    /** @param {boolean} leading the group before the date pill */
    _init(leading) {
        super._init();
        this._leading = leading;
    }

    _spacing(container) {
        return container.get_stage() ? container.get_theme_node().get_length('spacing') : 0;
    }

    vfunc_get_preferred_width(container, _forHeight) {
        const shown = container.get_children().filter(a => a.visible);
        const natural = shown.reduce((sum, a) => sum + a.get_preferred_width(-1)[1], 0) +
            this._spacing(container) * Math.max(0, shown.length - 1);
        return [natural, natural];
    }

    vfunc_get_preferred_height(container, _forWidth) {
        let [min, natural] = [0, 0];
        for (const actor of container.get_children().filter(a => a.visible)) {
            const [m, n] = actor.get_preferred_height(-1);
            [min, natural] = [Math.max(min, m), Math.max(natural, n)];
        }
        return [min, natural];
    }

    vfunc_allocate(container, box) {
        const shown = container.get_children().filter(a => a.visible);
        const widths = shown.map(a => a.get_preferred_width(-1)[1]);
        const spacing = this._spacing(container);
        const natural = widths.reduce((sum, w) => sum + w, 0) + spacing * Math.max(0, shown.length - 1);
        const extra = Math.max(0, box.get_width() - natural);
        const rtl = container.get_text_direction() === Clutter.TextDirection.RTL;
        let gap = spacing;
        let x = 0; // from the group's leading edge
        if (shown.length > 1)
            gap += extra / (shown.length - 1);
        else if (!this._leading)
            x = extra;
        shown.forEach((actor, i) => {
            const w = widths[i];
            const [, h] = actor.get_preferred_height(w);
            const x1 = Math.round(rtl ? box.x2 - x - w : box.x1 + x);
            const y1 = Math.round(box.y1 + (box.get_height() - h) / 2);
            actor.allocate(new Clutter.ActorBox({x1, y1, x2: x1 + w, y2: y1 + h}));
            x += w + gap;
        });
    }
});

export class PanicBar {
    /**
     * @param {Gio.Settings} settings
     * @param {Tooltip} tooltip shows each button's name on hover
     * @param {object} actions passed to each button (panic/registry.js)
     */
    constructor(settings, tooltip, actions) {
        this._settings = settings;
        this._tooltip = tooltip;
        this._actions = actions;
        this._buttons = [];
        this._shown = false;
        // Hidden while empty: no spacing for nothing.
        this.groups = [true, false].map(leading => new St.Widget({
            style_class: 'froonty-panic-bar',
            layout_manager: new PanicGroupLayout(leading),
            visible: false,
        }));

        settings.connectObject(`changed::${KEY}`, () => this._rebuild(), this);
        this._rebuild();
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._destroyButtons();
        for (const group of this.groups)
            group.destroy();
    }

    /** Tells the buttons whether the hub is on screen. */
    setShown(shown) {
        this._shown = shown;
        for (const button of this._buttons)
            button.setActive?.(shown);
    }

    _rebuild() {
        this._tooltip.hide();
        this._destroyButtons();
        this._buttons = sanitize(this._settings.get_strv(KEY))
            .map(id => createPanicButton(id, this._actions)).filter(Boolean);
        panicGroups(this._buttons).forEach((buttons, i) => {
            for (const button of buttons) {
                this.groups[i].add_child(button.actor);
                this._tooltip.attach(button.actor, () => button.actor.accessible_name, 'below');
                button.setActive?.(this._shown);
            }
            this.groups[i].visible = buttons.length > 0;
        });
    }

    _destroyButtons() {
        for (const button of this._buttons)
            button.destroy();
        this._buttons = [];
    }
}
