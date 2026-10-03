// SPDX-License-Identifier: GPL-3.0-or-later
// Calendar tab: the month grid (docs/features/calendar.md §B.4), drawn
// after GNOME's own (ui/calendar.js): six weeks, the week starting on
// GNOME's first weekday, weekday letters and month names from GNOME
// Shell's own translations, the optional ISO week column, today in the
// accent colour. Each day also shows up to three dots in the colours of
// the calendars with events that day, and the selected span is shaded.
//
//   ‹      October      ›
//   wk M  T  W  T  F  S  S
//   40 28 29 30  1 (2) 3  4
//
// Built once; update() changes texts, classes and dots in place, so the
// key focus stays where it is when events change.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {FALLBACK_COLOR} from './color.js';
import {MAX_DOTS} from './model.js';

const NC_ = (context, text) => `${context}\u0004${text}`;
// GNOME Shell's msgids (ui/calendar.js), translated by its own catalog.
const WEEKDAY_LETTERS = [
    NC_('grid sunday', 'S'),
    NC_('grid monday', 'M'),
    NC_('grid tuesday', 'T'),
    NC_('grid wednesday', 'W'),
    NC_('grid thursday', 'T'),
    NC_('grid friday', 'F'),
    NC_('grid saturday', 'S'),
];
// A week known to start on a Sunday: 2026-10-04.
const SUNDAY = {y: 2026, m: 10, d: 4};

const localTime = (date, hour = 12) => GLib.DateTime.new_local(date.y, date.m, date.d, hour, 0, 0);

/** The month's name as GNOME's calendar shows it: with its year unless it is this year's. */
export function monthLabel(month, thisYear, translate) {
    const format = month.y === thisYear ? '%OB' : '%OB %Y';
    return localTime({...month, d: 1}).format(translate(format)) ?? '';
}

