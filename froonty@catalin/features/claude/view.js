// SPDX-License-Identifier: GPL-3.0-or-later
// Claude tab: the plan's usage limits, as in Claude's Settings → Usage.
//
//   Weekly                               33%
//   ███████████░░░░░░░░░░░░░░░░░░░░░░░░░░░
//   Resets Sat 22:59
//   Weekly Fable                         18%
//   ██████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
//   Resets Sat 22:59
//   • Fable 5.2  • Opus 5.5 Updated 2 min ago
//                       •─• 84.6%   ┆90%   (livenerf's chart, its last
//   ░░░░       •╮      ╭• 70.1%     ┆70%   30 days: daily score, 95%
//   ░•─•─•─•─•─╰•─•─•─╯             ┆50%   interval, baseline shaded;
//   Sep 24     Oct 15     Nov 05             it scrolls back)
//   Δ +0.014 ± 0.025, days 41–50: no change · livenerf, updated Fri 10:31
//
// Claude's servers may also send Session, more per-model rows and Cloud
// session credits; each gets a row like these.
//
// The last row is livenerf's (livenerf.js): its chart, redrawn here,
// without a heading; once livenerf publishes a Δ, the line under it gives
// the Δ and livenerf's decision. Without the chart (offline, or not read
// yet), a heading "Opus 5.5 vs launch week" over a bar instead.
// A row older than an hour (one only Claude Code's cache has, while the
// status line keeps Session and Weekly current) is dimmed, its line ending
// "· checked 3 h ago". In low power the footer says only the status line
// brings in new numbers.
// Offline, every value reads "Unknown" and a line says why (user request).
// Renders ClaudeService state; re-renders on its changes and on the shared
// clock's minute tick, for "Resets in" and "Updated … ago".

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {recentSpan} from './livenerf.js';
import {
    CREDITS, MODEL, SESSION, STALE_MS, WEEKLY, describeReset, fillFraction, minutesSince,
} from './usage.js';

// Beyond this, a reset shows its date, not only its weekday.
const DATED_RESET_MS = 6 * 24 * 3600 * 1000;

// A row over an hour old, of 255.
const STALE_OPACITY = 140;

// Rows shown as "Unknown" offline before any reading was ever made: the
// plan's two weekly limits.
const DEFAULT_WINDOWS = [
    {id: WEEKLY, kind: WEEKLY, model: null},
    {id: 'fable', kind: MODEL, model: 'Fable'},
];

