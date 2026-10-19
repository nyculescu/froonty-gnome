// SPDX-License-Identifier: GPL-3.0-or-later
// The Break tab's 14-week chart (docs/features/break.md): a calendar
// heatmap of one metric, as GitHub's, from chartData.js's cells.
//
//          Aug            Sep             Oct
//    Mon  ▪ ▪ ▫ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪
//         ▪ ▪ ▪ ▪ ▪ ▪ ▪ □ ▪ ▪ ▪ ▪ ▪ ▪
//    Wed  ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪       columns: weeks, oldest left;
//         ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪       rows: Monday … Sunday;
//    Fri  ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪         the rest of this week
//         □ □ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪         is not drawn
//         □ □ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪
//                 □ no data   less ▫ ▪ ▪ ▪ ▪ more
//
// One hue, the CSS colour, stronger for a higher level; no "good" or "bad"
// colours (Froonty makes no health claims). A day with nothing is a faint
// square, a day without data an empty outline.
//
// A click selects a day; with the keyboard focus, Left/Right move by a
// week and Up/Down by a day. The selected day gets an outline, the
// caller's onSelect(day), and its text (the caller's describe(cell)) as
// the chart's accessible name. Repainted only when St asks.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {RATIO_METRICS, dayDate} from './chartData.js';

export {METRICS, cellText, chartCells} from './chartData.js';

// Level 1-4: the share of the CSS colour's alpha.
const ALPHAS = [0, 0.3, 0.5, 0.75, 1];
const MUTED = [1, 1, 1, 0.55];
const NOTHING = [1, 1, 1, 0.1];
const NO_DATA = [1, 1, 1, 0.25];
const FOCUS = [1, 1, 1, 0.55];
// Cells stop growing at this pitch (cell and gap), in logical pixels.
const MAX_PITCH = 24;
const LABELLED_ROWS = [0, 2, 4];

function roundedRect(cr, x, y, w, h, r) {
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, Math.PI * 3 / 2);
    cr.closePath();
}

// Columns where a month begins (by their Monday), for the labels on top;
// the first column too when the next label is 3 columns or more away.
function monthColumns(cells) {
    const mondays = cells.filter(c => c.row === 0);
    const starts = mondays.filter((c, i) => i > 0 && c.day.slice(0, 7) !== mondays[i - 1].day.slice(0, 7));
    if (mondays.length && (starts[0]?.col ?? Infinity) >= 3)
        starts.unshift(mondays[0]);
    return starts;
}