export const MonthGrid = GObject.registerClass(
class MonthGrid extends St.BoxLayout {
    /**
     * @param {object} actions previous(), next(), today(), select(date)
     * @param {Function} translate GNOME Shell's time-string translation
     */
    _init(actions, translate) {
        super._init({
            style_class: 'froonty-calendar-grid',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });
        this._actions = actions;
        this._translate = translate;

        const header = new St.BoxLayout({style_class: 'froonty-calendar-grid-header'});
        this.previousButton = this._pager('pan-start-symbolic', _('Previous month'), () => actions.previous());
        this.monthButton = new St.Button({
            style_class: 'froonty-calendar-month-label',
            accessible_name: _('Go to today'),
            can_focus: true,
            track_hover: true,
            x_expand: true,
            label: '',
        });
        this.monthButton.connect('clicked', () => actions.today());
        this.nextButton = this._pager('pan-end-symbolic', _('Next month'), () => actions.next());
        header.add_child(this.previousButton);
        header.add_child(this.monthButton);
        header.add_child(this.nextButton);
        this.add_child(header);

        this._layout = new Clutter.GridLayout();
        this._table = new St.Widget({
            style_class: 'froonty-calendar-table',
            layout_manager: this._layout,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._table);

        this._corner = new St.Label({style_class: 'froonty-calendar-week-number'});
        this._layout.attach(this._corner, 0, 0, 1, 1);
        this._weekdays = [];
        for (let col = 0; col < 7; col++) {
            const label = new St.Label({
                style_class: 'froonty-calendar-weekday',
                x_align: Clutter.ActorAlign.CENTER,
            });
            this._layout.attach(label, col + 1, 0, 1, 1);
            this._weekdays.push(label);
        }
        this._weeks = [];
        /** The 42 day buttons, row by row. */
        this.cells = [];
        for (let row = 0; row < 6; row++) {
            const week = new St.Label({
                style_class: 'froonty-calendar-week-number',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._layout.attach(week, 0, row + 1, 1, 1);
            this._weeks.push(week);
            for (let col = 0; col < 7; col++) {
                const cell = new DayCell();
                cell.connect('clicked', () => {
                    if (cell.date)
                        actions.select(cell.date);
                });
                this._layout.attach(cell, col + 1, row + 1, 1, 1);
                this.cells.push(cell);
            }
        }

        // As GNOME's grid: the wheel goes through the months.
        this.connect('scroll-event', (_actor, event) => {
            switch (event.get_scroll_direction()) {
            case Clutter.ScrollDirection.UP:
            case Clutter.ScrollDirection.LEFT:
                actions.previous();
                return Clutter.EVENT_STOP;
            case Clutter.ScrollDirection.DOWN:
            case Clutter.ScrollDirection.RIGHT:
                actions.next();
                return Clutter.EVENT_STOP;
            default:
                return Clutter.EVENT_PROPAGATE;
            }
        });
    }

    _pager(iconName, name, onClick) {
        const button = new St.Button({
            style_class: 'froonty-icon-button froonty-calendar-pager',
            accessible_name: name,
            can_focus: true,
            track_hover: true,
            child: new St.Icon({icon_name: iconName}),
        });
        button.connect('clicked', onClick);
        return button;
    }

    /**
     * @param {object} grid CalendarService.grid()
     * @param {number} thisYear
     */
    update(grid, thisYear) {
        this.monthButton.label = monthLabel(grid.month, thisYear, this._translate);
        const rtl = this.get_text_direction() === Clutter.TextDirection.RTL;

        this._corner.visible = grid.showWeekNumbers;
        for (let col = 0; col < 7; col++) {
            const dow = (grid.weekStart + col) % 7;
            const label = this._weekdays[rtl ? 6 - col : col];
            label.text = this._translate(WEEKDAY_LETTERS[dow]);
            const date = GLib.DateTime.new_local(SUNDAY.y, SUNDAY.m, SUNDAY.d + dow, 12, 0, 0);
            label.accessible_name = date.format('%A');
        }

        grid.rows.forEach((row, r) => {
            const week = this._weeks[r];
            week.visible = grid.showWeekNumbers;
            week.text = String(row.week);
            week.accessible_name = _('Week %d').format(row.week);
            row.days.forEach((day, c) => this.cells[r * 7 + (rtl ? 6 - c : c)].update(day));
        });
    }

    /** The cell of a date, if shown. */
    cellOf(date) {
        return this.cells.find(cell => cell.date &&
            cell.date.y === date.y && cell.date.m === date.m && cell.date.d === date.d) ?? null;
    }
});

const DayCell = GObject.registerClass(
class DayCell extends St.Button {
    _init() {
        super._init({
            style_class: 'froonty-calendar-day',
            can_focus: true,
            track_hover: true,
        });
        /** The date shown, {y, m, d}. */
        this.date = null;
        const content = new St.Widget({layout_manager: new Clutter.BinLayout()});
        this._number = new St.Label({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        // A circle (today's is filled) with the number centred in it.
        content.add_child(new St.Bin({
            style_class: 'froonty-calendar-day-number',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
            child: this._number,
        }));
        this._dots = new St.BoxLayout({
            style_class: 'froonty-calendar-dots',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true,
        });
        for (let i = 0; i < MAX_DOTS; i++)
            this._dots.add_child(new St.Widget({style_class: 'froonty-calendar-dot', visible: false}));
        content.add_child(this._dots);
        this.set_child(content);
    }

    /** @param {object} day one day of CalendarService.grid() */
    update(day) {
        this.date = day.date;
        this._number.text = String(day.date.d);
        const classes = {
            'froonty-calendar-day-today': day.isToday,
            'froonty-calendar-day-selected': day.isSelected,
            'froonty-calendar-day-in-span': day.inSpan,
            'froonty-calendar-day-other-month': !day.inMonth,
            'froonty-calendar-day-weekend': day.isWeekend,
        };
        for (const [name, on] of Object.entries(classes)) {
            if (on)
                this.add_style_class_name(name);
            else
                this.remove_style_class_name(name);
        }
        this._dots.get_children().forEach((dot, i) => {
            const color = day.dots[i];
            dot.visible = i < day.dots.length;
            // Only sanitized hex (color.js) reaches the style.
            dot.style = dot.visible ? `background-color: ${color ?? FALLBACK_COLOR};` : null;
        });
        const date = localTime(day.date).format('%A %-d %B');
        this.accessible_name = day.count
            ? ngettext('%s, %d event', '%s, %d events', day.count).format(date, day.count)
            : date;
    }
});
