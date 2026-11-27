// SPDX-License-Identifier: GPL-3.0-or-later
// Which Bluetooth devices the Sound Output menu lists, in which order, and
// which sound output belongs to one; without the Shell (unit-tested).

// GnomeBluetooth.Type flags; the unit test checks them against the typelib.
export const TYPE = {
    ANY: 1,
    HEADSET: 32,
    HEADPHONES: 64,
    OTHER_AUDIO: 128,
    SPEAKERS: 1048576,
};
const AUDIO = TYPE.HEADSET | TYPE.HEADPHONES | TYPE.OTHER_AUDIO | TYPE.SPEAKERS;

/**
 * Whether a device plays sound: by its kind, or, when its kind is unknown,
 * by offering A2DP ("AudioSink" among GnomeBluetooth's uuids).
 *
 * @param {{type: number, uuids: ?string[]}} device
 * @returns {boolean}
 */
export function playsAudio({type, uuids}) {
    if (type & AUDIO)
        return true;
    return (type === 0 || type === TYPE.ANY) && (uuids ?? []).includes('AudioSink');
}

/**
 * The devices to list: paired or trusted, connectable and playing sound;
 * connected ones first, then by name, as GNOME's Bluetooth menu orders them.
 *
 * @param {object[]} devices GnomeBluetooth.Device or alike
 * @returns {object[]}
 */
export function listedDevices(devices) {
    return devices
        .filter(d => (d.paired || d.trusted) && d.connectable && playsAudio(d))
        .sort((a, b) => (b.connected - a.connected) || (a.alias ?? '').localeCompare(b.alias ?? ''));
}

/**
 * Whether a sound output (a sink) is the device's: PipeWire names it
 * bluez_output.<address with _>.<n>, PulseAudio bluez_sink.<address>.<profile>.
 *
 * @param {?string} sinkName
 * @param {string} address "AA:BB:CC:DD:EE:FF"
 * @returns {boolean}
 */
export function isOutputOf(sinkName, address) {
    const match = /^bluez_(?:output|sink)\.([0-9a-f]{2}(?:_[0-9a-f]{2}){5})(?:\.|$)/i.exec(sinkName ?? '');
    return Boolean(match) && match[1].toUpperCase() === address.replaceAll(':', '_').toUpperCase();
}
