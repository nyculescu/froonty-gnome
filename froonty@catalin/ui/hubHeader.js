// SPDX-License-Identifier: GPL-3.0-or-later
// The hub's header row (HeaderLayout places its parts):
//
//   ……… [panic 1–4] (Sat Oct 3 14:05•) [panic 5–8] ………  [feature actions]
//
//   (date time)  a small pill with the date in the top bar clock's format
//        (the one under the island), the time as Froonty shows it, and
//        GNOME's unread dot after the time; a press closes the island and
//        opens GNOME's own calendar and notification menu (absent when
//        this Shell has no date menu). Its middle is always exactly over
//        GNOME's top bar clock, concealed under the island (Hub's
//        centre(): the island's middle shifted by the clock's offset).
//   panic 1–4, 5–8  the panic bar's two groups (panicBar.js), on either
//        side of the date pill: half each, the right one more when odd,
//        both as wide as the wider one (groupWidth()); without a date
//        pill they are centred together, as one group
//   feature actions  buttons a feature's view provides (`headerActions`),
//        shown only while its tab is the active one, at the row's right
//        end; e.g. Notes' "All notes"
//
// Keyboard order follows the row: panic 1–4, the date pill, panic 5–8,
// the feature's actions. The hub makes the island wide enough (Hub.minWidth)
// for both halves around the clock's place, PANIC_GAP clear of the side
// column and the feature's actions.
//
// The view owns its action buttons and destroys them; the header only
// places them, gives them the icon-button tooltip, and shows the active
// feature's.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// Room kept between the centred parts (the date pill and the panic
// groups) and the row's start (the side column) or the feature's actions
// (logical px).
export const PANIC_GAP = 8;

// Places the header's parts in one pass: the date pill centred on the
// point centre() gives (the island's middle), the panic groups beside it,
// the feature's actions at the row's end. Mirrored right to left. Its
// minimum width is 0: the island makes the room (Hub.minWidth), not the
// row; while the island animates open, the parts may cross.
const HeaderLayout = GObject.registerClass(
class HeaderLayout extends Clutter.LayoutManager {
    /**
     * @param {HubHeader} header
     * @param {Function} centre → x of the island's middle, from the row's
     *   left edge (logical px of the stage)
     */
    _init(header, centre) {
        super._init();
        this._header = header;
        this._centre = centre;
    }

    vfunc_get_preferred_width(container, _forHeight) {
        const shown = container.get_children().filter(a => a.visible);
        const sum = shown.reduce((total, a) => total + a.get_preferred_width(-1)[1], 0);
        return [0, sum + this._header.spacing * Math.max(0, shown.length - 1)];
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
        const rtl = container.get_text_direction() === Clutter.TextDirection.RTL;
        const width = box.get_width();
        // x: from the row's leading edge (the left one, unless mirrored).
        const place = (actor, x, forced) => {
            const w = forced ?? actor.get_preferred_width(-1)[1];
            const [, h] = actor.get_preferred_height(w);
            const x1 = Math.round(rtl ? box.x2 - x - w : box.x1 + x);
            const y1 = Math.round(box.y1 + (box.get_height() - h) / 2);
            actor.allocate(new Clutter.ActorBox({x1, y1, x2: x1 + w, y2: y1 + h}));
            return w;
        };
        // Always on centre() (Hub.minWidth makes the island wide enough).
        // Both panic groups take the wider one's width (groupWidth()); the
        // narrower spreads its buttons (PanicGroupLayout, panicBar.js).
        const actions = this._header.actions;
        const centre = this._centre();
        const [before] = this._header.halves();
        const groupWidth = this._header.groupWidth();
        let x = (rtl ? width - centre : centre) - before;
        for (const actor of this._header.centred.filter(a => a.visible)) {
            const forced = actor === this._header.calendarButton ? undefined : groupWidth;
            x += place(actor, x, forced) + this._header.spacing;
        }
        if (actions.visible)
            place(actions, width - actions.get_preferred_width(-1)[1]);
    }
});

export class HubHeader {
    /**
     * @param {Tooltip} tooltip the hub's tooltip (its overlay layer)
     * @param {object} parts
     * @param {ClockService} parts.clock the date and time on the pill
     * @param {?Function} parts.openCalendar null: no date pill
     * @param {St.Widget[]} parts.panic the panic bar's two groups: left
     *   of the date pill, right of it
     * @param {Function} parts.centre → x of the island's middle, from the
     *   row's left edge
     */
    constructor(tooltip, {clock, openCalendar, panic, centre}) {
        this._tooltip = tooltip;
        this._clock = clock;
        this._boxes = new Map(); // feature id → box of its actions
        this._unread = false;
        this.calendarButton = null;
        this.unreadBadge = null;

        this.actor = new St.Widget({
            style_class: 'froonty-hub-header',
            layout_manager: new HeaderLayout(this, centre),
            x_expand: true,
        });

        if (openCalendar) {
            this.calendarButton = this._buildCalendarButton();
            this.calendarButton.connect('clicked', () => openCalendar());
            // The top bar clock's ticks; no timer of its own.
            this._clock.connectObject('changed', () => this._syncClock(), this);
            this._syncClock();
        }
        // In the row's order (the keyboard's): left group, pill, right group.
        this.centred = [panic[0], this.calendarButton, panic[1]].filter(Boolean);
        for (const actor of this.centred)
            this.actor.add_child(actor);

        // Hidden while it holds nothing to show.
        this.actions = new St.BoxLayout({
            style_class: 'froonty-hub-feature-actions',
            visible: false,
        });
        this.actor.add_child(this.actions);
    }

