// SPDX-License-Identifier: GPL-3.0-or-later
// Fan tab: the cooling pad (its state, a speed slider, presets and
// Release, the speed fan_lut.json recommends with Apply), then the temperatures: the CPU package and each GPU now, their
// last five minutes with the fan speed in one chart, and each physical
// core as a bar. Actors are made once and updated on each 'changed'.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {HISTORY_S} from './service.js';

const DASH = '—';
// After the user moves the slider, a poll already on its way may still
// report the old speed: the slider is not moved back meanwhile.
const HOLD_MS = 1500;
// The temperature axis; widened when a reading falls outside it.
const T_MIN = 20;
const T_MAX = 100;
const T_STEP = 20;

// Series colours (also the legend's swatches): CPU red, GPUs green,
// purple, yellow; the fan dashed light blue.
const CPU_RGB = [0.965, 0.380, 0.318];
const GPU_RGB = [[0.341, 0.890, 0.537], [0.863, 0.541, 0.867], [0.976, 0.941, 0.420]];
const FAN_RGB = [0.600, 0.757, 0.945];
const MUTED = [1, 1, 1, 0.45];
// A core's bar by its temperature: the Btop levels' green to red.
const BANDS = [
    [50, [0.200, 0.820, 0.478]],
    [65, [0.647, 0.890, 0.290]],
    [80, [0.965, 0.827, 0.176]],
    [90, [1.000, 0.471, 0.000]],
    [Infinity, [0.878, 0.106, 0.141]],
];

