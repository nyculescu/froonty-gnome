// SPDX-License-Identifier: GPL-3.0-or-later
import {deviceFan, parseLut, recommend} from '../../froonty@catalin/features/fan/lut.js';
import {activeUnits, failureKind, parseLastControl, parseLock, parseStatus} from '../../froonty@catalin/features/fan/pad.js';
import {physicalCores} from '../../froonty@catalin/features/fan/service.js';
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
        {speed: 20, control: 'software', lightsOff: true, raw: '80 14 00 82 04 00 ff e6'});
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

test('pad: the lock file and the last control.log entry', () => {
    eq(parseLock(null), null);
    eq(parseLock('{"time": 1, "by": "Froonty", "speed": 45, "ctl": "software"}\n').by, 'Froonty');
    eq(parseLock('garbage'), {});
    eq(parseLastControl('{"by": "a", "action": "speed", "speed": 10}\n{"by": "llano-guard", "action": "speed", "speed": 40}\n'),
        {by: 'llano-guard', action: 'speed', speed: 40});
    eq(parseLastControl(''), null);
    eq(parseLastControl(null), null);
});

test('pad: units that drive the pad, from is-active\'s lines', () => {
    eq(activeUnits('active\ninactive\n'), ['llano-guard.service']);
    eq(activeUnits('inactive\nactive\n'), ['llanod.service']);
    eq(activeUnits(''), []);
});

test('cores: one per physical core, with its thread count', () => {
    eq(physicalCores([
        {cpu: 0, core: 0, temp: 50}, {cpu: 1, core: 0, temp: 50},
        {cpu: 2, core: 32, temp: 45}, {cpu: 3, core: null, temp: 40},
    ]), [{core: 0, temp: 50, threads: 2}, {core: 32, temp: 45, threads: 1}]);
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

await done();
