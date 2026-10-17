// SPDX-License-Identifier: GPL-3.0-or-later
// Fan controls and telemetry in Froonty's settings window (docs/features/fan.md).

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {addIconPath} from '../../prefs/rows.js';
import {PROFILES} from './asus.js';
import {FAN_ICON_NAME} from './icon.js';
import {FanService} from './service.js';

const PROFILE_NAMES = {
    'low-power': () => _('Low power'),
    quiet: () => _('Quiet'),
    balanced: () => _('Balanced'),
    performance: () => _('Performance'),
    custom: () => _('Custom'),
};
const profileName = profile => PROFILE_NAMES[PROFILES[profile]]?.() ?? _('Unknown');
const FAN_NAMES = {cpu: () => _('CPU'), gpu: () => _('GPU'), mid: () => _('Mid')};
const laptopFanName = id => FAN_NAMES[id]?.() ?? id;

function button(label, action) {
    const widget = new Gtk.Button({label, can_focus: true});
    widget.connect('clicked', action);
    return widget;
}

function rowWithSuffix(title, widget) {
    const row = new Adw.ActionRow({title});
    row.add_suffix(widget);
    return row;
}

function padStatusText(service) {
    if (service.status) {
        const status = service.status;
        const control = service.control === 'released' ? _('released to the pad’s roller')
            : status.control === 'pad' ? _('the pad’s roller') : _('software control');
        const speed = status.off ? _('Off') : _('%d%%').format(status.speed);
        const details = [_('%s · %s · %s').format(speed,
            status.off ? _('pad and lights off') : status.lightsOff ? _('lights off') : _('lights on'),
            control)];
        if (service.noise)
            details.push(_('≈%d rpm · ≈%d dB · %s').format(service.noise.rpm,
                Math.round(service.noise.ear_db), service.noise.band));
        return details.join(' · ');
    }
    switch (service.error) {
    case 'not-found':
        return _('Cooling pad not connected (USB 374a:b101).');
    case 'no-access':
        return _('No access to the pad. Install llano-v12-linux’s udev rule, then reconnect it.');
    case 'no-script':
        return _('llano.py was not found. Set its location below.');
    case 'locked':
        return _('Locked off. Unlock the pad to change its speed.');
    case 'failed':
        return _('llano.py failed: %s').format(service.errorMessage || _('unknown error'));
    default:
        return _('Reading pad status…');
    }
}

function recommendationText(service) {
    if (service.lutError === 'missing')
        return _('fan_lut.json was not found. Set its location below or build it with llano-v12-linux’s research tools.');
    if (service.lutError === 'invalid')
        return _('fan_lut.json is not a readable fan table.');
    const rec = service.recommendation;
    if (!rec)
        return _('Waiting for CPU and GPU temperatures.');
    const leader = rec.device === 'gpu' ? _('GPU') : _('CPU');
    return _('Recommended %d%% · %s at %d °C%s').format(rec.fan, leader, Math.round(rec.temp),
        service.lut?.built ? ` · ${_('table of %s').format(service.lut.built)}` : '');
}