export const HistoryChart = GObject.registerClass(
class HistoryChart extends St.DrawingArea {
    /**
     * @param {object} params
     * @param {function(?string)} params.onSelect called with the day key
     *   ("YYYY-MM-DD") the user selected, or null when the selection left
     *   the chart
     * @param {function(object): string} params.describe the text of a cell
     *   (its accessible name while selected), e.g. by cellText()
     */
    _init({onSelect = null, describe = null} = {}) {
        super._init({
            style_class: 'froonty-break-chart',
            x_expand: true,
            reactive: true,
            can_focus: true,
        });
        this._onSelect = onSelect;
        this._describe = describe;
        this._data = null;
        this._selected = null;
        // Where the last repaint put the grid, for clicks.
        this._grid = null;

        // A gesture, as St.Button's on GNOME Shell 50: it wins over the
        // hub's own (an ancestor's).
        const click = new Clutter.ClickGesture({required_button: Clutter.BUTTON_PRIMARY});
        click.connect('recognize', () => {
            const point = click.get_coords_abs();
            const [, x, y] = this.transform_stage_point(point.x, point.y);
            const cell = this._cellAt(x, y);
            if (cell)
                this._select(cell.day);
        });
        this.add_action(click);
    }

    /** Shows chartCells()'s result; keeps the selected day while it is shown. */
    setData(result) {
        this._data = result;
        if (this._selected !== null && this._index(this._selected) === null) {
            this._selected = null;
            this._onSelect?.(null);
        }
        this._updateName();
        this.queue_repaint();
    }

    /** The selected day ("YYYY-MM-DD"), or null. */
    get selectedDay() {
        return this._selected;
    }

    /** Selects `day` (null: none) without calling onSelect. */
    select(day) {
        this._selected = day !== null && this._index(day) !== null ? day : null;
        this._updateName();
        this.queue_repaint();
    }

    // ------------------------------------------------------------ selection

    // The index of `day` among the cells, if shown (not in the future).
    _index(day) {
        const i = this._data?.cells.findIndex(c => c.day === day && !c.inFuture) ?? -1;
        return i >= 0 ? i : null;
    }

    // Today's cell: the last one not in the future.
    _todayIndex() {
        const cells = this._data?.cells ?? [];
        for (let i = cells.length - 1; i >= 0; i--) {
            if (!cells[i].inFuture)
                return i;
        }
        return null;
    }

    _select(day) {
        if (day === this._selected)
            return;
        this._selected = day;
        this._updateName();
        this.queue_repaint();
        this._onSelect?.(day);
    }

    _updateName() {
        const i = this._index(this._selected);
        if (i === null)
            return;
        const cell = this._data.cells[i];
        this.accessible_name = this._describe ? this._describe(cell) : cell.day;
    }

    _cellAt(x, y) {
        const g = this._grid;
        if (!g)
            return null;
        const col = Math.floor((x - g.left) / g.pitch);
        const row = Math.floor((y - g.top) / g.pitch);
        if (col < 0 || col >= g.weeks || row < 0 || row > 6)
            return null;
        const cell = this._data.cells[col * 7 + row];
        return cell && !cell.inFuture ? cell : null;
    }

    // ------------------------------------------------------------ events

    vfunc_key_focus_in() {
        super.vfunc_key_focus_in();
        // Focused, something is always selected: today, to begin with.
        if (this._index(this._selected) === null) {
            const today = this._todayIndex();
            if (today !== null)
                this._select(this._data.cells[today].day);
        }
        this.queue_repaint();
    }

    vfunc_key_focus_out() {
        super.vfunc_key_focus_out();
        this.queue_repaint();
    }

    vfunc_key_press_event(event) {
        // Cells are in day order: a week is 7 cells on.
        const step = {
            [Clutter.KEY_Left]: -7,
            [Clutter.KEY_Right]: 7,
            [Clutter.KEY_Up]: -1,
            [Clutter.KEY_Down]: 1,
        }[event.get_key_symbol()];
        const cells = this._data?.cells ?? [];
        if (!step || !cells.length)
            return super.vfunc_key_press_event(event);
        const from = this._index(this._selected);
        const to = from === null ? this._todayIndex() : from + step;
        if (to !== null && to >= 0 && to < cells.length && !cells[to].inFuture)
            this._select(cells[to].day);
        return Clutter.EVENT_STOP;
    }

    // ------------------------------------------------------------ paint

    vfunc_repaint() {
        const cr = this.get_context();
        // Logical pixels: St scales the context for HiDPI (as barLevel.js).
        const [width, height] = this.get_surface_size();
        this._grid = null;
        const cells = this._data?.cells ?? [];
        if (cells.length)
            this._paint(cr, width, height, cells);
        cr.$dispose();
    }

    _paint(cr, width, height, cells) {
        const node = this.get_theme_node();
        const font = node.get_font();
        const layout = t => {
            const l = PangoCairo.create_layout(cr);
            l.set_font_description(font);
            l.set_text(t, -1);
            const [, extents] = l.get_pixel_extents();
            return {l, w: extents.width, h: extents.height};
        };
        // anchor: 0 left, 1 right; y is the text's middle.
        const text = ({l, w, h}, x, y, anchor, rgba) => {
            cr.setSourceRGBA(...rgba);
            cr.moveTo(Math.round(x - anchor * w), Math.round(y - h / 2));
            PangoCairo.show_layout(cr, l);
        };

        const weeks = Math.ceil(cells.length / 7);
        const lineHeight = layout('0').h;
        const days = LABELLED_ROWS.map(row => layout(dayDate(cells[row].day).format('%a')));
        // Room around the grid for the focus ring (2 px, 3 px out).
        const left = Math.max(...days.map(d => d.w)) + 8;
        const top = lineHeight + 6;
        const pitch = Math.floor(Math.min(MAX_PITCH, (width - left - 5) / weeks,
            (height - top - lineHeight - 8) / 7));
        if (pitch < 4)
            return;
        const gap = Math.max(2, Math.round(pitch / 6));
        const size = pitch - gap;
        const radius = Math.min(2, size / 4);
        const gridWidth = weeks * pitch - gap;
        const gridHeight = 7 * pitch - gap;
        this._grid = {left, top, pitch, weeks};
        const X = col => left + col * pitch;
        const Y = row => top + row * pitch;

        // Weekday and month labels.
        LABELLED_ROWS.forEach((row, i) => text(days[i], left - 8, Y(row) + size / 2, 1, MUTED));
        let free = 0;
        for (const cell of monthColumns(cells)) {
            const label = layout(dayDate(cell.day).format('%b'));
            const x = X(cell.col);
            if (x < free || x + label.w > width)
                continue;
            text(label, x, lineHeight / 2, 0, MUTED);
            free = x + label.w + 6;
        }

        // The cells.
        const fg = node.get_foreground_color();
        const hue = [fg.red / 255, fg.green / 255, fg.blue / 255];
        const levelColor = level => (level ? [...hue, ALPHAS[level] * fg.alpha / 255] : NOTHING);
        cr.setLineWidth(1);
        for (const cell of cells) {
            if (cell.inFuture)
                continue;
            const [x, y] = [X(cell.col), Y(cell.row)];
            if (cell.value === null) {
                roundedRect(cr, x + 0.5, y + 0.5, size - 1, size - 1, radius);
                cr.setSourceRGBA(...NO_DATA);
                cr.stroke();
            } else {
                roundedRect(cr, x, y, size, size, radius);
                cr.setSourceRGBA(...levelColor(cell.level));
                cr.fill();
            }
        }

        cr.setLineWidth(2);
        const i = this._index(this._selected);
        if (i !== null) {
            const cell = cells[i];
            roundedRect(cr, X(cell.col) - 1, Y(cell.row) - 1, size + 2, size + 2, radius + 1);
            cr.setSourceRGBA(1, 1, 1, 1);
            cr.stroke();
        }
        if (this.has_key_focus()) {
            roundedRect(cr, left - 4, top - 4, gridWidth + 8, gridHeight + 8, 4);
            cr.setSourceRGBA(...FOCUS);
            cr.stroke();
        }

        this._paintLegend(cr, {layout, text, levelColor, right: left + gridWidth,
            y: top + gridHeight + 6 + lineHeight / 2, swatch: Math.min(size, lineHeight - 2)});
    }

    // Right-aligned under the grid: "□ no data   less ▫ ▪ ▪ ▪ ▪ more"
    // (0% … 100% for a share); the "no data" key only when it fits.
    _paintLegend(cr, {layout, text, levelColor, right, y, swatch}) {
        // Shares are levelled at 25/50/75%.
        const ratio = RATIO_METRICS.has(this._data.metric);
        const low = layout(ratio ? '0%' : _('less'));
        const high = layout(ratio ? '100%' : _('more'));
        const none = layout(_('no data'));
        const scale = low.w + 4 + 5 * (swatch + 3) + 1 + high.w;
        const key = swatch + 4 + none.w + 12;
        if (scale > right)
            return;
        const withKey = scale + key <= right;
        let x = right - scale - (withKey ? key : 0);
        if (withKey) {
            roundedRect(cr, x + 0.5, y - swatch / 2 + 0.5, swatch - 1, swatch - 1, 1.5);
            cr.setLineWidth(1);
            cr.setSourceRGBA(...NO_DATA);
            cr.stroke();
            text(none, x + swatch + 4, y, 0, MUTED);
            x += key;
        }
        text(low, x, y, 0, MUTED);
        x += low.w + 4;
        for (let level = 0; level <= 4; level++) {
            roundedRect(cr, x, y - swatch / 2, swatch, swatch, 1.5);
            cr.setSourceRGBA(...levelColor(level));
            cr.fill();
            x += swatch + 3;
        }
        text(high, x + 1, y, 0, MUTED);
    }
});
