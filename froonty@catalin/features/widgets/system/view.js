// SPDX-License-Identifier: GPL-3.0-or-later
// The System card (Btop's readings) on the desktop: per chosen metric its
// value now, its name with its low and high over the period, and a graph
// of them, in the order Settings sets; the graph takes the width left. It
// owns its sampling, which runs only while the card exists.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {lineRuns, timeColumns} from './line.js';
import {layoutParts, movingAverage} from './metrics.js';
import {SystemHistoryService} from './service.js';

// The period, right edge now, its readings or their moving average; a
// pause of more than this many sampling intervals (a lock, a suspend)
// breaks the line.
const GAP_INTERVALS = 3;
// The moving average's line, over the readings (GNOME's orange).
const AVERAGE_RGBA = [1, 0.639, 0.282, 1];
// The least a graph and a name keep when the card is narrow.
const GRAPH_MIN = 60;
const NAME_MIN = 40;

const HistoryGraph = GObject.registerClass(
class HistoryGraph extends St.DrawingArea {
    _init(metric, service) {
        super._init({style_class: 'froonty-system-graph', x_expand: true});
        this._metric = metric;
        this._service = service;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const raw = this._service.history(this._metric.id)?.points ?? [];
        if (raw.length) {
            const now = Date.now();
            const pad = 2;
            const period = this._service.periodMs;
            const X = t => pad + (t - (now - period)) / period * (width - 2 * pad);
            const gap = GAP_INTERVALS * this._service.interval * 1000;
            // In device pixels, so a scaled screen keeps its detail.
            const scale = this.get_resource_scale() || 1;
            const columnOf = timeColumns(period, (width - 2 * pad) * scale);
            const runsOf = points => lineRuns(points, columnOf, gap);
            const readings = runsOf(raw);
            const averaged = this._service.averageMs > 0
                ? runsOf(movingAverage(raw, this._service.averageMs)) : null;
            // Every scale reads only the low and the high, which the runs keep.
            const [min, max] = this._metric.scale(readings.flatMap(run => run.map(p => p.v)));
            const span = max - min || 1;
            const Y = v => pad + (max - Math.min(max, Math.max(min, v))) / span * (height - 2 * pad);
            const line = runs => {
                for (const run of runs) {
                    run.forEach((p, i) => {
                        if (i === 0)
                            cr.moveTo(X(p.t), Y(p.v));
                        else
                            cr.lineTo(X(p.t), Y(p.v));
                    });
                }
                // The period's only reading is a dot.
                if (raw.length === 1)
                    cr.arc(X(raw[0].t), Y(raw[0].v), 1.5, 0, 2 * Math.PI);
                cr.stroke();
            };

            cr.setSourceRGBA(1, 1, 1, 0.12);
            cr.setLineWidth(1);
            cr.moveTo(pad, height - pad - 0.5);
            cr.lineTo(width - pad, height - pad - 0.5);
            cr.stroke();

            cr.setLineJoin(1); // Cairo.LineJoin.ROUND
            cr.setSourceColor(this.get_theme_node().get_foreground_color());
            cr.setLineWidth(1.5);
            line(readings);
            // The moving average in front (owner's choice): the trend
            // stays visible through the readings' swings.
            if (averaged) {
                cr.setSourceRGBA(...AVERAGE_RGBA);
                cr.setLineWidth(1.5);
                line(averaged);
            }
        }
        cr.$dispose();
    }
});

function setValue(label, value, previous) {
    label.text = value?.text ?? '–';
    const style = value?.color ? `color: ${value.color};` : null;
    if (label.style !== style)
        label.style = style;
    const styleClass = value?.styleClass ?? null;
    // Removing and adding a class restyles the label each time.
    if (styleClass !== previous) {
        if (previous)
            label.remove_style_class_name(previous);
        if (styleClass)
            label.add_style_class_name(styleClass);
    }
    return styleClass;
}

// The padding and borders around a widget's content (on stage).
function insets(widget) {
    const node = widget.get_theme_node();
    return node.get_horizontal_padding() +
        node.get_border_width(St.Side.LEFT) + node.get_border_width(St.Side.RIGHT);
}

// Measured from its text: set_width fixes the label's own preferred width.
function labelWidth(label) {
    return Math.ceil(label.clutter_text.get_preferred_width(-1)[1] + insets(label));
}

export class SystemView {
    /** @param {Gio.Settings} settings */
    constructor(settings) {
        this._service = new SystemHistoryService(settings);
        this._rows = [];
        this._shown = '';
        this.actor = new St.BoxLayout({style_class: 'froonty-system', vertical: true, x_expand: true});

        const header = new St.BoxLayout({style_class: 'froonty-widgets-header', x_expand: true});
        header.add_child(new St.Label({
            style_class: 'froonty-widgets-status',
            text: _('System'),
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._status = new St.Label({
            style_class: 'froonty-system-status',
            text: '',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._status);
        this.actor.add_child(header);

        // A row per reading; its parts are lined up as columns by giving
        // every row's value and name the same width (_alignColumns), the
        // graph taking the rest. Scrolls when the card is given less height
        // than its rows need.
        this._list = new St.BoxLayout({style_class: 'froonty-system-list', vertical: true, x_expand: true});
        // Out of the allocation that changed it. A font or theme change
        // resizes the texts without changing them.
        this._alignId = 0;
        const queueAlign = () => {
            this._alignId ||= GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._alignId = 0;
                this._alignColumns();
                return GLib.SOURCE_REMOVE;
            });
        };
        this._list.connect('notify::width', queueAlign);
        this._list.connect('style-changed', queueAlign);
        // The texts the columns were measured for, and the widths set.
        this._aligned = null;
        this._widths = null;
        this.actor.add_child(new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            child: this._list,
        }));

        this._changedId = this._service.connect('changed', () => this._sync());
        this._sync();
        this._service.setActive(true);
    }

