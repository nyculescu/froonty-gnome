// SPDX-License-Identifier: GPL-3.0-or-later
// The Markets card: per symbol its last value and change, its name with
// the time and where the price is from, and a sparkline of the span. Used
// in the Widgets tab and on the desktop. A live price updates its row in
// place (the service's 'live', at most once a second).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {marketState, quotePageUrl} from './sources.js';

// The range's closes as a line, in the CSS colour (green up, red down),
// with the level the change is measured from dashed across it.
const Sparkline = GObject.registerClass(
class Sparkline extends St.DrawingArea {
    _init(reading) {
        super._init({style_class: 'froonty-markets-spark'});
        this._reading = reading;
    }

    set reading(reading) {
        this._reading = reading;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const {points, baseline} = this._reading;
        if (points.length >= 2) {
            const values = points.map(p => p.v);
            let min = Math.min(...values);
            let max = Math.max(...values);
            if (Number.isFinite(baseline)) {
                min = Math.min(min, baseline);
                max = Math.max(max, baseline);
            }
            const span = max - min || 1;
            const t0 = points[0].t;
            const tSpan = points.at(-1).t - t0 || 1;
            const pad = 2;
            const X = t => pad + (t - t0) / tSpan * (width - 2 * pad);
            const Y = v => pad + (max - v) / span * (height - 2 * pad);

            if (Number.isFinite(baseline)) {
                cr.setSourceRGBA(1, 1, 1, 0.25);
                cr.setLineWidth(1);
                cr.setDash([2, 2], 0);
                cr.moveTo(pad, Math.round(Y(baseline)) + 0.5);
                cr.lineTo(width - pad, Math.round(Y(baseline)) + 0.5);
                cr.stroke();
                cr.setDash([], 0);
            }

            cr.setSourceColor(this.get_theme_node().get_foreground_color());
            cr.setLineWidth(1.5);
            cr.setLineJoin(1); // Cairo.LineJoin.ROUND
            points.forEach((p, i) => (i ? cr.lineTo : cr.moveTo).call(cr, X(p.t), Y(p.v)));
            cr.stroke();
        }
        cr.$dispose();
    }
});

function formatNumber(value) {
    return value.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
}

function formatChange(percent) {
    if (!Number.isFinite(percent))
        return '';
    const sign = percent > 0 ? '+' : percent < 0 ? '−' : '';
    return `${sign}${Math.abs(percent).toFixed(2)}%`;
}

// When the value is from: the time for today's (with seconds for a live
// one), else the date; FRED's daily closes only have a date.
function formatTime(reading) {
    const time = GLib.DateTime.new_from_unix_local(Math.floor(reading.timeMs / 1000));
    const today = GLib.DateTime.new_now_local();
    if (reading.source !== 'fred' && time.get_ymd().join() === today.get_ymd().join())
        return time.format(reading.live ? '%H:%M:%S' : '%H:%M');
    return time.format('%b %e').replace('  ', ' ');
}

// Where the price is from: a live stream (reading.live), else the reading's source.
const SOURCE_LABELS = {
    alpaca: () => _('Alpaca live (IEX)'),
    coinbase: () => _('Coinbase live'),
    yahoo: () => _('Yahoo'),
    fred: () => _('FRED daily close'),
};

// The time, whether its market is open now (Yahoo's readings know their
// session, crypto is always open, FRED's daily closes say neither), and
// where the price is from.
function detailMarkup({reading, stale}) {
    const escape = text => GLib.markup_escape_text(text, -1);
    const parts = [escape(formatTime(reading))];
    const state = marketState(reading, Date.now());
    if (state === 'open')
        parts.push(`<span foreground="#57e389">${escape(_('Open'))}</span>`);
    else if (state === 'closed')
        parts.push(escape(_('Closed')));
    const source = reading.live || reading.source;
    parts.push(escape(SOURCE_LABELS[source]?.() ?? source));
    if (stale && !reading.live)
        parts.push(escape(_('not updated')));
    return parts.join(' · ');
}