export function fanPage(settings, pageStack, window) {
    addIconPath(import.meta.url);
    const page = new Adw.PreferencesPage({
        name: 'fan',
        title: _('Fan'),
        icon_name: FAN_ICON_NAME,
    });

    const service = new FanService(settings);
    service.start();
    const setActive = () => service.setActive(pageStack.visible_child_name === 'fan');
    const pageChangedId = pageStack.connect('notify::visible-child-name', setActive);
    setActive();

    const pad = new Adw.PreferencesGroup({
        title: _('Cooling pad'),
        description: _('Control the llano V12 Ultra cooling pad. Off stops the fan and lights; 0% keeps the pad on at its slowest speed.'),
    });
    const status = new Adw.ActionRow({title: _('Pad status')});
    const stop = button(_('Stop it'), () => {
        if (service.controllers[0])
            service.stopController(service.controllers[0]);
    });
    status.add_suffix(stop);
    pad.add(status);
    const temperatures = new Adw.ActionRow({title: _('CPU / GPU temperatures')});
    pad.add(temperatures);

    const speed = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        draw_value: true,
        digits: 0,
        hexpand: true,
    });
    speed.set_range(0, 100);
    speed.set_increments(1, 10);
    speed.set_tooltip_text(_('Fan speed'));
    const speedRow = rowWithSuffix(_('Fan speed'), speed);
    pad.add(speedRow);

    let settingSpeed = false;
    let holdSliderUntil = 0;
    speed.connect('value-changed', () => {
        if (settingSpeed)
            return;
        holdSliderUntil = GLib.get_monotonic_time() / 1000 + 1500;
        service.setSpeed(speed.get_value());
    });

    const actions = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 6});
    const off = button(_('Off'), () => service.off());
    const zero = button(_('0%'), () => service.setSpeed(0));
    const half = button(_('50%'), () => service.setSpeed(50));
    const full = button(_('100%'), () => service.setSpeed(100));
    const lock = button(_('Lock off'), () => service.setLocked(!service.lock));
    const release = button(_('Release'), () => service.release());
    for (const item of [off, zero, half, full, lock, release])
        actions.append(item);
    pad.add(rowWithSuffix(_('Pad controls'), actions));

    const recommendation = new Adw.ActionRow({title: _('Recommended')});
    const apply = button(_('Apply'), () => {
        if (service.recommendation)
            service.setSpeed(service.recommendation.fan);
    });
    recommendation.add_suffix(apply);
    pad.add(recommendation);
    page.add(pad);

    const laptopGroup = new Adw.PreferencesGroup({
        title: _('Laptop fans'),
        description: _('Laptop fan telemetry and ASUS platform controls through asusd.'),
    });
    const laptopStatus = new Adw.ActionRow({title: _('Laptop')});
    laptopGroup.add(laptopStatus);
    const profileButtons = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 6});
    const profilesRow = rowWithSuffix(_('Platform profile'), profileButtons);
    laptopGroup.add(profilesRow);
    const curvesSwitch = new Gtk.Switch({valign: Gtk.Align.CENTER});
    const curvesRow = rowWithSuffix(_('Custom fan curves'), curvesSwitch);
    laptopGroup.add(curvesRow);
    const laptopNotice = new Adw.ActionRow({title: _('Laptop fan status')});
    laptopGroup.add(laptopNotice);
    page.add(laptopGroup);

    const settingsGroup = new Adw.PreferencesGroup({title: _('Fan settings')});
    const showSlider = new Adw.SwitchRow({
        title: _('Pad noise slider in Quick Settings'),
        subtitle: _('Adjust the connected llano pad by RPM, with estimated noise stages.'),
    });
    settings.bind('cooling-slider-enabled', showSlider, 'active', Gio.SettingsBindFlags.DEFAULT);
    settingsGroup.add(showSlider);
    const [, [lower, upper]] = settings.settings_schema.get_key('fan-interval')
        .get_range().recursiveUnpack();
    const interval = Adw.SpinRow.new_with_range(lower, upper, 1);
    interval.title = _('Refresh every (s)');
    settings.bind('fan-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);
    settingsGroup.add(interval);
    const script = new Adw.EntryRow({title: _('llano.py')});
    settings.bind('fan-llano-path', script, 'text', Gio.SettingsBindFlags.DEFAULT);
    settingsGroup.add(script);
    const lut = new Adw.EntryRow({title: _('Recommendation table (fan_lut.json)')});
    settings.bind('fan-lut-path', lut, 'text', Gio.SettingsBindFlags.DEFAULT);
    settingsGroup.add(lut);
    page.add(settingsGroup);

    let profilesKey = '';
    const sync = () => {
        status.subtitle = padStatusText(service);
        recommendation.subtitle = recommendationText(service);
        const cpu = service.temps?.cpu ?? null;
        const gpu = service.temps?.gpu ?? null;
        temperatures.subtitle = [
            cpu === null ? '' : _('CPU %d °C').format(Math.round(cpu)),
            gpu === null ? '' : _('hottest GPU %d °C').format(Math.round(gpu)),
        ].filter(Boolean).join(' · ') || _('Waiting for temperature readings.');
        stop.set_visible(Boolean(service.controllers.length) && !service.lock);
        stop.set_sensitive(!service.busy);

        const locked = Boolean(service.lock);
        lock.label = locked ? _('Unlock') : _('Lock off');
        // Not the slider while busy: a drag queues speeds, and an
        // insensitive slider would drop the drag.
        speed.set_sensitive(!locked);
        for (const control of [off, zero, half, full, release])
            control.set_sensitive(!locked && !service.busy);
        apply.set_sensitive(!locked && !service.busy && Boolean(service.recommendation) &&
            service.recommendation.fan !== service.status?.speed);
        const stopUnit = service.controllers[0];
        if (stopUnit) {
            status.subtitle += _(' · %s is setting the speed').format(stopUnit.replace(/\.service$/, ''));
        }

        if (service.status && !service.busy &&
            GLib.get_monotonic_time() / 1000 >= holdSliderUntil) {
            settingSpeed = true;
            speed.set_value(service.status.speed);
            settingSpeed = false;
        }

        const laptop = service.laptop;
        laptopGroup.set_visible(laptop.present);
        const fanSpeeds = laptop.fans.map(fan =>
            _('%s %d rpm').format(laptopFanName(fan.id), fan.rpm)).join(' · ');
        laptopStatus.subtitle = [laptop.model ?? _('ASUS laptop'), fanSpeeds,
            laptop.profile !== null ? profileName(laptop.profile) : ''].filter(Boolean).join(' · ');
        profilesRow.set_visible(laptop.profiles.length > 0);
        const key = laptop.profiles.join(',');
        if (key !== profilesKey) {
            for (let child = profileButtons.get_first_child(); child;) {
                const next = child.get_next_sibling();
                profileButtons.remove(child);
                child = next;
            }
            for (const profile of laptop.profiles) {
                const item = button(profileName(profile), () => service.setLaptopProfile(profile));
                item._profile = profile;
                profileButtons.append(item);
            }
            profilesKey = key;
        }
        for (let item = profileButtons.get_first_child(); item; item = item.get_next_sibling()) {
            item.set_sensitive(!service.laptopBusy);
            item.set_css_classes(item._profile === laptop.profile ? ['suggested-action'] : []);
        }

        const hasCurves = laptop.curves.length > 0;
        curvesRow.set_visible(hasCurves);
        // While a change is applied, the switch keeps what the user chose.
        if (hasCurves && !service.laptopBusy) {
            settingCurves = true;
            curvesSwitch.set_active(laptop.curves.some(curve => curve.enabled));
            settingCurves = false;
        }
        curvesSwitch.set_sensitive(!service.laptopBusy);
        const notice = laptop.daemon === false
            ? _('asusd is not running; laptop profile and curve controls are unavailable.')
            : laptop.readError ? _('asusd: %s').format(laptop.readError)
                : laptop.error ? _('asusd refused: %s').format(laptop.error) : '';
        laptopNotice.set_subtitle(notice);
        laptopNotice.set_visible(Boolean(notice));
    };
    let settingCurves = false;
    const changedId = service.connect('changed', sync);
    curvesSwitch.connect('notify::active', () => {
        if (!settingCurves)
            service.setLaptopCurves(curvesSwitch.get_active());
    });
    sync();
    window.connect('close-request', () => {
        service.disconnect(changedId);
        pageStack.disconnect(pageChangedId);
        service.stop();
        return false;
    });
    return page;
}