    destroy() {
        this._service.disconnect(this._changedId);
        this._service.stop();
        this.actor.destroy();
        // After the actor: taking it down may restyle the list, which queues one.
        if (this._alignId)
            GLib.source_remove(this._alignId);
        this._alignId = 0;
    }

    _sync() {
        const metrics = this._service.metrics;
        const shown = `${metrics.map(metric => metric.id).join()} ${this._service.layout}`;
        if (shown !== this._shown) {
            this._shown = shown;
            this._list.destroy_all_children();
            this._rows = metrics.map(metric => this._makeRow(metric));
            this._aligned = null;
            this._widths = null;
        }
        this._status.text = metrics.length ? this._period() : _('No readings chosen');
        const snapshot = this._service.snapshot;
        for (const row of this._rows) {
            const now = snapshot ? row.metric.value(snapshot) : null;
            const known = typeof now === 'number' && Number.isFinite(now);
            row.styleClass = setValue(row.value, known ? row.metric.format(now) : null, row.styleClass);
            const range = this._service.history(row.metric.id)?.range();
            row.detail.text = range
                ? `${row.metric.format(range.min).text} – ${row.metric.format(range.max).text}`
                : _('Waiting for readings');
            row.graph.queue_repaint();
        }
        // Measured again only for new texts; a new width or style queues it too.
        if (this._columnTexts() !== this._aligned)
            this._alignColumns();
    }

    _columnTexts() {
        return this._rows.map(row => `${row.value.text}\n${row.name.text}\n${row.detail.text}`).join('\n');
    }

    // Every value as wide as the widest, every name as wide as the widest
    // (less if the card is too narrow for it), so the parts line up from
    // row to row and the last one ends at the card's edge.
    _alignColumns() {
        // The last allocation: while a relayout is pending, `width` is the
        // natural width, which the widths set last time decide.
        const box = this._list.allocation;
        // On the stage and laid out; notify::width or the next sample brings it back.
        if (!this._rows.length || !this._list.get_stage() || box.get_width() <= 0)
            return;
        const values = Math.max(...this._rows.map(row => labelWidth(row.value)));
        // The names' box is measured by its labels, whose widths are never set.
        const names = Math.max(...this._rows.map(row => Math.ceil(insets(row.names) + Math.max(
            row.name.get_preferred_width(-1)[1], row.detail.get_preferred_width(-1)[1]))));
        const row = this._rows[0].box;
        const node = row.get_theme_node();
        const inner = box.get_width() - this._list.get_theme_node().get_horizontal_padding();
        const room = inner - values - GRAPH_MIN - 2 * node.get_length('spacing');
        const nameWidth = Math.max(NAME_MIN, Math.min(names, room));
        this._aligned = this._columnTexts();
        if (this._widths?.values === values && this._widths.names === nameWidth)
            return;
        this._widths = {values, names: nameWidth};
        for (const {value: v, names: n} of this._rows) {
            v.set_width(values);
            n.set_width(nameWidth);
        }
    }

    // "Last 30 minutes", and the average's window when there is one.
    _period() {
        const minutes = Math.round(this._service.periodMs / 60000);
        const period = minutes % 60 === 0 && minutes >= 60
            ? _('Last %d h').replace('%d', String(minutes / 60))
            : _('Last %d min').replace('%d', String(minutes));
        const average = this._service.averageMs / 1000;
        if (!average)
            return period;
        const window = average < 60 ? `${average} s` : `${average / 60} min`;
        return _('%s · %s average').replace('%s', period).replace('%s', window);
    }

    _makeRow(metric) {
        const box = new St.BoxLayout({style_class: 'froonty-system-row', x_expand: true});
        const value = new St.Label({
            style_class: 'froonty-system-value',
            text: '–',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const names = new St.BoxLayout({vertical: true, y_align: Clutter.ActorAlign.CENTER});
        const name = new St.Label({style_class: 'froonty-system-name', text: metric.title(_)});
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        names.add_child(name);
        const detail = new St.Label({style_class: 'froonty-system-detail'});
        detail.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        names.add_child(detail);

        const graph = new HistoryGraph(metric, this._service);
        const parts = {value, name: names, graph};
        for (const part of layoutParts(this._service.layout))
            box.add_child(parts[part]);
        this._list.add_child(box);
        return {metric, box, value, names, name, detail, graph, styleClass: null};
    }
}
