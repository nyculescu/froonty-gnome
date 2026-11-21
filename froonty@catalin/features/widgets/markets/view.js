// SPDX-License-Identifier: GPL-3.0-or-later
// The Markets card: per index its name, a sparkline of the range, the last
// value and the change since the previous close. Used in the Widgets tab
// and on the desktop.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {quotePageUrl} from './sources.js';

// The range's closes as a line, in the CSS colour (green up, red down),
// with the previous close dashed when it falls inside the drawing.
const Sparkline = GObject.registerClass(
class Sparkline extends St.DrawingArea {
    _init(reading) {
        super._init({style_class: 'froonty-markets-spark'});
        this._reading = reading;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const {points, previousClose} = this._reading;
        if (points.length >= 2) {
            const values = points.map(p => p.v);
            let min = Math.min(...values);
            let max = Math.max(...values);
            if (Number.isFinite(previousClose)) {
                min = Math.min(min, previousClose);
                max = Math.max(max, previousClose);
            }
            const span = max - min || 1;
            const t0 = points[0].t;
            const tSpan = points.at(-1).t - t0 || 1;
            const pad = 2;
            const X = t => pad + (t - t0) / tSpan * (width - 2 * pad);
            const Y = v => pad + (max - v) / span * (height - 2 * pad);

            if (Number.isFinite(previousClose)) {
                cr.setSourceRGBA(1, 1, 1, 0.25);
                cr.setLineWidth(1);
                cr.setDash([2, 2], 0);
                cr.moveTo(pad, Math.round(Y(previousClose)) + 0.5);
                cr.lineTo(width - pad, Math.round(Y(previousClose)) + 0.5);
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

// When the value is from: the time for today's, else the date.
function formatTime(timeMs, source) {
    const time = GLib.DateTime.new_from_unix_local(Math.floor(timeMs / 1000));
    const today = GLib.DateTime.new_now_local();
    if (source === 'yahoo' && time.get_ymd().join() === today.get_ymd().join())
        return time.format('%H:%M');
    return time.format('%b %e').replace('  ', ' ');
}

export class MarketsView {
    constructor(service) {
        this._service = service;
        this.actor = new St.BoxLayout({
            style_class: 'froonty-markets',
            vertical: true,
            x_expand: true,
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

        this._list = new St.BoxLayout({style_class: 'froonty-markets-list', vertical: true, x_expand: true});
        this.actor.add_child(this._list);

        this._changedId = this._service.connect('changed', () => this._sync());
        this._sync();
    }

    destroy() {
        this._service.disconnect(this._changedId);
        this.actor.destroy();
    }

    _sync() {
        const rows = this._service.rows;
        this._list.destroy_all_children();
        for (const row of rows)
            this._list.add_child(this._makeRow(row));

        const errors = rows.filter(r => r.error);
        if (this._service.refreshing)
            this._status.text = _('Updating…');
        else if (!rows.length)
            this._status.text = _('No indexes chosen');
        else if (errors.length === rows.length)
            this._status.text = _('Offline');
        else
            this._status.text = '';
    }

    _makeRow({symbol, reading, error, stale}) {
        const button = new St.Button({
            style_class: 'froonty-markets-row',
            can_focus: true,
            track_hover: true,
            x_expand: true,
        });
        button.connect('clicked', () => Gio.AppInfo.launch_default_for_uri(
            quotePageUrl(symbol), global.create_app_launch_context(0, -1)));
        const box = new St.BoxLayout({x_expand: true, style_class: 'froonty-markets-row-inner'});
        button.set_child(box);

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

        const parts = [formatTime(reading.timeMs, reading.source)];
        if (reading.source === 'fred')
            parts.push(_('FRED daily close'));
        if (stale)
            parts.push(_('not updated'));
        detail.text = parts.join(' · ');

        const trend = reading.changePercent > 0 ? 'up' : reading.changePercent < 0 ? 'down' : '';
        const spark = new Sparkline(reading);
        if (trend)
            spark.add_style_class_name(trend);
        box.add_child(spark);

        const values = new St.BoxLayout({vertical: true, y_align: Clutter.ActorAlign.CENTER});
        values.add_child(new St.Label({
            style_class: 'froonty-markets-price',
            text: formatNumber(reading.price),
            x_align: Clutter.ActorAlign.END,
        }));
        const change = new St.Label({
            style_class: `froonty-markets-change ${trend}`,
            text: formatChange(reading.changePercent),
            x_align: Clutter.ActorAlign.END,
        });
        values.add_child(change);
        box.add_child(values);
        return button;
    }
}