const trendOf = reading => (reading?.changePercent > 0 ? 'up' : reading?.changePercent < 0 ? 'down' : '');

// What every row's percentage is measured from, said once in the header.
function changeSpan(range) {
    return {
        '1d': _('Change since yesterday’s close'),
        '5d': _('Change over 5 days'),
        '1mo': _('Change over 1 month'),
        '6mo': _('Change over 6 months'),
        '1y': _('Change over 1 year'),
    }[range] ?? '';
}

// Rows shown at once on the desktop card while it has no height of its
// own (placement.js); more scroll (owner's choice).
export const MAX_ROWS = 8;

// Caps its child (the list's scroll view) at the height of the list's
// first `rows` rows and the gaps between them, measured as laid out.
const RowsLayout = GObject.registerClass(
class RowsLayout extends Clutter.BinLayout {
    _init(list, rows) {
        super._init();
        this._list = list;
        this._rows = rows;
    }

    set rows(rows) {
        if (rows === this._rows)
            return;
        this._rows = rows;
        this.layout_changed();
    }

    vfunc_get_preferred_height(container, forWidth) {
        const child = container.get_first_child();
        if (!child)
            return [0, 0];
        const [min, nat] = child.get_preferred_height(forWidth);
        const rows = this._list.get_children().slice(0, this._rows);
        if (this._list.get_n_children() <= this._rows)
            return [min, nat];
        const gaps = this._list.layout_manager.spacing * (rows.length - 1);
        const cap = rows.reduce((sum, row) => sum + row.get_preferred_height(forWidth)[1], gaps);
        return [Math.min(min, cap), Math.min(nat, cap)];
    }
});

