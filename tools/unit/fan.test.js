// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {AsusFans, modelName, offeredProfiles, parseCurves, parseFans, profileNumber} from '../../froonty@catalin/features/fan/asus.js';
import {deviceFan, parseLut, recommend} from '../../froonty@catalin/features/fan/lut.js';
import {activeUnits, failureKind, parseLock, parseNoise, parseStatus} from '../../froonty@catalin/features/fan/pad.js';
import {done, eq, test} from './test.js';

const LUT = JSON.stringify({
    source: 'lut_sweep_2026-10-09.csv',
    built: '2026-10-09',
    devices: {
        gpu: {rows: [[40, 0], [60, 30], [75, 60]], loads: []},
        cpu: {rows: [[50, 0], [90, 30]], loads: []},
    },
});

test('pad: llano.py\'s status line, software and pad control', () => {
    eq(parseStatus('LOCKED  speed 0% (software control)  lights off  raw 80 00 00 82 04 00 ff fa').speed, 0);
    eq(parseStatus('speed 20% (software control)  lights off  raw 80 14 00 82 04 00 ff e6\n'),
        {speed: 20, control: 'software', off: false, lightsOff: true});
    // speed 0: the whole pad off (on_off), lights with it.
    const off = parseStatus('speed 0% (software control)  pad off  lights off  raw 80 00 01 00 04 00 ff 7b');
    eq([off.speed, off.off, off.lightsOff], [0, true, true]);
    eq(parseStatus('speed 60% (pad control)  lights on  raw 88 3c 00 03 04 00 ff 35').control, 'pad');
    eq(parseStatus('raw 81 00 00 00 00 00 00 7e'), null);
    eq(parseStatus(''), null);
});

test('pad: why llano.py failed', () => {
    eq(failureKind('llano pad 374a:b101 not found'), 'not-found');
    eq(failureKind("PermissionError: [Errno 13] Permission denied: '/dev/hidraw6'"), 'no-access');
    eq(failureKind("/usr/bin/python3: can't open file '/x/llano.py': [Errno 2] No such file or directory"),
        'no-script');
    eq(failureKind('Traceback ... OSError: [Errno 5] Input/output error'), 'failed');
    eq(failureKind('the pad is locked off (llano.py unlock to start it again)'), 'locked');
});

test('pad: the lock file', () => {
    eq(parseLock(null), null);
    eq(parseLock('{"time": 1, "by": "Froonty", "speed": 45, "ctl": "software"}\n').by, 'Froonty');
    eq(parseLock('garbage'), {});
});

test('pad: the noise line after the status', () => {
    const out = 'speed 12% (pad control)  lights on  raw 88 0c 00 03 04 00 ff 65\n' +
        'noise {"rpm": 600, "ear_db": 49.5, "band": "night", "limit": {"quiet": true, ' +
        '"until": "2026-10-10T07:00", "max_rpm": 600, "max_percent": 12, "override_until": null}}\n';
    eq(parseStatus(out).speed, 12);
    eq(parseNoise(out).limit.max_percent, 12);
    eq(parseNoise(out).band, 'night');
    eq(parseNoise('speed 12% (pad control)  lights on  raw 88 0c 00 03 04 00 ff 65'), null);
    eq(parseNoise('noise {broken'), null);
});

test('pad: units that drive the pad, from is-active\'s lines', () => {
    eq(activeUnits('active\ninactive\n'), ['llano-guard.service']);
    eq(activeUnits('inactive\nactive\n'), ['llanod.service']);
    eq(activeUnits(''), []);
});

test('lut: rows are interpolated and clamped at the ends', () => {
    const rows = parseLut(LUT).devices.gpu.rows;
    eq(deviceFan(rows, 30), 0);
    eq(deviceFan(rows, 50), 15);
    eq(deviceFan(rows, 75), 60);
    eq(deviceFan(rows, 95), 60);
});

test('lut: the device further up its curve leads', () => {
    const lut = parseLut(LUT);
    eq(recommend(lut, {cpu: 70, gpu: 45}), {fan: 15, device: 'cpu', temp: 70});
    eq(recommend(lut, {cpu: 70, gpu: 70}), {fan: 50, device: 'gpu', temp: 70});
    eq(recommend(lut, {cpu: 60, gpu: null}), {fan: 8, device: 'cpu', temp: 60});
    eq(recommend(lut, {cpu: null, gpu: null}), null);
});

test('lut: anything else is not a table', () => {
    eq(parseLut('not json'), null);
    eq(parseLut('{"devices": {}}'), null);
    eq(parseLut('{"devices": {"gpu": {"rows": [[40, "fast"]]}}}'), null);
});

// asusd 6.3.6 on a ROG Strix G634JZ: what FanCurveData answers for Performance.
const CURVES = [
    ['CPU', [28, 38, 63, 89, 109, 130, 168, 214], [40, 63, 67, 71, 75, 79, 83, 87], false],
    ['GPU', [38, 51, 76, 102, 122, 155, 191, 219], [40, 63, 67, 71, 75, 79, 83, 87], true],
];

test('asus: the profiles offered are asusd\'s that the firmware lists, quietest first', () => {
    eq(offeredProfiles([3, 2, 0, 1], 'quiet balanced performance\n'), [2, 0, 1]);
    eq(offeredProfiles([1, 0, 3], 'low-power balanced performance'), [3, 0, 1]);
    eq(offeredProfiles([1, 0, 2], null), [2, 0, 1]);
    eq(offeredProfiles([9, 0], null), [0]);
});