    /** Stops following the clock (the hub destroys the actors). */
    destroy() {
        this._clock.disconnectObject(this);
    }

    /** The row's spacing (stage px; on stage only). */
    get spacing() {
        return this.actor.get_theme_node().get_length('spacing');
    }

    /**
     * How far the centred parts reach from the island's middle (stage px,
     * natural widths): [before it, after it]. The date pill's middle is
     * the island's; without a pill, the groups' middle is.
     */
    /**
     * The width both panic groups take: the wider one's natural width, so
     * the two sides of the date pill match (the narrower one spreads its
     * buttons out).
     */
    groupWidth() {
        return Math.max(0, ...this.centred.filter(a => a.visible && a !== this.calendarButton)
            .map(a => a.get_preferred_width(-1)[1]));
    }

    halves() {
        const width = actor => (actor?.visible ? actor.get_preferred_width(-1)[1] : 0);
        const group = this.groupWidth();
        const [start, end] = [this.centred[0], this.centred.at(-1)]
            .map(actor => (actor?.visible ? group : 0));
        const pill = width(this.calendarButton);
        const spacing = this.spacing;
        if (!pill) {
            const total = start + end + (start && end ? spacing : 0);
            return [total / 2, total / 2];
        }
        return [(start ? start + spacing : 0) + pill / 2, pill / 2 + (end ? spacing + end : 0)];
    }

    /**
     * Places a feature's action buttons (hidden until showActions(id)).
     *
     * @param {string} id feature id
     * @param {St.Widget[]} widgets owned by the feature's view; each needs
     *   track_hover and an accessible_name (its tooltip)
     */
    addActions(id, widgets) {
        if (!widgets.length || this._boxes.has(id))
            return;
        const box = new St.BoxLayout({
            style_class: 'froonty-hub-feature-actions',
            visible: false,
        });
        for (const widget of widgets) {
            widget.add_style_class_name('froonty-feature-action');
            this._tooltip.attach(widget, () => widget.accessible_name, 'below');
            box.add_child(widget);
        }
        this.actions.add_child(box);
        this._boxes.set(id, box);
    }

    /**
     * Shows that feature's actions, hides every other feature's.
     *
     * @param {?string} id null: none (no tab is on)
     */
    showActions(id) {
        for (const [key, box] of this._boxes)
            box.visible = key === id;
        this.actions.visible = this._boxes.has(id);
    }

    /** The feature is gone (its view destroyed its buttons already). */
    removeActions(id) {
        const box = this._boxes.get(id);
        if (!box)
            return;
        this._boxes.delete(id);
        if (box.visible)
            this.actions.visible = false;
        box.destroy();
    }

    /** @param {boolean} unread whether GNOME's clock would show its dot */
    setUnread(unread) {
        this._unread = unread;
        if (!this.calendarButton)
            return;
        this.unreadBadge.visible = unread;
        this._syncName();
    }

    // The pill, in the collapsed pill's style: the date as the top bar
    // clock writes it (weekday, month and day: ClockService.snapshot().date),
    // always (there is room here; "Show date when collapsed" is the
    // collapsed pill's), the time as the collapsed pill shows it (12/24-hour
    // as set in Froonty), and GNOME's unread dot after the time. A press
    // opens GNOME's own calendar and notification menu, which the island
    // covers; the island closes as it opens (Island._openCalendar).
    _buildCalendarButton() {
        const row = new St.BoxLayout({
            style_class: 'froonty-header-clock-row',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._dateLabel = new St.Label({
            style_class: 'froonty-header-clock-date',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._timeLabel = new St.Label({
            style_class: 'froonty-header-clock-time',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.unreadBadge = new St.Widget({
            style_class: 'froonty-unread-dot',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        row.add_child(this._dateLabel);
        row.add_child(this._timeLabel);
        row.add_child(this.unreadBadge);

        const button = new St.Button({
            style_class: 'froonty-header-clock',
            y_align: Clutter.ActorAlign.CENTER,
            can_focus: true,
            track_hover: true,
            child: row,
        });
        // What a press does; the pill itself shows the date and time.
        this._tooltip.attach(button, () => _('Calendar and notifications'), 'below');
        return button;
    }

    _syncClock() {
        const clock = this._clock.snapshot();
        this._dateLabel.text = clock.date;
        this._timeLabel.text = clock.time;
        this._syncName(clock);
    }

    // "Calendar and notifications, Saturday, October 3 2026, 14:05", and
    // ", unread notifications" while the dot shows.
    _syncName(clock = this._clock.snapshot()) {
        let name = [_('Calendar and notifications'), clock.weekday, clock.longDate, clock.time]
            .join(', ');
        if (this._unread)
            name = `${name}, ${_('unread notifications')}`;
        this.calendarButton.accessible_name = name;
    }
}
