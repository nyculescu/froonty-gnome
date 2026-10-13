// SPDX-License-Identifier: GPL-3.0-or-later
// Fan tab: the cooling pad (its state, a speed slider, presets and
// Release, the speed fan_lut.json recommends with Apply); the laptop's own
// fans (their speeds, the platform profile, the custom curves on or off and
// drawn); then the temperatures: the CPU package and each GPU now, their
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

import {PROFILES, curvesState} from './asus.js';
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
// The laptop's fans, in the colours of what they cool.
const LAPTOP_FAN_RGB = {cpu: CPU_RGB, gpu: GPU_RGB[0], mid: FAN_RGB};
// The curve chart's temperature axis.
const CURVE_T_MIN = 30;
const CURVE_T_MAX = 100;
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

const PROFILE_NAMES = {
    'low-power': () => _('Low power'),
    quiet: () => _('Quiet'),
    balanced: () => _('Balanced'),
    performance: () => _('Performance'),
    custom: () => _('Custom'),
};
const profileName = profile => PROFILE_NAMES[PROFILES[profile]]?.() ?? DASH;
const LAPTOP_FAN_NAMES = {cpu: () => _('CPU'), gpu: () => _('GPU'), mid: () => _('Mid')};
const laptopFanName = id => LAPTOP_FAN_NAMES[id]?.() ?? id;
const laptopFanRgb = id => LAPTOP_FAN_RGB[id] ?? MUTED.slice(0, 3);

// Whether the active profile runs its custom curves, for the curves row.
function curvesText(laptop) {
    const profile = profileName(laptop.profile);
    switch (curvesState(laptop.curves)) {
    case 'all':
        return _('Custom fan curves on for %s.').format(profile);
    case 'some':
        return _('Custom fan curves on for %s: %s.').format(profile, laptop.curves
            .filter(curve => curve.enabled).map(curve => laptopFanName(curve.fan)).join(', '));
    default:
        return _('Custom fan curves off: the firmware’s own for %s.').format(profile);
    }
}

function laptopNotice(laptop) {
    if (laptop.daemon === false) {
        return _('asusd is not running: the profile and fan curves need asusctl’s daemon (third_party/asusctl).');
    }
    if (laptop.readError)
        return _('asusd: %s').format(laptop.readError);
    if (laptop.error)
        return _('asusd refused: %s').format(laptop.error);
    return '';
}

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

const BAND_NAMES = {
    quiet: () => _('quiet'),
    night: () => _('night level'),
    audible: () => _('audible'),
    loud: () => _('loud'),
    'very loud': () => _('very loud'),
};