test('asus: fan curves, PWM as percent, and whether they are on', () => {
    const curves = parseCurves(CURVES);
    eq(curves[0].fan, 'cpu');
    eq(curves[0].points[0], [40, 11]);
    eq(curves[1].points[7], [87, 86]);
    eq(curves.map(c => c.enabled), [false, true]);
});

test('asus: the hwmon fans and the model name', () => {
    eq(parseFans({fan2_input: '2700\n', fan1_input: '2500\n', fan1_label: 'cpu_fan\n', fan2_label: 'gpu_fan',
        fan3_input: '0', pwm1_enable: '2'}),
    [{n: 1, id: 'cpu', rpm: 2500}, {n: 2, id: 'gpu', rpm: 2700}, {n: 3, id: 'fan3', rpm: 0}]);
    eq(parseFans({fan1_input: 'garbage'}), []);
    eq(modelName('ROG Strix G634JZ_G634JZ\n'), 'ROG Strix G634JZ');
    eq(modelName(null), null);
    eq(profileNumber('performance\n'), 1);
    eq(profileNumber('quiet'), 2);
    eq(profileNumber('turbo'), null);
    eq(profileNumber(null), null);
});

// A fake /sys and a fake asusd: the bus answers like Gio.DBusConnection.call.
function fakeLaptop({daemon = true} = {}) {
    const files = {
        '/sys/class/hwmon/hwmon9/name': 'asus\n',
        '/sys/class/hwmon/hwmon2/name': 'BAT0\n',
        '/sys/class/hwmon/hwmon9/fan1_input': '2500\n',
        '/sys/class/hwmon/hwmon9/fan1_label': 'cpu_fan\n',
        '/sys/firmware/acpi/platform_profile': 'performance\n',
        '/sys/firmware/acpi/platform_profile_choices': 'quiet balanced performance\n',
        '/sys/class/dmi/id/product_name': 'ROG Strix G634JZ_G634JZ\n',
    };
    const io = {
        read: async path => files[path] ?? null,
        list: async path => [...new Set(Object.keys(files).filter(f => f.startsWith(`${path}/`))
            .map(f => f.slice(path.length + 1).split('/')[0]))],
    };
    const state = {profile: 1, enabled: false, calls: []};
    const bus = {
        call: async (_name, _path, iface, method, params) => {
            state.calls.push(`${iface} ${method}`);
            if (!daemon)
                throw new GLib.Error(Gio.DBusError, Gio.DBusError.SERVICE_UNKNOWN, 'not there');
            const args = params?.deepUnpack();
            if (method === 'Get' && args[1] === 'PlatformProfile')
                return new GLib.Variant('(v)', [new GLib.Variant('u', state.profile)]);
            if (method === 'Get')
                return new GLib.Variant('(v)', [new GLib.Variant('au', [3, 2, 0, 1])]);
            if (method === 'Set') {
                state.profile = args[2].deepUnpack();
                files['/sys/firmware/acpi/platform_profile'] = `${{0: 'balanced', 1: 'performance', 2: 'quiet'}[state.profile]}\n`;
                return new GLib.Variant('()', []);
            }
            if (method === 'SetFanCurvesEnabled') {
                if (args[0] !== state.profile)
                    throw new Error('wrong profile');
                state.enabled = args[1];
                return new GLib.Variant('()', []);
            }
            return new GLib.Variant('(a(s(yyyyyyyy)(yyyyyyyy)b))',
                [CURVES.map(([fan, pwm, temp]) => [fan, pwm, temp, state.enabled])]);
        },
    };
    return {laptop: new AsusFans(io, {bus}), state, files};
}

test('asus: reads the fans, the profile and its curves, and changes them', async () => {
    const {laptop, state, files} = fakeLaptop();
    await laptop.refresh();
    eq(laptop.present, true);
    eq(laptop.model, 'ROG Strix G634JZ');
    eq(laptop.fans, [{n: 1, id: 'cpu', rpm: 2500}]);
    eq([laptop.daemon, laptop.profile, laptop.profiles], [true, 1, [2, 0, 1]]);
    eq(laptop.curves.some(c => c.enabled), false);
    await laptop.setProfile(2);
    eq([state.profile, laptop.profile], [2, 2]);
    await laptop.setCurvesEnabled(true);
    eq([state.enabled, laptop.curves.every(c => c.enabled), laptop.error], [true, true, '']);

    // A tick reads the rpm and platform_profile only; asusd is asked for
    // the curves again only when the profile changed (here, from GNOME).
    state.calls.length = 0;
    files['/sys/class/hwmon/hwmon9/fan1_input'] = '3100\n';
    await laptop.refresh();
    eq([laptop.fans[0].rpm, state.calls], [3100, []]);
    files['/sys/firmware/acpi/platform_profile'] = 'balanced\n';
    await laptop.refresh();
    eq([laptop.profile, state.calls], [0, ['xyz.ljones.FanCurves FanCurveData']]);
});

test('asus: without asusd, only the fans', async () => {
    const {laptop} = fakeLaptop({daemon: false});
    await laptop.refresh();
    eq([laptop.present, laptop.daemon, laptop.profile, laptop.profiles, laptop.curves, laptop.readError],
        [true, false, null, [], [], '']);
    eq(laptop.fans.length, 1);
});

await done();
