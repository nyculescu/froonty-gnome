// SPDX-License-Identifier: GPL-3.0-or-later

export const NOISE_STAGES = [
    {name: 'Near-silent', rpm: 300, color: '#4caf50'},
    {name: 'Almost quiet', rpm: 400, color: '#8bc34a'},
    {name: 'Comfortable', rpm: 600, color: '#cddc39'},
    {name: 'Noticeably loud', rpm: 1000, color: '#ffc107'},
    {name: 'Loud', rpm: 2000, color: '#ff7043'},
    {name: 'Get out of here loud', rpm: 2800, color: '#f44336'},
];

export const MIN_RPM = NOISE_STAGES[0].rpm;
export const MAX_RPM = NOISE_STAGES.at(-1).rpm;
// The pad's speeds are 50 RPM apart (its display: 300, 350, 400, ...).
const RPM_STEP = 50;

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
