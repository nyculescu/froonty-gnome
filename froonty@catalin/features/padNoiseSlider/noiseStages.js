// SPDX-License-Identifier: GPL-3.0-or-later

// The pad's measured range (third_party/llano-v12-linux/NOISE.md).
export const MIN_RPM = 300;
export const MAX_RPM = 2800;
// The pad's speeds are 50 RPM apart (its display: 300, 350, 400, ...).
export const RPM_STEP = 50;

/** The pad speed nearest to `rpm`, within MIN_RPM-MAX_RPM. */
export function snapRpm(rpm) {
    const bounded = Math.max(MIN_RPM, Math.min(MAX_RPM, rpm));
    return MIN_RPM + Math.round((bounded - MIN_RPM) / RPM_STEP) * RPM_STEP;
}

export function rpmToSlider(rpm) {
    return (Math.max(MIN_RPM, Math.min(MAX_RPM, rpm)) - MIN_RPM) / (MAX_RPM - MIN_RPM);
}

/** The pad speed for a slider position, snapped to RPM_STEP. */
export function sliderToRpm(value) {
    return snapRpm(MIN_RPM + Math.max(0, Math.min(1, value)) * (MAX_RPM - MIN_RPM));
}
