// SPDX-License-Identifier: GPL-3.0-or-later
// The Fan tab's recommendation: llano-v12-linux's fan_lut.json, built from
// a load x fan sweep (research/lut_sweep.py, research/build_lut.py). Each
// device has rows of [temperature °C, fan %], sorted by temperature and
// non-decreasing in fan; between rows the speed is interpolated, outside
// them it is the nearest row's. The machine's recommendation is the
// highest of its devices' (whichever is further up its own curve leads),
// as build_lut.py's recommend(). No St.

/**
 * The LUT from fan_lut.json's text, or null when it is not one.
 *
 * @returns {?{devices: Object<string, {rows: number[][]}>, source: string, built: string}}
 */
export function parseLut(text) {
    let lut;
    try {
        lut = JSON.parse(text);
    } catch (e) {
        return null;
    }
    const devices = {};
    for (const [device, entry] of Object.entries(lut?.devices ?? {})) {
        const rows = entry?.rows;
        if (!Array.isArray(rows) || !rows.length ||
            !rows.every(row => Array.isArray(row) && row.length === 2 && row.every(Number.isFinite)))
            return null;
        devices[device] = {rows};
    }
    if (!Object.keys(devices).length)
        return null;
    return {devices, source: lut.source ?? '', built: lut.built ?? ''};
}

/** One device's speed (0-100) at `temp`, from its rows. */
export function deviceFan(rows, temp) {
    if (temp <= rows[0][0])
        return rows[0][1];
    if (temp >= rows[rows.length - 1][0])
        return rows[rows.length - 1][1];
    for (let i = 1; i < rows.length; i++) {
        const [[t0, f0], [t1, f1]] = [rows[i - 1], rows[i]];
        if (temp <= t1)
            return t1 > t0 ? f0 + (f1 - f0) * (temp - t0) / (t1 - t0) : Math.max(f0, f1);
    }
    return rows[rows.length - 1][1];
}

/**
 * The recommended speed for {device: temperature} (null temperatures and
 * devices without rows are left out): {fan, device, temp}, or null.
 */
export function recommend(lut, temps) {
    let best = null;
    for (const [device, temp] of Object.entries(temps)) {
        const rows = lut?.devices[device]?.rows;
        if (!rows || temp === null || temp === undefined)
            continue;
        const fan = Math.round(deviceFan(rows, temp));
        if (!best || fan > best.fan)
            best = {fan, device, temp};
    }
    return best;
}