const known = value => value !== null && value !== undefined;
const celsius = value => known(value) ? _('%d °C').format(Math.round(value)) : DASH;
const hex = rgb => `#${rgb.map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;
const gpuRgb = i => GPU_RGB[i % GPU_RGB.length];
// A GPU's colour stays the same in the legend and the chart: by the order
// the GPUs were first seen (service.gpuNames).
const gpuIndex = (gpuNames, id) => Math.max(0, [...gpuNames.keys()].indexOf(id));
// The legend's short name for a GPU.
function vendor(name) {
    if (/nvidia|geforce|rtx|quadro/i.test(name ?? ''))
        return 'NVIDIA';
    if (/intel/i.test(name ?? ''))
        return 'Intel';
    if (/amd|radeon/i.test(name ?? ''))
        return 'AMD';
    return _('GPU');
}
const bandRgb = temp => BANDS.find(([upTo]) => temp < upTo)[1];
// A GPU worth a line: one with a temperature, or an NVIDIA one asleep.
const shownGpus = gpus => (gpus ?? []).filter(gpu => known(gpu.temp) || gpu.asleep);

const clock = time => GLib.DateTime.new_from_unix_local(Math.floor(time)).format('%H:%M:%S');

// "Last change: …" from llano.py's control log; the pad's own status says
// when its roller was turned since (it then reports pad control again).
function lastChangeText(service) {
    if (service.status?.control === 'pad')
        return _('Last change: the pad’s roller');
    const entry = service.lastControl;
    if (!entry)
        return _('Last change: none logged yet');
    let what;
    switch (entry.action) {
    case 'speed':
        what = _('set %d%%').format(entry.speed);
        break;
    case 'release':
        what = _('handed it to the roller');
        break;
    case 'lock':
        what = _('locked it off');
        break;
    case 'unlock':
        what = _('unlocked it at %d%%').format(entry.speed);
        break;
    default:
        what = entry.action;
    }
    return _('Last change: %s %s · %s').format(entry.by, what, clock(entry.time));
}

function noticeText(service) {
    if (service.lock) {
        const by = service.lock.by ? _(' by %s at %s').format(service.lock.by, clock(service.lock.time)) : '';
        return _('Locked off%s. No program that drives the pad through llano.py can start the fan; the pad’s roller still can.')
            .format(by);
    }
    switch (service.error) {
    case 'not-found':
        return _('The cooling pad is not connected (USB 374a:b101).');
    case 'no-access':
        return _('No access to the pad. Install llano-v12-linux’s udev rule (contrib/70-llano.rules), then plug the pad in again.');
    case 'no-script':
        return _('llano.py was not found. Set where it is in Settings → Fan.');
    case 'failed':
        return _('llano.py failed: %s').format(service.errorMessage || DASH);
    }
    if (service.controllers.length) {
        return _('%s sets the speed by itself, so the slider is undone within seconds.')
            .format(service.controllers[0].replace(/\.service$/, ''));
    }
    return '';
}

function controlText(control) {
    switch (control) {
    case 'software':
        return _('Software control');
    case 'pad':
        return _('The pad’s roller');
    case 'released':
        return _('Released to the pad’s roller');
    default:
        return DASH;
    }
}

export class FanView {
    constructor(service) {
        this._service = service;
        this._dragging = false;
        this._settingSlider = false;
        this._holdUntil = 0;
        this._legendKey = null;

        this.actor = new St.BoxLayout({
            style_class: 'froonty-fan',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        const list = new St.BoxLayout({
            style_class: 'froonty-sysmon-sections froonty-fan-sections',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        scroll.add_child(list);
        this.actor.add_child(scroll);

        this._buildPad(list);
        this._buildTemps(list);

        this._serviceId = this._service.connect('changed', () => this._sync());
        this._sync();
    }

    destroy() {
        this._service.disconnect(this._serviceId);
        this.actor.destroy();
    }

    _section(parent, title) {
        const box = new St.BoxLayout({
            style_class: 'froonty-sysmon-section',
            orientation: Clutter.Orientation.VERTICAL,
        });
        box.add_child(new St.Label({style_class: 'froonty-sysmon-heading', text: title}));
        parent.add_child(box);
        return box;
    }

    _buildPad(parent) {
        const box = this._section(parent, _('Cooling pad'));

        const heading = new St.BoxLayout();
        heading.add_child(new St.Label({
            style_class: 'froonty-sysmon-name', text: _('llano V12 Ultra'), x_expand: true,
        }));
        this._speedLabel = new St.Label({style_class: 'froonty-fan-speed'});
        heading.add_child(this._speedLabel);
        box.add_child(heading);
        this._detail = new St.Label({style_class: 'froonty-sysmon-detail'});
        box.add_child(this._detail);
        this._lastChange = new St.Label({style_class: 'froonty-sysmon-detail'});
        box.add_child(this._lastChange);

        const sliderRow = new St.BoxLayout({style_class: 'froonty-fan-slider-row'});
        this._slider = new Slider(0);
        this._slider.accessible_name = _('Fan speed');
        this._slider.x_expand = true;
        this._slider.y_align = Clutter.ActorAlign.CENTER;
        this._slider.connect('drag-begin', () => {
            this._dragging = true;
        });
        this._slider.connect('drag-end', () => {
            this._dragging = false;
            this._holdUntil = GLib.get_monotonic_time() / 1000 + HOLD_MS;
        });
        this._slider.connect('notify::value', () => this._onSliderValue());
        sliderRow.add_child(this._slider);
        this._targetLabel = new St.Label({
            style_class: 'froonty-fan-target', y_align: Clutter.ActorAlign.CENTER,
        });
        sliderRow.add_child(this._targetLabel);
        box.add_child(sliderRow);

        const buttons = new St.BoxLayout({style_class: 'froonty-fan-buttons'});
        buttons.add_child(this._button(_('Off'), () => this._setSpeed(0)));
        buttons.add_child(this._button(_('50 %'), () => this._setSpeed(50)));
        buttons.add_child(this._button(_('100 %'), () => this._setSpeed(100)));
        buttons.add_child(new St.Widget({x_expand: true}));
        this._lockButton = this._button(_('Lock off'), () => this._service.setLocked(!this._service.lock),
            _('Turn the fan off and keep every program from starting it'));
        buttons.add_child(this._lockButton);
        buttons.add_child(this._button(_('Release'), () => this._service.release(),
            _('Hand speed control back to the pad’s roller')));
        box.add_child(buttons);
        // Everything that sets a speed, held while the pad is locked.
        this._speedControls = [this._slider, ...buttons.get_children()
            .filter(child => child instanceof St.Button && child !== this._lockButton)];

        // The recommendation (lut.js): its speed, which device leads, Apply.
        const recommendRow = new St.BoxLayout({style_class: 'froonty-fan-recommend'});
        const recommendText = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        });
        this._recommendLabel = new St.Label({style_class: 'froonty-sysmon-name'});
        this._recommendDetail = new St.Label({style_class: 'froonty-sysmon-detail'});
        this._recommendDetail.clutter_text.line_wrap = true;
        this._recommendDetail.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        recommendText.add_child(this._recommendLabel);
        recommendText.add_child(this._recommendDetail);
        recommendRow.add_child(recommendText);
        this._applyButton = this._button(_('Apply'), () => {
            const fan = this._service.recommendation?.fan;
            if (fan !== undefined)
                this._setSpeed(fan);
        }, _('Set the recommended speed'));
        this._applyButton.y_align = Clutter.ActorAlign.CENTER;
        recommendRow.add_child(this._applyButton);
        box.add_child(recommendRow);

        const noticeRow = new St.BoxLayout({style_class: 'froonty-fan-notice-row'});
        this._notice = new St.Label({style_class: 'froonty-fan-notice', x_expand: true});
        this._notice.clutter_text.line_wrap = true;
        this._notice.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        noticeRow.add_child(this._notice);
        this._stopButton = this._button(_('Stop it'), () => {
            const unit = this._service.controllers[0];
            if (unit)
                this._service.stopController(unit);
        });
        this._stopButton.y_align = Clutter.ActorAlign.CENTER;
        noticeRow.add_child(this._stopButton);
        this._noticeRow = noticeRow;
        box.add_child(noticeRow);
    }

    _buildTemps(parent) {
        const box = this._section(parent, _('Temperatures'));
        this._legend = new St.BoxLayout({style_class: 'froonty-fan-legend'});
        box.add_child(this._legend);
        this._chart = new TempChart();
        box.add_child(this._chart);

        const coresHeading = new St.BoxLayout();
        coresHeading.add_child(new St.Label({
            style_class: 'froonty-sysmon-name', text: _('Each core'), x_expand: true,
        }));
        this._coresSummary = new St.Label({style_class: 'froonty-sysmon-value'});
        coresHeading.add_child(this._coresSummary);
        box.add_child(coresHeading);
        this._coreChart = new CoreChart();
        box.add_child(this._coreChart);
    }

    _button(text, action, accessibleName = text) {
        const button = new St.Button({
            style_class: 'froonty-fan-button',
            label: text,
            accessible_name: accessibleName,
            can_focus: true,
        });
        button.connect('clicked', action);
        return button;
    }

    _setSpeed(percent) {
        this._holdUntil = GLib.get_monotonic_time() / 1000 + HOLD_MS;
        this._settingSlider = true;
        this._slider.value = percent / 100;
        this._settingSlider = false;
        this._targetLabel.text = _('%d%%').format(percent);
        this._service.setSpeed(percent);
    }

    _onSliderValue() {
        if (this._settingSlider)
            return;
        const percent = Math.round(this._slider.value * 100);
        this._targetLabel.text = _('%d%%').format(percent);
        this._holdUntil = GLib.get_monotonic_time() / 1000 + HOLD_MS;
        this._service.setSpeed(percent);
    }

    _sync() {
        const service = this._service;
        const {status, temps} = service;

        this._speedLabel.text = status ? _('%d%%').format(status.speed) : DASH;
        this._detail.text = status
            ? [controlText(service.control), status.lightsOff ? _('lights off') : _('lights on'),
                _('raw %s').format(status.raw)].join(' · ')
            : DASH;
        const notice = noticeText(service);
        this._notice.text = notice;
        this._noticeRow.visible = Boolean(notice);
        this._stopButton.visible = !service.lock && !service.error && service.controllers.length > 0;
        this._lastChange.text = lastChangeText(service);
        const locked = Boolean(service.lock);
        this._lockButton.label = locked ? _('Unlock') : _('Lock off');
        this._lockButton.checked = locked;
        for (const control of this._speedControls) {
            control.reactive = !locked;
            control.opacity = locked ? 110 : 255;
        }

        const held = this._dragging || service.busy ||
            GLib.get_monotonic_time() / 1000 < this._holdUntil;
        if (status && !held) {
            this._settingSlider = true;
            this._slider.value = status.speed / 100;
            this._settingSlider = false;
            this._targetLabel.text = _('%d%%').format(status.speed);
        }

        this._syncRecommendation(service);
        this._syncLegend(temps, status, service.gpuNames);
        this._chart.update(service.history, service.gpuNames, service.interval);
        const cores = temps?.cores ?? [];
        const hottest = cores.filter(core => known(core.temp))
            .reduce((max, core) => (max && max.temp >= core.temp ? max : core), null);
        this._coresSummary.text = hottest
            ? _('%d cores · hottest %s').format(cores.length, celsius(hottest.temp)) : DASH;
        this._coreChart.update(cores);
    }

    _syncRecommendation(service) {
        const rec = service.recommendation;
        if (service.lutError) {
            this._recommendLabel.text = _('No recommendation yet');
            this._recommendDetail.text = service.lutError === 'missing'
                ? _('fan_lut.json was not found. Build it with llano-v12-linux’s research/lut_sweep.py and research/build_lut.py, or set where it is in Settings → Fan.')
                : _('fan_lut.json is not a fan table that can be read.');
        } else if (rec) {
            const leader = rec.device === 'gpu' ? _('GPU') : _('CPU');
            this._recommendLabel.text = _('Recommended %d%%').format(rec.fan);
            this._recommendDetail.text = [_('%s %s leads').format(leader, celsius(rec.temp)),
                service.lut.built && _('table of %s').format(service.lut.built)].filter(Boolean).join(' · ');
        } else {
            this._recommendLabel.text = _('Recommended');
            this._recommendDetail.text = DASH;
        }
        this._applyButton.visible = Boolean(rec) && !service.lutError;
        this._applyButton.reactive = !service.lock && rec?.fan !== service.status?.speed;
    }

    // One swatch, name and value per series; rebuilt when the GPUs change.
    _syncLegend(temps, status, gpuNames) {
        const gpus = shownGpus(temps?.gpus);
        const key = gpus.map(gpu => gpu.id).join(',');
        if (key !== this._legendKey) {
            this._legend.destroy_all_children();
            this._legendItems = [
                this._legendItem(CPU_RGB, _('CPU')),
                ...gpus.map(gpu =>
                    this._legendItem(gpuRgb(gpuIndex(gpuNames, gpu.id)), vendor(gpu.name), gpu.name)),
                this._legendItem(FAN_RGB, _('Fan')),
            ];
            this._legendKey = key;
        }
        const values = [
            celsius(temps?.cpu),
            ...gpus.map(gpu => (gpu.asleep ? _('Asleep') : celsius(gpu.temp))),
            status ? _('%d%%').format(status.speed) : DASH,
        ];
        values.forEach((value, i) => {
            this._legendItems[i].text = value;
        });
    }

    _legendItem(rgb, name, tooltip = name) {
        const item = new St.BoxLayout({style_class: 'froonty-fan-legend-item', accessible_name: tooltip});
        item.add_child(new St.Widget({
            style_class: 'froonty-fan-swatch',
            style: `background-color: ${hex(rgb)};`,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        item.add_child(new St.Label({style_class: 'froonty-fan-legend-name', text: name}));
        const value = new St.Label({style_class: 'froonty-fan-legend-value'});
        item.add_child(value);
        this._legend.add_child(item);
        return value;
    }
}

// Pango text drawing for the charts. anchor: 0 left, 0.5 centre, 1 right;
// y is the text's middle.
function textPainter(cr, node) {
    const font = node.get_font();
    const measure = text => {
        const layout = PangoCairo.create_layout(cr);
        layout.set_font_description(font);
        layout.set_text(text, -1);
        const [, extents] = layout.get_pixel_extents();
        return {layout, w: extents.width, h: extents.height};
    };
    const draw = (text, x, y, anchor, rgba) => {
        const {layout, w, h} = measure(text);
        cr.setSourceRGBA(...rgba);
        cr.moveTo(Math.round(x - anchor * w), Math.round(y - h / 2));
        PangoCairo.show_layout(cr, layout);
    };
    return {measure, draw};
}

// The last HISTORY_S: CPU and GPU temperatures (left axis, °C) and the fan
// (right axis, %, dashed). A line breaks where a reading is missing or the
// tab was away, so no slope is drawn across a gap.
const TempChart = GObject.registerClass(
class TempChart extends St.DrawingArea {
    _init() {
        super._init({style_class: 'froonty-fan-chart', x_expand: true});
        this._history = [];
        this._gpuIds = [];
        this._gpuNames = new Map();
        this._interval = 2;
    }

    update(history, gpuNames, interval) {
        this._history = history;
        this._gpuNames = gpuNames;
        this._gpuIds = [...gpuNames.keys()].filter(id =>
            history.some(point => known(point.gpus[id])));
        this._interval = interval;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const {measure, draw} = textPainter(cr, this.get_theme_node());
        const history = this._history;

        const temps = history.flatMap(p => [p.cpu, ...Object.values(p.gpus)]).filter(known);
        const lo = Math.min(T_MIN, Math.floor(Math.min(...temps, T_MIN) / T_STEP) * T_STEP);
        const hi = Math.max(T_MAX, Math.ceil(Math.max(...temps, T_MAX) / T_STEP) * T_STEP);
        const grid = [];
        for (let v = lo; v <= hi; v += T_STEP)
            grid.push(v);

        const lineHeight = measure('0').h;
        const leftLabel = Math.max(...grid.map(v => measure(celsius(v)).w));
        const rightLabel = measure(_('%d%%').format(100)).w;
        const [left, right, top, bottom] = [leftLabel + 6, rightLabel + 6, lineHeight / 2, lineHeight + 3];
        const [pw, ph] = [width - left - right, height - top - bottom];
        const end = history.length ? history[history.length - 1].t : 0;
        const X = t => left + (1 - (end - t) / HISTORY_S) * pw;
        const Y = v => top + (hi - v) / (hi - lo) * ph;

        cr.setLineWidth(1);
        for (const v of grid) {
            cr.setSourceRGBA(1, 1, 1, 0.1);
            cr.moveTo(left, Math.round(Y(v)) + 0.5);
            cr.lineTo(width - right, Math.round(Y(v)) + 0.5);
            cr.stroke();
            draw(celsius(v), left - 5, Y(v), 1, MUTED);
            draw(_('%d%%').format(Math.round((v - lo) / (hi - lo) * 100)), width - right + 5, Y(v), 0, MUTED);
        }
        draw(_('%d min ago').format(HISTORY_S / 60), left, height - lineHeight / 2, 0, MUTED);
        draw(_('now'), width - right, height - lineHeight / 2, 1, MUTED);

        if (!history.length) {
            draw(_('Collecting…'), left + pw / 2, top + ph / 2, 0.5, MUTED);
            cr.$dispose();
            return;
        }

        const maxGap = this._interval * 2.5 + 1;
        const series = (value, rgb, dash) => {
            cr.setSourceRGBA(...rgb, 1);
            cr.setLineWidth(dash ? 1.5 : 2);
            cr.setDash(dash ? [4, 3] : [], 0);
            let previous = null;
            for (const point of history) {
                const v = value(point);
                if (!known(v)) {
                    previous = null;
                    continue;
                }
                const [x, y] = [X(point.t), Y(v)];
                if (previous && point.t - previous.t <= maxGap)
                    cr.lineTo(x, y);
                else
                    cr.moveTo(x, y);
                previous = point;
            }
            cr.stroke();
            // The latest reading as a dot, so a lone point still shows.
            const last = history[history.length - 1];
            if (known(value(last))) {
                cr.setDash([], 0);
                cr.arc(X(last.t), Y(value(last)), 2.5, 0, 2 * Math.PI);
                cr.fill();
            }
        };
        series(p => (known(p.fan) ? lo + p.fan / 100 * (hi - lo) : null), FAN_RGB, true);
        for (const id of this._gpuIds)
            series(p => p.gpus[id], gpuRgb(gpuIndex(this._gpuNames, id)), false);
        series(p => p.cpu, CPU_RGB, false);
        cr.$dispose();
    }
});

// Each physical core as a bar on the temperature axis, coloured green to
// red. On a hybrid CPU, P-cores (two threads) and E-cores (one) are
// labelled under their bars.
const CoreChart = GObject.registerClass(
class CoreChart extends St.DrawingArea {
    _init() {
        super._init({style_class: 'froonty-fan-cores', x_expand: true});
        this._cores = [];
    }

    update(cores) {
        this._cores = cores;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const {measure, draw} = textPainter(cr, this.get_theme_node());
        const cores = this._cores;
        const hybrid = new Set(cores.map(core => core.threads)).size > 1;
        const lineHeight = measure('0').h;
        const bottom = hybrid ? lineHeight + 3 : 0;
        const ph = height - bottom;

        if (!cores.length) {
            draw(_('No per-core temperatures on this computer'), width / 2, ph / 2, 0.5, MUTED);
            cr.$dispose();
            return;
        }
        const slot = width / cores.length;
        const barWidth = Math.max(2, slot - Math.min(3, slot * 0.25));
        const scale = temp => Math.min(1, Math.max(0, (temp - T_MIN) / (T_MAX - T_MIN)));
        cores.forEach((core, i) => {
            const x = i * slot + (slot - barWidth) / 2;
            cr.setSourceRGBA(1, 1, 1, 0.07);
            cr.rectangle(x, 0, barWidth, ph);
            cr.fill();
            if (!known(core.temp))
                return;
            const h = Math.max(1, scale(core.temp) * ph);
            cr.setSourceRGBA(...bandRgb(core.temp), 1);
            cr.rectangle(x, ph - h, barWidth, h);
            cr.fill();
        });
        if (hybrid) {
            // Each run of cores with the same thread count, labelled at its middle.
            let start = 0;
            for (let i = 1; i <= cores.length; i++) {
                if (i < cores.length && cores[i].threads === cores[start].threads)
                    continue;
                const label = cores[start].threads > 1 ? _('P-cores') : _('E-cores');
                draw(label, (start + i) / 2 * slot, height - lineHeight / 2, 0.5, MUTED);
                start = i;
            }
        }
        cr.$dispose();
    }
});
