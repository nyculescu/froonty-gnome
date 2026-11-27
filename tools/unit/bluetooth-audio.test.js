// SPDX-License-Identifier: GPL-3.0-or-later
// Bluetooth in the Sound Output menu: which devices it lists, their order,
// and which sound output is a device's (features/bluetoothAudio/devices.js).

import GnomeBluetooth from 'gi://GnomeBluetooth?version=3.0';

import {TYPE, isOutputOf, listedDevices, playsAudio} from '../../froonty@catalin/features/bluetoothAudio/devices.js';
import {done, eq, ok, test} from './test.js';

const ADDRESS = '00:1B:66:AA:0C:3F';

// As GnomeBluetooth reported the owner's devices (addresses made up).
const device = (alias, type, uuids, more = {}) => ({
    alias, type, uuids, paired: true, trusted: true, connectable: true, connected: false, ...more,
});
const headset = device('Crusher ANC 2', TYPE.HEADSET,
    ['SerialPort', 'HSP', 'AudioSink', 'A/V_RemoteControlTarget', 'Handsfree']);
const speaker = device('HUAWEI Sound Joy-26192', TYPE.SPEAKERS,
    ['AudioSink', 'A/V_RemoteControlTarget', 'Handsfree', 'GenericAudio']);
const keyboard = device('MX Keys', 256, ['Battery', 'Human Interface Device']);
const unknown = device('Dressing-9D117A', 0, [], {trusted: false, connectable: false});

test('the type flags are GnomeBluetooth\'s', () => {
    for (const name of Object.keys(TYPE))
        eq(TYPE[name], GnomeBluetooth.Type[name], name);
});

test('headsets, headphones, speakers and other audio play sound; keyboards and phones do not', () => {
    for (const type of [TYPE.HEADSET, TYPE.HEADPHONES, TYPE.OTHER_AUDIO, TYPE.SPEAKERS])
        ok(playsAudio({type, uuids: []}), `type ${type}`);
    ok(!playsAudio(keyboard));
    ok(!playsAudio({type: GnomeBluetooth.Type.PHONE, uuids: ['AudioSink', 'AudioSource']}), 'a phone');
});

test('a device of unknown kind plays sound only with A2DP (AudioSink)', () => {
    ok(playsAudio({type: 0, uuids: ['AudioSink']}));
    ok(playsAudio({type: TYPE.ANY, uuids: ['AudioSink']}));
    ok(!playsAudio({type: 0, uuids: ['Handsfree']}));
    ok(!playsAudio({type: 0, uuids: null}), 'no uuids');
});

test('lists paired or trusted audio devices that can connect, connected first, then by name', () => {
    eq(listedDevices([speaker, keyboard, unknown, headset]).map(d => d.alias),
        ['Crusher ANC 2', 'HUAWEI Sound Joy-26192']);
    const connectedSpeaker = {...speaker, connected: true};
    eq(listedDevices([headset, connectedSpeaker]).map(d => d.alias),
        ['HUAWEI Sound Joy-26192', 'Crusher ANC 2']);
    eq(listedDevices([{...headset, paired: false, trusted: false}]), [], 'only seen nearby');
    eq(listedDevices([{...headset, paired: false}]).length, 1, 'trusted');
    eq(listedDevices([{...headset, connectable: false}]), [], 'not connectable');
});

test('a sink is the device\'s by its address, as PipeWire and PulseAudio name it', () => {
    ok(isOutputOf('bluez_output.00_1B_66_AA_0C_3F.1', ADDRESS));
    ok(isOutputOf('bluez_output.00_1B_66_AA_0C_3F', ADDRESS));
    ok(isOutputOf('bluez_output.00_1b_66_aa_0c_3f.1', ADDRESS), 'any case');
    ok(isOutputOf('bluez_sink.00_1B_66_AA_0C_3F.a2dp_sink', ADDRESS));
    ok(!isOutputOf('bluez_output.00_1B_66_AA_0C_40.1', ADDRESS), 'another device');
    ok(!isOutputOf('bluez_input.00_1B_66_AA_0C_3F.0', ADDRESS), 'its microphone');
    ok(!isOutputOf('alsa_output.pci-0000_01_00.1.hdmi-stereo', ADDRESS));
    ok(!isOutputOf(null, ADDRESS));
});

await done();
