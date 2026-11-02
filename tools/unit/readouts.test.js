// SPDX-License-Identifier: GPL-3.0-or-later
// Readouts: the catalog rules and what each prints (pure).

import {test, eq, ok, done} from './test.js';
import * as Catalog from '../../froonty@catalin/readouts/catalog.js';
import {METRICS, claudeUsage, compactSpeed, metricNeeds, shortCityName} from '../../froonty@catalin/readouts/values.js';

const NOW = 1_800_000_000_000;

test('sanitize keeps known ids in order, drops unknown and duplicates', () => {
    eq(Catalog.sanitize(['ram-usage', 'nope', 'ram-usage', 'cpu-load']), ['ram-usage', 'cpu-load']);
});

test('sanitize keeps 8 readouts and drops a 9th', () => {
    const ids = Catalog.READOUTS.map(r => r.id);
    ok(ids.length > Catalog.MAX_READOUTS, 'the catalog offers more than fit');
    eq(Catalog.MAX_READOUTS, 8);
    eq(Catalog.sanitize(ids), ids.slice(0, 8));
});

test('balancedSplit: splits where the widths come closest, not by count', () => {
    eq(Catalog.balancedSplit([46, 46, 46, 90, 50], 10, 2), 3);
    eq(Catalog.balancedSplit([90, 20, 20, 20], 10, 2), 1);
});

test('balancedSplit: a tie gives the right side more; one readout goes right', () => {
    eq(Catalog.balancedSplit([46, 46, 46], 10, 0), 1);
    eq(Catalog.balancedSplit([46], 10, 0), 0);
    eq(Catalog.balancedSplit([], 10, 0), 0);
});

test('balancedSplit: keeps the current split unless clearly beaten', () => {
    eq(Catalog.balancedSplit([46, 46, 46, 50], 0, 3), 2, 'the current one is far off');
    eq(Catalog.balancedSplit([50, 40, 45, 45], 0, 1), 2);
    eq(Catalog.balancedSplit([50, 44, 50, 40], 0, 2), 2, 'already the best');
    eq(Catalog.balancedSplit([40, 40, 45], 0, 1), 1, 'a better split by 5 px is not worth a move');
});

test('balancedSplit: a hidden readout takes no room and no spacing', () => {
    eq(Catalog.balancedSplit([50, 0, 50], 10, 0), 1);
    eq(Catalog.balancedSplit([0, 0, 0], 10, 1), 1, 'nothing shown: stays');
});

test('shortCityName: three letters, or a name\'s initials', () => {
    eq(shortCityName('Dublin'), 'Dub');
    eq(shortCityName('Oslo'), 'Osl');
    eq(shortCityName('Rome'), 'Rom');
    eq(shortCityName('Ulm'), 'Ulm');
    eq(shortCityName('New York'), 'NY');
    eq(shortCityName('Ho Chi Minh City'), 'HCMC');
    eq(shortCityName('  São  Paulo '), 'SP');
    eq(shortCityName('Île'), 'Île');
});

test('every catalog entry has an id, an icon and a translatable title', () => {
    for (const r of Catalog.READOUTS) {
        eq(typeof r.id, 'string');
        eq(r.icon.endsWith('-symbolic'), true, r.id);
        eq(r.title(s => `[${s}]`).startsWith('['), true, r.id);
    }
});

test('nothing that acts is offered', () => {
    const ids = Catalog.READOUTS.map(r => r.id);
    for (const action of ['pin-island', 'mute-microphone', 'mute-sound', 'pause-media', 'fan-lock'])
        ok(!ids.includes(action), action);
});

test('every metric is in the catalog', () => {
    for (const id of Object.keys(METRICS))
        ok(Catalog.byId(id), id);
});

test('metricNeeds asks only for the chosen sections, and for cores only when needed', () => {
    eq(metricNeeds([]), {sections: [], cores: false});
    eq(metricNeeds(['claude-session', 'timezone-1']), {sections: [], cores: false});
    eq(metricNeeds(['ram-usage', 'net-down', 'net-up']), {sections: ['memory', 'network'], cores: false});
    eq(metricNeeds(['cpu-load', 'cpu-temp']), {sections: ['cpu'], cores: true});
});

test('loads print a whole percentage in their level colour; unknown is null', () => {
    const value = METRICS['cpu-load'].read({cpu: {load: 37.4}});
    eq(value.text, '37%');
    eq(value.styleClass, 'froonty-sysmon-cell-2');
    eq(METRICS['cpu-load'].read({cpu: {load: null}}), null);
    eq(METRICS['cpu-load'].read(null), null);
    eq(METRICS['ram-usage'].read({memory: {used: 1, total: 4}}).text, '25%');
    eq(METRICS['disk-used'].read({disks: {root: {used: 3, total: 4}}}).text, '75%');
    eq(METRICS['disk-used'].read({disks: {root: null}}), null);
});

test('temperatures print °C with a colour; average and hottest differ', () => {
    const snapshot = {cpu: {temp: 60, cores: [{core: 0, temp: 50}, {core: 1, temp: 70}]}};
    eq(METRICS['cpu-temp'].read(snapshot).text, '60°C');
    eq(METRICS['cpu-temp-max'].read(snapshot).text, '70°C');
    ok(METRICS['cpu-temp'].read(snapshot).color.startsWith('rgb('));
});

test('a sleeping graphics card is asleep, not unknown', () => {
    const asleep = {gpus: [{asleep: true, load: null, temp: null}]};
    eq(METRICS['gpu-load'].read(asleep), {text: '–', asleep: true});
    eq(METRICS['gpu-temp'].read(asleep), {text: '–', asleep: true});
    eq(METRICS['gpu-load'].read({gpus: []}), null);
    const awake = {gpus: [{asleep: true, load: null, temp: null}, {asleep: false, load: 40, temp: 55}]};
    eq(METRICS['gpu-load'].read(awake).text, '40%');
    eq(METRICS['gpu-temp'].read(awake).text, '55°C');
});

test('speeds stay short', () => {
    const text = bytes => compactSpeed(bytes).text;
    eq(text(0), '0K');
    eq(text(850_000), '850K');
    eq(text(1_200_000), '1.2M');
    eq(text(12_400_000), '12M');
    eq(text(2_500_000_000), '2.5G');
    eq(compactSpeed(null), null);
    eq(METRICS['net-down'].read({network: {down: 1_200_000, up: 0}}).text, '1.2M');
    eq(METRICS['net-up'].read({network: {down: 1_200_000, up: 0}}).text, '0K');
});

test('Claude\'s usage follows the tab\'s rules', () => {
    const usage = {windows: [
        {kind: 'session', percent: 13.4, resetsAt: NOW + 1000},
        {kind: 'weekly', percent: 120, resetsAt: null},
    ]};
    eq(claudeUsage(usage, true, 'session', NOW).text, '13%');
    eq(claudeUsage(usage, true, 'weekly', NOW).text, '100%', 'capped');
    eq(claudeUsage(usage, false, 'session', NOW), null, 'offline');
    eq(claudeUsage(usage, true, 'session', NOW + 1000), null, 'renewed since the reading');
    eq(claudeUsage(null, true, 'session', NOW), null, 'no reading');
});

await done();
