// SPDX-License-Identifier: GPL-3.0-or-later

import {
    MAX_RPM, MIN_RPM, NOISE_STAGES, rpmToSlider, sliderToRpm, snapRpm,
} from '../../froonty@catalin/features/padNoiseSlider/noiseStages.js';
import {done, eq, test} from './test.js';

test('pad noise slider: endpoints map to measured RPM range', () => {
    eq(MIN_RPM, 300);
    eq(MAX_RPM, 2800);
    eq(rpmToSlider(300), 0);
    eq(rpmToSlider(2800), 1);
    eq(sliderToRpm(0), 300);
    eq(sliderToRpm(1), 2800);
});

test('pad noise slider: target conversion is bounded and round-trips', () => {
    eq(sliderToRpm(-1), 300);
    eq(sliderToRpm(2), 2800);
    for (const rpm of [300, 400, 600, 1000, 2000, 2800])
        eq(sliderToRpm(rpmToSlider(rpm)), rpm);
});

test('pad noise slider: the pad\'s 50 RPM steps', () => {
    eq(snapRpm(437), 450);
    eq(snapRpm(424), 400);
    eq(snapRpm(10), 300);
    eq(snapRpm(9000), 2800);
    eq(sliderToRpm(0.5), 1550);
    eq(sliderToRpm(0.009), 300);
    eq(sliderToRpm(0.011), 350);
    for (const rpm of [300, 400, 600, 1000, 2000, 2800])
        eq(snapRpm(rpm), rpm);
});

test('pad noise slider: stages match the requested order and thresholds', () => {
    eq(NOISE_STAGES.map(stage => [stage.name, stage.rpm]), [
        ['Near-silent', 300],
        ['Almost quiet', 400],
        ['Comfortable', 600],
        ['Noticeably loud', 1000],
        ['Loud', 2000],
        ['Get out of here loud', 2800],
    ]);
});

await done();