export class MarketsView {
    /**
     * @param {MarketsService} service
     * @param {object} [options]
     * @param {boolean} [options.scroll] true on the desktop: MAX_ROWS rows
     *   show, the rest scroll; the tab scrolls as a whole instead
     */
    constructor(service, {scroll = false} = {}) {
        this._service = service;
        // Whether a row opens its index's page (setActions).
        this._actions = true;
        this.actor = new St.BoxLayout({
            style_class: 'froonty-markets',
            vertical: true,
            x_expand: true,
            y_expand: scroll,
        });

        const header = new St.BoxLayout({style_class: 'froonty-widgets-header', x_expand: true});
        header.add_child(new St.Label({
            style_class: 'froonty-widgets-status',
            text: _('Markets'),
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._status = new St.Label({
            style_class: 'froonty-markets-status',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._status);
        this.actor.add_child(header);
        // Why a live stream is down; hidden while none is.
        this._problem = new St.Label({style_class: 'froonty-markets-problem', visible: false});
        this._problem.clutter_text.line_wrap = true;
        this.actor.add_child(this._problem);

        this._list = new St.BoxLayout({style_class: 'froonty-markets-list', vertical: true, x_expand: true});
        if (scroll) {
            this._rowsLayout = new RowsLayout(this._list, MAX_ROWS);
            const rows = new St.Widget({layout_manager: this._rowsLayout, x_expand: true, y_expand: true});
            rows.add_child(new St.ScrollView({
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: true,
                x_expand: true,
                y_expand: true,
                child: this._list,
            }));
            this.actor.add_child(rows);
        } else {
            this.actor.add_child(this._list);
        }

        // symbol -> the row's labels and graph, for live prices.
        this._parts = new Map();
        this._changedId = this._service.connect('changed', () => this._sync());
        this._liveId = this._service.connect('live', (_service, symbols) => this._syncLive(symbols));
        this._sync();
    }

    /**
     * Whether a click on a row opens its page. Off, the rows take no
     * pointer: the card still scrolls (the wheel reaches its scroll view).
     */
    setActions(on) {
        this._actions = on;
        for (const row of this._list.get_children()) {
            row.reactive = on;
            row.can_focus = on;
        }
    }

    /** On the desktop: MAX_ROWS rows, or with `limited` false as many as the card's height holds. */
    limitRows(limited) {
        if (this._rowsLayout)
            this._rowsLayout.rows = limited ? MAX_ROWS : Infinity;
    }

    destroy() {
        this._service.disconnect(this._changedId);
        this._service.disconnect(this._liveId);
        this.actor.destroy();
    }

    _sync() {
        const rows = this._service.rows;
        this._list.destroy_all_children();
        this._parts.clear();
        for (const row of rows)
            this._list.add_child(this._makeRow(row));

        const problem = this._service.liveProblem ?? '';
        this._problem.text = problem;
        this._problem.visible = Boolean(problem);

        // "Offline" only when every row failed and none has a live price.
        const errors = rows.filter(r => r.error && !r.reading?.live);
        if (this._service.refreshing)
            this._status.text = _('Updating…');
        else if (!rows.length)
            this._status.text = _('No symbols chosen');
        else if (errors.length === rows.length)
            this._status.text = _('Offline');
        else
            this._status.text = changeSpan(this._service.range);
    }

    // Only the rows whose price changed; a row without its graph yet (its
    // first reading) is made again with the rest.
    _syncLive(symbols) {
        const rows = new Map(this._service.rows.map(r => [r.symbol, r]));
        for (const symbol of symbols) {
            const row = rows.get(symbol);
            const parts = this._parts.get(symbol);
            if (!row?.reading || !parts?.spark) {
                this._sync();
                return;
            }
            const {reading} = row;
            const trend = trendOf(reading);
            parts.price.text = formatNumber(reading.price);
            parts.change.text = formatChange(reading.changePercent);
            for (const actor of [parts.change, parts.spark]) {
                actor.remove_style_class_name('up');
                actor.remove_style_class_name('down');
                if (trend)
                    actor.add_style_class_name(trend);
            }
            parts.detail.clutter_text.set_markup(detailMarkup(row));
            parts.spark.reading = reading;
        }
    }

    _makeRow(row) {
        const {symbol, reading, error} = row;
        const button = new St.Button({
            style_class: 'froonty-markets-row',
            reactive: this._actions,
            can_focus: this._actions,
            track_hover: true,
            x_expand: true,
        });
        button.connect('clicked', () => Gio.AppInfo.launch_default_for_uri(
            quotePageUrl(symbol), global.create_app_launch_context(0, -1)));
        const box = new St.BoxLayout({x_expand: true, style_class: 'froonty-markets-row-inner'});
        button.set_child(box);

        // Price, then name, then graph; the price column keeps its width
        // without a reading, so the names stay in line.
        const trend = trendOf(reading);
        const values = new St.BoxLayout({
            style_class: 'froonty-markets-values',
            vertical: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const price = new St.Label({
            style_class: 'froonty-markets-price',
            text: reading ? formatNumber(reading.price) : '—',
            x_align: Clutter.ActorAlign.START,
        });
        values.add_child(price);
        const change = new St.Label({
            style_class: `froonty-markets-change ${trend}`,
            text: reading ? formatChange(reading.changePercent) : '',
            x_align: Clutter.ActorAlign.START,
        });
        values.add_child(change);
        box.add_child(values);

        const names = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const name = new St.Label({
            style_class: 'froonty-markets-name',
            text: reading?.name ?? symbol,
        });
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        names.add_child(name);
        const detail = new St.Label({style_class: 'froonty-markets-detail'});
        detail.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        names.add_child(detail);
        box.add_child(names);

        if (!reading) {
            detail.text = error || _('Waiting for data');
            return button;
        }
        detail.clutter_text.set_markup(detailMarkup(row));

        const spark = new Sparkline(reading);
        if (trend)
            spark.add_style_class_name(trend);
        box.add_child(spark);
        this._parts.set(symbol, {price, change, detail, spark});
        return button;
    }
}
