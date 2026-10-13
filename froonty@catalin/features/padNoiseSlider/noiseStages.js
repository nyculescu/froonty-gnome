// SPDX-License-Identifier: GPL-3.0-or-later

export const NOISE_STAGES = [
    {name: 'Near-silent', rpm: 300, color: '#4caf50'},
    {name: 'Almost quiet', rpm: 400, color: '#8bc34a'},
    {name: 'Comfortable', rpm: 600, color: '#cddc39'},
    {name: 'Noticeably loud', rpm: 1000, color: '#ffc107'},
    {name: 'Loud', rpm: 2000, color: '#ff7043'},
    {name: 'Get out of here loud', rpm: 2800, color: '#f44336'},
];

const EAR_DB_POINTS = [
    [300, 40.5], [400, 43], [500, 45.5], [600, 49.5], [700, 51.5],
    [800, 53.5], [900, 55.5], [1000, 57], [1175, 62],
];
export const MIN_RPM = NOISE_STAGES[0].rpm;
export const MAX_RPM = NOISE_STAGES.at(-1).rpm;
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

export function stageForRpm(rpm) {
    return [...NOISE_STAGES].reverse().find(stage => rpm >= stage.rpm) ?? NOISE_STAGES[0];
}

export function estimatedDb(rpm) {
    const bounded = Math.max(MIN_RPM, Math.min(MAX_RPM, rpm));
    for (let i = 1; i < EAR_DB_POINTS.length; i++) {
        const upper = EAR_DB_POINTS[i];
        if (bounded <= upper[0]) {
            const lower = EAR_DB_POINTS[i - 1];
            const amount = (bounded - lower[0]) / (upper[0] - lower[0]);
            return lower[1] + amount * (upper[1] - lower[1]);
        }
    }
    return 62 + 30 * Math.log10(bounded / 1175);
}
