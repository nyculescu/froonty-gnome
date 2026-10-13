// SPDX-License-Identifier: GPL-3.0-or-later

import {
    estimatedDb, MAX_RPM, MIN_RPM, NOISE_STAGES, RPM_STEP, rpmToSlider, sliderToRpm, snapRpm, stageForRpm,
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
    eq(RPM_STEP, 50);
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
    eq(stageForRpm(599).name, 'Almost quiet');
    eq(stageForRpm(600).name, 'Comfortable');
    eq(stageForRpm(2800).name, 'Get out of here loud');
});

test('pad noise slider: noise estimates are bounded and rise with RPM', () => {
    eq(estimatedDb(300), 40.5);
    eq(Math.round(estimatedDb(2000)), 69);
    eq(Math.round(estimatedDb(2800) * 10) / 10, 73.3);
    eq(estimatedDb(0), estimatedDb(300));
    eq(estimatedDb(3000), estimatedDb(2800));
    eq(estimatedDb(1000) > estimatedDb(600), true);
});

done();