// "≈600 rpm · ≈50 dB at the ears · night level" (llano-v12-linux's noise.py).
function noiseText(noise) {
    if (!noise)
        return '';
    const band = BAND_NAMES[noise.band]?.() ?? noise.band;
    return _('≈%d rpm · ≈%s dB at the ears · %s').format(noise.rpm, noise.ear_db.toFixed(0), band);
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
        this._buildLaptop(list);
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
        this._noiseLabel = new St.Label({style_class: 'froonty-fan-noise'});
        box.add_child(this._noiseLabel);

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
        buttons.add_child(this._button(_('Off'), () => this._setOff(),
            _('Switch the pad off, fan and lights')));
        buttons.add_child(this._button(_('0 %'), () => this._setSpeed(0),
            _('Slowest speed, lights on')));
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

    _buildLaptop(parent) {
        this._laptopBox = this._section(parent, _('Laptop'));
        this._laptopName = new St.Label({style_class: 'froonty-sysmon-name'});
        this._laptopBox.add_child(this._laptopName);
        // Each fan's swatch, name and rpm; rebuilt when the fans change.
        this._laptopLegend = new St.BoxLayout({style_class: 'froonty-fan-legend'});
        this._laptopBox.add_child(this._laptopLegend);
        this._laptopLegendKey = null;

        // One button per profile, the active one checked; rebuilt when they change.
        this._profileButtons = new St.BoxLayout({style_class: 'froonty-fan-buttons'});
        this._laptopBox.add_child(this._profileButtons);
        this._profilesKey = null;

        this._curvesRow = new St.BoxLayout({style_class: 'froonty-fan-notice-row'});
        this._curvesLabel = new St.Label({style_class: 'froonty-sysmon-detail', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        this._curvesLabel.clutter_text.line_wrap = true;
        this._curvesLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._curvesRow.add_child(this._curvesLabel);
        this._curvesButton = this._button(_('Use custom curves'), () =>
            this._service.setLaptopCurves(curvesState(this._service.laptop.curves) === 'none'));
        this._curvesButton.y_align = Clutter.ActorAlign.CENTER;
        this._curvesRow.add_child(this._curvesButton);
        this._laptopBox.add_child(this._curvesRow);
        this._curveChart = new CurveChart();
        this._laptopBox.add_child(this._curveChart);

        this._laptopNotice = new St.Label({style_class: 'froonty-fan-notice'});
        this._laptopNotice.clutter_text.line_wrap = true;
        this._laptopNotice.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._laptopBox.add_child(this._laptopNotice);
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
        this._targetLabel.text = this._targetText(percent);
        this._service.setSpeed(percent);
    }

    // The slider rests at 0 while the pad is off.
    _setOff() {
        this._holdUntil = GLib.get_monotonic_time() / 1000 + HOLD_MS;
        this._settingSlider = true;
        this._slider.value = 0;
        this._settingSlider = false;
        this._targetLabel.text = _('Off');
        this._service.off();
    }

    // "40%".
    _targetText(percent) {
        return _('%d%%').format(percent);
    }

    _onSliderValue() {
        if (this._settingSlider)
            return;
        const percent = Math.round(this._slider.value * 100);
        this._targetLabel.text = this._targetText(percent);
        this._holdUntil = GLib.get_monotonic_time() / 1000 + HOLD_MS;
        this._service.setSpeed(percent);
    }

    _sync() {
        const service = this._service;
        const {status, temps} = service;

        this._speedLabel.text = !status ? DASH : status.off ? _('Off') : _('%d%%').format(status.speed);
        this._detail.text = status
            ? [controlText(service.control), status.off ? _('pad off') : status.lightsOff ? _('lights off') : _('lights on'),
                _('raw %s').format(status.raw)].join(' · ')
            : DASH;
        const notice = noticeText(service);
        this._notice.text = notice;
        this._noticeRow.visible = Boolean(notice);
        this._stopButton.visible = !service.lock && !service.error && service.controllers.length > 0;
        this._lastChange.text = lastChangeText(service);
        this._noiseLabel.text = noiseText(service.noise);
        this._noiseLabel.visible = Boolean(service.noise);
        this._noiseLabel.style_class = `froonty-fan-noise froonty-fan-band-${(service.noise?.band ?? 'quiet').replace(' ', '-')}`;
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
            this._targetLabel.text = status.off ? _('Off') : _('%d%%').format(status.speed);
        }

        this._syncRecommendation(service);
        this._syncLaptop(service);
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

    _legendItem(rgb, name, tooltip = name, legend = this._legend) {
        const item = new St.BoxLayout({style_class: 'froonty-fan-legend-item', accessible_name: tooltip});
        item.add_child(new St.Widget({
            style_class: 'froonty-fan-swatch',
            style: `background-color: ${hex(rgb)};`,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        item.add_child(new St.Label({style_class: 'froonty-fan-legend-name', text: name}));
        const value = new St.Label({style_class: 'froonty-fan-legend-value'});
        item.add_child(value);
        legend.add_child(item);
        return value;
    }

    _syncLaptop(service) {
        const laptop = service.laptop;
        this._laptopBox.visible = laptop.present;
        if (!laptop.present)
            return;
        this._laptopName.text = laptop.model ?? _('Laptop fans');

        const fanKey = laptop.fans.map(fan => fan.id).join(',');
        if (fanKey !== this._laptopLegendKey) {
            this._laptopLegend.destroy_all_children();
            this._laptopFanItems = laptop.fans.map(fan => this._legendItem(laptopFanRgb(fan.id),
                laptopFanName(fan.id), _('%s fan').format(laptopFanName(fan.id)), this._laptopLegend));
            this._laptopLegendKey = fanKey;
        }
        laptop.fans.forEach((fan, i) => {
            this._laptopFanItems[i].text = _('%d rpm').format(fan.rpm);
        });
        this._laptopLegend.visible = laptop.fans.length > 0;

        const profilesKey = laptop.profiles.join(',');
        if (profilesKey !== this._profilesKey) {
            this._profileButtons.destroy_all_children();
            for (const profile of laptop.profiles) {
                const button = this._button(profileName(profile), () => {
                    if (this._service.laptop.profile !== profile)
                        this._service.setLaptopProfile(profile);
                }, _('%s profile').format(profileName(profile)));
                button.add_style_class_name('froonty-fan-profile');
                button._profile = profile;
                this._profileButtons.add_child(button);
            }
            this._profilesKey = profilesKey;
        }
        for (const button of this._profileButtons.get_children()) {
            button.checked = button._profile === laptop.profile;
            button.reactive = !service.laptopBusy;
        }
        this._profileButtons.visible = laptop.profiles.length > 0;

        const curves = laptop.curves.length > 0;
        this._curvesRow.visible = curves;
        this._curveChart.visible = curves;
        if (curves) {
            this._curvesLabel.text = curvesText(laptop);
            this._curvesButton.label = curvesState(laptop.curves) === 'none'
                ? _('Use custom curves') : _('Firmware curves');
            this._curvesButton.reactive = !service.laptopBusy;
            const gpuTemps = (service.temps?.gpus ?? []).map(gpu => gpu.temp).filter(known);
            this._curveChart.update(laptop.curves, {
                cpu: service.temps?.cpu ?? null,
                gpu: gpuTemps.length ? Math.max(...gpuTemps) : null,
            });
        }

        const notice = laptopNotice(laptop);
        this._laptopNotice.text = notice;
        this._laptopNotice.visible = Boolean(notice);
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

// The active profile's fan curves: fan % over °C, each fan in its colour,
// solid while it is in use and dashed while the firmware's own run
// instead; the CPU's and the hottest GPU's temperatures now as thin lines.
const CurveChart = GObject.registerClass(
class CurveChart extends St.DrawingArea {
    _init() {
        super._init({style_class: 'froonty-fan-curves', x_expand: true});
        this._curves = [];
        this._temps = {};
    }

    // Redrawn only when the curves change or a temperature moves a degree.
    update(curves, temps) {
        const rounded = {cpu: known(temps.cpu) ? Math.round(temps.cpu) : null,
            gpu: known(temps.gpu) ? Math.round(temps.gpu) : null};
        if (curves === this._curves && rounded.cpu === this._temps.cpu && rounded.gpu === this._temps.gpu)
            return;
        this._curves = curves;
        this._temps = rounded;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const {measure, draw} = textPainter(cr, this.get_theme_node());
        const lineHeight = measure('0').h;
        const left = measure(_('%d%%').format(100)).w + 6;
        const [right, top, bottom] = [measure(celsius(CURVE_T_MAX)).w / 2, lineHeight / 2, lineHeight + 3];
        const [pw, ph] = [width - left - right, height - top - bottom];
        const X = t => left + (Math.min(CURVE_T_MAX, Math.max(CURVE_T_MIN, t)) - CURVE_T_MIN) /
            (CURVE_T_MAX - CURVE_T_MIN) * pw;
        const Y = percent => top + (100 - percent) / 100 * ph;

        cr.setLineWidth(1);
        for (const v of [0, 50, 100]) {
            cr.setSourceRGBA(1, 1, 1, 0.1);
            cr.moveTo(left, Math.round(Y(v)) + 0.5);
            cr.lineTo(width - right, Math.round(Y(v)) + 0.5);
            cr.stroke();
            draw(_('%d%%').format(v), left - 5, Y(v), 1, MUTED);
        }
        for (let t = CURVE_T_MIN; t <= CURVE_T_MAX; t += 10)
            draw(celsius(t), X(t), height - lineHeight / 2, 0.5, MUTED);

        for (const [device, rgb] of [['gpu', GPU_RGB[0]], ['cpu', CPU_RGB]]) {
            const temp = this._temps[device];
            if (!known(temp))
                continue;
            cr.setSourceRGBA(...rgb, 0.45);
            cr.setLineWidth(1);
            cr.moveTo(Math.round(X(temp)) + 0.5, top);
            cr.lineTo(Math.round(X(temp)) + 0.5, top + ph);
            cr.stroke();
        }

        for (const curve of this._curves) {
            const rgb = laptopFanRgb(curve.fan);
            cr.setSourceRGBA(...rgb, curve.enabled ? 1 : 0.6);
            cr.setLineWidth(curve.enabled ? 2 : 1.5);
            cr.setDash(curve.enabled ? [] : [4, 3], 0);
            curve.points.forEach(([t, percent], i) => {
                if (i === 0)
                    cr.moveTo(X(t), Y(percent));
                else
                    cr.lineTo(X(t), Y(percent));
            });
            cr.stroke();
            cr.setDash([], 0);
            for (const [t, percent] of curve.points) {
                cr.arc(X(t), Y(percent), curve.enabled ? 2.5 : 1.5, 0, 2 * Math.PI);
                cr.fill();
            }
        }
        cr.$dispose();
    }
});