export class ClaudeView {
    constructor(ctx, service) {
        this._service = service;
        this._clock = ctx.clock;

        this.actor = new St.BoxLayout({
            style_class: 'froonty-claude',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });

        this._rows = new St.BoxLayout({
            style_class: 'froonty-claude-rows',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            child: this._rows,
        });
        this._notice = wrappingLabel('froonty-claude-notice');
        this._empty = new St.BoxLayout({
            style_class: 'froonty-claude-empty',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._emptyTitle = wrappingLabel('froonty-claude-empty-title');
        this._emptyHint = wrappingLabel('froonty-claude-empty-hint');
        this._empty.add_child(this._emptyTitle);
        this._empty.add_child(this._emptyHint);
        this._footer = wrappingLabel('froonty-claude-footer');
        this._footer.x_align = Clutter.ActorAlign.END;
        this._footer.y_align = Clutter.ActorAlign.CENTER;
        this._footer.clutter_text.line_alignment = Pango.Alignment.RIGHT;
        // The footer shares its line with the chart's legend, on its left
        // (user request).
        this._legend = new St.BoxLayout({
            style_class: 'froonty-claude-legend',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._footerLine = new St.BoxLayout({style_class: 'froonty-claude-footer-line', x_expand: true});
        this._footerLine.add_child(this._legend);
        this._footerLine.add_child(this._footer);
        this._benchmark = new St.BoxLayout({
            style_class: 'froonty-claude-benchmark',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        // Takes the spare height while livenerf's row, whose chart
        // otherwise takes it, is hidden.
        this._spacer = new St.Widget({y_expand: true});

        this.actor.add_child(this._scroll);
        this.actor.add_child(this._empty);
        this.actor.add_child(this._footerLine);
        this.actor.add_child(this._benchmark);
        this.actor.add_child(this._spacer);
        this.actor.add_child(this._notice);

        // How far back the chart is scrolled, kept while its reading is.
        this._chartScroll = {offset: 0};
        this._scrolledChart = null;

        this._active = false;
        this._serviceId = this._service.connect('changed', () => this._sync());
        // The minute tick runs while the island is collapsed too; only
        // re-render for it while the tab is on screen.
        this._clock.connectObject('changed', () => this._active && this._sync(), this);
        this._sync();
    }

    setActive(active) {
        this._active = active;
        if (active)
            this._sync();
    }

    destroy() {
        this._service.disconnect(this._serviceId);
        this._clock.disconnectObject(this);
        this.actor.destroy();
    }

    _sync() {
        const {usage, online, error, loaded} = this._service;
        const now = Date.now();

        this._notice.visible = !online;
        this._notice.text = _('No internet connection: Claude cannot be asked for these details.');

        let windows = usage?.windows ?? [];
        if (!online && !windows.length)
            windows = DEFAULT_WINDOWS;

        this._rows.destroy_all_children();
        for (const window of windows)
            this._rows.add_child(this._row(window, online, now));

        // Before the first read, nothing: no hint flashing up for a moment.
        const empty = windows.length === 0;
        this._scroll.visible = !empty;
        this._empty.visible = empty && loaded;

        this._emptyTitle.text = _('No plan usage from Claude Code yet');
        this._emptyHint.text = error === 'unreadable'
            ? _('Claude Code’s settings file could not be read.')
            : _('It appears once Claude Code, signed in with a Claude plan, checks your usage.');

        this._footer.visible = online && Boolean(usage);
        if (usage) {
            const mode = modeText(this._service.refreshMode);
            const updated = this._updatedText(usage.fetchedAt, now);
            this._footer.text = mode ? `${updated} · ${mode}` : updated;
        }

        this._syncBenchmark(online);
        this._footerLine.visible = this._footer.visible || this._legend.visible;
    }

    _row(window, online, now) {
        const reset = online ? describeReset(window.resetsAt, now) : {kind: 'unknown'};
        // After a renewal, what was used since is not known either.
        const known = online && reset.kind !== 'renewed';
        const bar = new UsageBar(known ? fillFraction(window.percent) : 0);
        if (known && isCritical(window))
            bar.add_style_class_name('froonty-claude-bar-critical');
        const stale = known && now - window.fetchedAt >= STALE_MS;
        let detail = this._resetText(reset, now);
        if (stale)
            detail = _('%s · checked %s').format(detail, this._agoText(window.fetchedAt, now));
        const actor = row(windowTitle(window), known ? amountText(window) : _('Unknown'), bar,
            detail);
        // Dimmed (St's CSS has no opacity), a hint rather than a value.
        if (stale)
            actor.opacity = STALE_OPACITY;
        return actor;
    }

    // livenerf's row: hidden until its first fetch ends, so nothing flashes
    // up for a moment; offline, "Unknown" like the rest.
    _syncBenchmark(online) {
        const source = this._service.benchmark;
        this._legend.visible = false;
        this._benchmark.visible = Boolean(source) && (source.loaded || !online);
        this._spacer.visible = !this._empty.visible && !this._benchmark.visible;
        if (!this._benchmark.visible)
            return;
        const name = _('Opus 5.5 vs launch week');
        const {progress, result, chart} = source.benchmark ?? {};
        let actor;
        if (!online) {
            actor = row(name, _('Unknown'), new UsageBar(0), _('livenerf: unknown'));
        } else if (!source.benchmark) {
            actor = row(name, _('Unknown'), new UsageBar(0),
                _('livenerf’s results could not be read.'));
        } else {
            const detail = this._benchmarkText(progress, result, chart);
            if (chart) {
                // A new reading starts at the latest days again.
                if (chart !== this._scrolledChart) {
                    this._scrolledChart = chart;
                    this._chartScroll.offset = 0;
                }
                this._legend.destroy_all_children();
                for (const other of chart.others)
                    this._legend.add_child(legendItem(other.name, cssHex(other.color)));
                this._legend.add_child(legendItem(_('Opus 5.5'), null));
                this._legend.visible = true;
                // No heading: the legend names Opus and the chart's end
                // label prints the latest score (user request).
                actor = row(null, null, new ScoreChart(chart, this._chartScroll), detail, true);
                // The chart grows with the island's height.
                actor.y_expand = true;
            } else {
                const value = progress
                    ? _('Day %d of %d').format(progress.collected, progress.total) : _('Unknown');
                actor = row(name, value, new UsageBar(progress ? progress.collected / progress.total : 0),
                    detail, true);
            }
        }
        this._benchmark.y_expand = actor.y_expand;
        this._benchmark.destroy_all_children();
        this._benchmark.add_child(actor);
    }

    // Once published, the Δ and livenerf's decision; before, the baseline's
    // progress. Then when livenerf last redrew its chart.
    _benchmarkText(progress, result, chart) {
        let status = '';
        if (result) {
            status = result.decision
                ? _('Δ %s, %s: %s').format(result.deltaText, result.window, result.decision)
                : _('Δ %s, %s').format(result.deltaText, result.window);
        } else if (progress?.baselineTotal) {
            status = _('Baseline day %d of %d').format(progress.baselineCollected, progress.baselineTotal);
        } else if (chart?.collecting) {
            status = _('Baseline day %d of %d').format(chart.collecting.day, chart.collecting.of);
        }
        const source = chart?.updated
            ? _('livenerf, updated %s').format(this._clock.formatTime(chart.updated, {weekday: true}))
            : progress ? _('livenerf, %s').format(dayText(progress.date)) : _('livenerf');
        return status ? `${status} · ${source}` : source;
    }

    _resetText(reset, now) {
        switch (reset.kind) {
        case 'in':
            return reset.hours > 0
                ? _('Resets in %d h %d min').format(reset.hours, reset.minutes)
                : _('Resets in %d min').format(reset.minutes);
        case 'at':
            return _('Resets %s').format(this._clock.formatTime(reset.time,
                reset.time - now >= DATED_RESET_MS ? {date: true} : {weekday: true}));
        case 'renewed':
            return _('Renewed at %s; not checked since').format(this._clock.formatTime(reset.time));
        default:
            return _('Resets: unknown');
        }
    }

    _updatedText(fetchedAt, now) {
        const minutes = minutesSince(fetchedAt, now);
        if (minutes < 1)
            return _('Updated just now');
        if (minutes < 60)
            return _('Updated %d min ago').format(minutes);
        if (minutes < 24 * 60)
            return _('Updated %d h ago').format(Math.floor(minutes / 60));
        return _('Updated %s').format(this._clock.formatTime(fetchedAt, {weekday: true}));
    }

    // "3 h ago" for a stale row (an hour or more by then).
    _agoText(time, now) {
        const minutes = minutesSince(time, now);
        if (minutes < 60)
            return _('%d min ago').format(minutes);
        if (minutes < 24 * 60)
            return _('%d h ago').format(Math.floor(minutes / 60));
        return this._clock.formatTime(time, {weekday: true});
    }
}

// Name and value, a bar, and a line under it (wrapped if `wrap`).
// A null name leaves out the heading.
function row(name, value, bar, detail, wrap = false) {
    const actor = new St.BoxLayout({
        style_class: 'froonty-claude-row',
        orientation: Clutter.Orientation.VERTICAL,
    });
    if (name !== null) {
        const heading = new St.BoxLayout();
        heading.add_child(new St.Label({style_class: 'froonty-claude-name', text: name, x_expand: true}));
        heading.add_child(new St.Label({style_class: 'froonty-claude-percent', text: value}));
        actor.add_child(heading);
    }
    actor.add_child(bar);
    const label = wrap ? wrappingLabel('froonty-claude-reset')
        : new St.Label({style_class: 'froonty-claude-reset'});
    label.text = detail;
    actor.add_child(label);
    return actor;
}

// "2026-09-30" as "30 Sep".
function dayText(date) {
    const [y, m, d] = date.split('-').map(Number);
    return GLib.DateTime.new_local(y, m, d, 0, 0, 0)?.format('%-d %b') ?? date;
}

function windowTitle(window) {
    switch (window.kind) {
    case SESSION:
        return _('Session');
    case WEEKLY:
        return _('Weekly');
    case CREDITS:
        return _('Cloud session credits');
    default:
        // The model's name comes from Claude's servers, e.g. "Fable".
        return _('Weekly %s').format(window.model);
    }
}

// Why only the status line brings in new numbers, when it is not the
// user's choice (the setting off says nothing).
function modeText(mode) {
    switch (mode?.reason) {
    case 'power-saver':
        return _('Power Saver: status line only');
    case 'battery':
        return _('Low battery: status line only');
    case null:
        return mode.found ? null : _('Claude Code not found');
    default:
        return null;
    }
}

// Credits: what is left, as claude.ai shows it; limits: the share used.
function amountText(window) {
    if (window.kind === CREDITS)
        return _('$%s left').format(window.remaining.toFixed(2));
    return _('%d%%').format(Math.round(window.percent));
}

// Used up, or flagged by Claude's servers (any severity but "normal").
const isCritical = window =>
    window.percent >= 100 || (window.severity !== null && window.severity !== 'normal');

function wrappingLabel(styleClass) {
    const label = new St.Label({style_class: styleClass, x_expand: true});
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

// "#e0793a" as given, or livenerf's orange if it is not such a colour.
function cssHex(hex) {
    return /^#[0-9a-f]{6}$/i.test(hex ?? '') ? hex : '#e0793a';
}

// The same as [r, g, b] from 0 to 1.
function hexColor(hex) {
    const v = parseInt(cssHex(hex).slice(1), 16);
    return [(v >> 16) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255];
}

// A dot in the text colour, as the chart draws its days.
const LegendDot = GObject.registerClass(
class LegendDot extends St.DrawingArea {
    _init() {
        super._init({style_class: 'froonty-claude-legend-dot', y_align: Clutter.ActorAlign.CENTER});
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        cr.arc(width / 2, height / 2, Math.min(width, height) / 2, 0, 2 * Math.PI);
        cr.setSourceColor(this.get_theme_node().get_foreground_color());
        cr.fill();
        cr.$dispose();
    }
});

// One series in the chart's legend: a dot and its name, in `color` (a CSS
// colour), or null for Opus's, the chart's own.
function legendItem(name, color) {
    const item = new St.BoxLayout({style_class: 'froonty-claude-legend-item'});
    if (color)
        item.style = `color: ${color};`;
    else
        item.add_style_class_name('froonty-claude-legend-opus');
    item.add_child(new LegendDot());
    const label = new St.Label({text: name, y_align: Clutter.ActorAlign.CENTER});
    // Never shortened: the footer beside it wraps instead.
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    item.add_child(label);
    return item;
}

// A rounded bar: CSS paints the track (background-color, border-radius),
// this paints the used part in the foreground colour, as GNOME's own
// ui/barLevel.js does (also a DrawingArea subclass).
const UsageBar = GObject.registerClass(
class UsageBar extends St.DrawingArea {
    _init(fraction) {
        super._init({style_class: 'froonty-claude-bar', x_expand: true});
        this._fraction = fraction;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const fill = Math.round(this._fraction * width);
        if (fill > 0) {
            // At least a full circle, so a sliver still reads as rounded.
            const w = Math.max(fill, height);
            const r = height / 2;
            cr.arc(r, r, r, Math.PI / 2, Math.PI * 3 / 2);
            cr.arc(w - r, r, r, -Math.PI / 2, Math.PI / 2);
            cr.closePath();
            cr.setSourceColor(this.get_theme_node().get_foreground_color());
            cr.fill();
        }
        cr.$dispose();
    }
});

// Days the chart shows at once; the wheel or a touchpad scrolls back
// through the rest (user request: a month, rather than the island widened
// to read them all).
const CHART_DAYS = 30;

// livenerf's hero chart, redrawn small: the daily score (percent correct)
// with its 95% interval, the baseline window shaded, the baseline mean
// dashed once known, and the latest score printed by its point. Opus is in
// the CSS colour, other series (Fable 5.2) in livenerf's colour for them;
// the rest in greys over the island's black. The legend is on the footer's
// line (legendItem). With more than CHART_DAYS, a lighter stretch of the
// bottom grid line shows which days are in view.
const ScoreChart = GObject.registerClass(
class ScoreChart extends St.DrawingArea {
    // scroll: {offset}, kept by the view across redraws: how far back from
    // the latest days the view is, in the chart's units (0 to 1).
    _init(chart, scroll) {
        super._init({
            style_class: 'froonty-claude-chart',
            x_expand: true,
            y_expand: true,
            reactive: true,
        });
        this._chart = chart;
        this._scroll = scroll;
        const all = [chart.points, ...(chart.others ?? []).map(o => o.points)].flat();
        this._span = recentSpan(all, CHART_DAYS);
        this._plotWidth = 0;
    }

    vfunc_scroll_event(event) {
        if (this._span >= 1 || !this._plotWidth)
            return Clutter.EVENT_PROPAGATE;
        let delta = 1;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.SMOOTH: {
            const [dx, dy] = event.get_scroll_delta();
            delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
            break;
        }
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            delta = -1;
            break;
        }
        // A step as St's scroll views take one: the view's width to the 2/3.
        // Down or right moves on to later days.
        const step = Math.pow(this._plotWidth, 2 / 3) / this._plotWidth * this._span;
        this._scroll.offset = Math.min(Math.max(this._scroll.offset - delta * step, 0), 1 - this._span);
        this.queue_repaint();
        return Clutter.EVENT_STOP;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const node = this.get_theme_node();
        const {grid, band, ticks, points, others = [], latest, baselineMean, collecting} = this._chart;

        const font = node.get_font();
        const bold = font.copy();
        bold.set_weight(Pango.Weight.BOLD);
        const layout = (text, desc = font) => {
            const l = PangoCairo.create_layout(cr);
            l.set_font_description(desc);
            l.set_text(text, -1);
            const [, extents] = l.get_pixel_extents();
            return {l, w: extents.width, h: extents.height};
        };
        // anchor: 0 left, 0.5 centre, 1 right; y is the text's middle.
        const text = (t, x, y, anchor, rgba, desc) => {
            const {l, w, h} = layout(t, desc);
            cr.setSourceRGBA(...rgba);
            cr.moveTo(Math.round(x - anchor * w), Math.round(y - h / 2));
            PangoCairo.show_layout(cr, l);
        };
        const MUTED = [1, 1, 1, 0.45];

        // Grid labels on the right, by the latest days (user request).
        const labelWidth = Math.max(...grid.map(v => layout(`${v}%`).w));
        const lineHeight = layout('0%').h;
        const [left, right, top, bottom] = [2, labelWidth + 6, lineHeight / 2, lineHeight + 3];
        const [pw, ph] = [width - left - right, height - top - bottom];
        const [vMin, vMax] = [grid[0], grid[grid.length - 1]];
        // In view: the chart from `start` to `start + span`.
        const span = this._span;
        const start = 1 - span - Math.min(Math.max(this._scroll.offset, 0), 1 - span);
        const X = at => left + (at - start) / span * pw;
        const Y = v => top + (vMax - Math.min(vMax, Math.max(vMin, v))) / (vMax - vMin) * ph;
        this._plotWidth = pw;

        for (const v of grid)
            text(`${v}%`, width - right + 5, Y(v), 0, MUTED);

        // The plot scrolls under the grid labels, so nothing passes its edge.
        cr.save();
        cr.rectangle(0, 0, width - right, height);
        cr.clip();
        if (band) {
            cr.setSourceRGBA(1, 1, 1, 0.07);
            cr.rectangle(X(band[0]), top, X(band[1]) - X(band[0]), ph);
            cr.fill();
        }
        cr.setLineWidth(1);
        for (const v of grid) {
            cr.setSourceRGBA(1, 1, 1, 0.1);
            cr.moveTo(left, Math.round(Y(v)) + 0.5);
            cr.lineTo(width - right, Math.round(Y(v)) + 0.5);
            cr.stroke();
        }
        for (const {at, label} of ticks) {
            const anchor = at < 0.05 ? 0 : at > 0.95 ? 1 : 0.5;
            text(label, X(at), height - lineHeight / 2, anchor, MUTED);
        }
        if (collecting && band) {
            const x = (X(band[1]) + width - right) / 2;
            text(_('Collecting the baseline:'), x, top + ph / 2 - lineHeight / 2, 0.5, MUTED);
            text(_('day %d of %d').format(collecting.day, collecting.of), x,
                top + ph / 2 + lineHeight / 2, 0.5, MUTED);
        }
        if (baselineMean !== null) {
            cr.setSourceRGBA(1, 1, 1, 0.7);
            cr.setDash([4, 3], 0);
            cr.moveTo(left, Y(baselineMean));
            cr.lineTo(width - right, Y(baselineMean));
            cr.stroke();
            cr.setDash([], 0);
        }

        // Opus in the CSS colour, then the other series over it, as
        // livenerf draws them.
        const series = (pts, setColor) => {
            if (pts.length > 1) {
                // The 95% band, faint.
                cr.pushGroup();
                pts.forEach((p, i) => (i ? cr.lineTo : cr.moveTo).call(cr, X(p.at), Y(p.high)));
                [...pts].reverse().forEach(p => cr.lineTo(X(p.at), Y(p.low)));
                cr.closePath();
                setColor();
                cr.fill();
                cr.popGroupToSource();
                cr.paintWithAlpha(0.15);
            }
            cr.setLineWidth(1);
            for (const p of pts) {
                cr.moveTo(X(p.at), Y(p.low));
                cr.lineTo(X(p.at), Y(p.high));
            }
            cr.pushGroup();
            setColor();
            cr.stroke();
            cr.popGroupToSource();
            cr.paintWithAlpha(0.5);

            setColor();
            cr.setLineWidth(1.5);
            cr.setLineJoin(1); // Cairo.LineJoin.ROUND
            pts.forEach((p, i) => (i ? cr.lineTo : cr.moveTo).call(cr, X(p.at), Y(p.score)));
            cr.stroke();
            for (const p of pts) {
                cr.arc(X(p.at), Y(p.score), 2.5, 0, 2 * Math.PI);
                cr.fill();
            }
        };
        const color = node.get_foreground_color();
        series(points, () => cr.setSourceColor(color));
        for (const other of others)
            series(other.points, () => cr.setSourceRGBA(...hexColor(other.color), 1));

        // End labels right of their last point, or left if they would pass
        // the plot's edge; one moved off another it would overlap.
        const taken = [];
        const endLabel = (pts, value) => {
            const last = pts[pts.length - 1];
            const t = `${value.toFixed(1)}%`;
            const {w} = layout(t, bold);
            const x = X(last.at) + 6 + w <= width - right ? X(last.at) + 6 : X(last.at) - 6 - w;
            let y = Y(last.score) - lineHeight / 2 - 1;
            for (const other of taken) {
                if (Math.abs(y - other.y) < lineHeight + 1)
                    y = last.score >= other.score ? other.y - lineHeight - 1 : other.y + lineHeight + 1;
            }
            y = Math.min(Math.max(y, top + lineHeight / 2), top + ph - lineHeight / 2);
            taken.push({y, score: last.score});
            text(t, x, y, 0, [1, 1, 1, 1], bold);
        };
        if (typeof latest === 'number')
            endLabel(points, latest);
        for (const other of others)
            endLabel(other.points, other.latest);
        cr.restore();

        if (span < 1) {
            cr.setSourceRGBA(1, 1, 1, 0.35);
            cr.rectangle(left + start * pw, Math.round(Y(vMin)), span * pw, 2);
            cr.fill();
        }
        cr.$dispose();
    }
});
