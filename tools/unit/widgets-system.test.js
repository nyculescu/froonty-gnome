// SPDX-License-Identifier: GPL-3.0-or-later
// The System widget (features/widgets/system): its metrics read from a
// sampler snapshot, the history over its period, the moving average, the
// order of a row's parts, the readings a graph strokes, and the service's
// record, kept across a screen lock and dropped when switched off. Plain gjs.

import {lineRuns, timeColumns} from '../../froonty@catalin/features/widgets/system/line.js';
import {
    DEFAULT_METRICS, History, LAYOUTS, MINUTE_MS, SYSTEM_METRICS, chosenMetrics, layoutParts, metricById,
    movingAverage, systemNeeds,
} from '../../froonty@catalin/features/widgets/system/metrics.js';
import {SystemHistoryService, forgetHistory} from '../../froonty@catalin/features/widgets/system/service.js';
import {done, eq, ok, test} from './test.js';

// Shaped like Sampler.sample()'s answer.
const SNAPSHOT = {
    cpu: {load: 42, temp: 61, ghz: 3.4, cores: [{core: 0, temp: 60}, {core: 1, temp: 70}]},
    gpus: [{load: 12, temp: 48, power: 31, memUsed: 2e9, memTotal: 8e9, asleep: false},
        {load: null, temp: null, asleep: true}],
    memory: {total: 16e9, used: 4e9},
    disks: {root: {total: 1000, used: 250}, swap: {total: 8e9, used: 2e9}},
    network: {down: 1234567, up: 800},
};

const HISTORY_MS = 30 * MINUTE_MS;
const BASE = {'widgets-system-interval': 5, 'widgets-system-period': 30,
    'widgets-system-average': 'off', 'widgets-system-layout': 'value-name-graph'};

function fakeSettings(given) {
    const values = {...BASE, ...given};
    const handlers = new Map();
    let next = 1;
    return {
        get_strv: key => values[key],
        get_int: key => values[key],
        get_string: key => values[key],
        set_string(key, value) {
            this.set_strv(key, value);
        },
        set_strv(key, value) {
            values[key] = value;
            for (const [, [signal, fn]] of handlers) {
                if (signal === `changed::${key}`)
                    fn();
            }
        },
        connect(signal, fn) {
            handlers.set(next, [signal, fn]);
            return next++;
        },
        disconnect: id => handlers.delete(id),
        handlers,
    };
}

test('every metric reads its number from a snapshot', () => {
    const read = id => metricById(id).value(SNAPSHOT);
    eq([read('cpu-load'), read('cpu-temp'), read('cpu-temp-max'), read('cpu-clock')], [42, 65, 70, 3.4]);
    eq([read('ram-usage'), read('swap-usage'), read('disk-used')], [25, 25, 25]);
    eq([read('gpu-load'), read('gpu-temp'), read('gpu-memory'), read('gpu-power')], [12, 48, 25, 31]);
    eq([read('net-down'), read('net-up')], [1234567, 800]);
});

test('nothing to read is null, never zero (no snapshot, every card asleep)', () => {
    for (const metric of SYSTEM_METRICS)
        eq(metric.value(null), null, metric.id);
    eq(metricById('gpu-load').value({gpus: [{load: 5, asleep: true}]}), null);
});

test('printed as Btop prints them, with its colours', () => {
    eq(metricById('cpu-load').format(42), {text: '42%', styleClass: 'froonty-sysmon-cell-3'});
    ok(metricById('cpu-temp').format(61).color.startsWith('rgb('));
    eq(metricById('net-down').format(1234567).text, '1.2 MB/s');
    eq(metricById('net-up').format(800).text, '800 B/s');
    eq(metricById('cpu-clock').format(3.44).text, '3.4 GHz');
    eq(metricById('gpu-power').format(30.6).text, '31 W');
});

test('chosen: known ids only, in the catalog\'s order; only their sections are read', () => {
    eq(chosenMetrics(['net-up', 'nope', 'cpu-load', 'cpu-load']).map(m => m.id), ['cpu-load', 'net-up']);
    eq(systemNeeds(chosenMetrics(DEFAULT_METRICS)), {sections: ['cpu', 'memory', 'network'], cores: true});
    eq(systemNeeds(chosenMetrics(['ram-usage'])), {sections: ['memory'], cores: false});
});

test('history: the period\'s readings, nulls skipped, low and high', () => {
    const history = new History();
    eq(history.range(), null);
    history.add(0, 10, HISTORY_MS);
    history.add(60e3, null, HISTORY_MS);
    history.add(120e3, 30, HISTORY_MS);
    eq(history.points.length, 2);
    eq(history.range(), {min: 10, max: 30});
    history.add(HISTORY_MS + 60e3, 20, HISTORY_MS);
    eq(history.points.map(p => p.v), [30, 20], 'the reading older than 30 minutes went');
});

test('moving average: each point the mean of the window ending at it', () => {
    const points = [{t: 0, v: 0}, {t: 1000, v: 10}, {t: 2000, v: 0}, {t: 3000, v: 10}];
    eq(movingAverage(points, 0), points, 'off: as they are');
    eq(movingAverage(points, 2000).map(p => p.v), [0, 5, 5, 5]);
    eq(movingAverage(points, 1500).map(p => p.t), [0, 1000, 2000, 3000], 'times kept');
});

test('graph line: fewer readings than columns are all drawn, as they are', () => {
    const points = [{t: 0, v: 1}, {t: 1000, v: 5}, {t: 2000, v: 3}];
    eq(lineRuns(points, t => t / 1000, 3000), [points]);
});

test('graph line: per column only the low and the high, in time order, so spikes survive', () => {
    // Ten readings a column, a second apart.
    const points = Array.from({length: 30}, (_, i) => ({t: i * 1000, v: 10}));
    points[14].v = 95;
    points[22].v = 2;
    points[27].v = 40;
    eq(lineRuns(points, t => t / 10000, 3000).map(run => run.map(p => [p.t, p.v])),
        [[[0, 10], [10000, 10], [14000, 95], [22000, 2], [27000, 40]]], 'a flat column keeps one');
});

test('graph line: a pause breaks it, and no column joins the readings on either side', () => {
    const points = [{t: 0, v: 1}, {t: 1000, v: 9}, {t: 9000, v: 5}, {t: 9500, v: 7}, {t: 20000, v: 4}];
    eq(lineRuns(points, () => 0, 3000).map(run => run.map(p => p.v)), [[1, 9], [5, 7], [4]],
        'all in one column; a lone reading between pauses is a run of one');
});

test('graph line: a single reading is a run of one; none, no run', () => {
    eq(lineRuns([{t: 5, v: 3}], t => t, 1000), [[{t: 5, v: 3}]]);
    eq(lineRuns([], t => t, 1000), []);
});

test('graph line: 30 minutes at 2 s on 74 columns, at most two a column, same low and high', () => {
    const points = Array.from({length: 900}, (_, i) => ({t: i * 2000, v: 50 + 40 * Math.sin(i / 7)}));
    points[451].v = 140;
    points[600].v = -20;
    const columnOf = t => t / HISTORY_MS * 74;
    const runs = lineRuns(points, columnOf, 6000);
    eq(runs.length, 1);
    const kept = runs[0];
    const columns = kept.map(p => Math.floor(columnOf(p.t)));
    eq(new Set(columns).size, 74);
    ok(columns.every(c => columns.filter(other => other === c).length <= 2), JSON.stringify(columns));
    ok(kept.includes(points[451]) && kept.includes(points[600]), 'the spike and the dip');
    eq([Math.min(...kept.map(p => p.v)), Math.max(...kept.map(p => p.v))], [-20, 140]);
    ok(kept.every((p, i) => i === 0 || p.t > kept[i - 1].t), 'in time order');
});

test('graph line: columns fixed in time keep the same readings as the graph scrolls', () => {
    const points = Array.from({length: 901}, (_, i) => ({t: i * 2000, v: (i * 7919) % 101}));
    const columnOf = timeColumns(HISTORY_MS, 74);
    eq(columnOf(HISTORY_MS / 2), 37);
    const column = p => Math.floor(columnOf(p.t));
    // The columns the oldest reading leaving and the newest arriving do not touch.
    const inside = run => run.filter(p => column(p) > column(points[0]) && column(p) < column(points[899]));
    const [before] = lineRuns(points.slice(0, 900), columnOf, 6000);
    const [after] = lineRuns(points.slice(1), columnOf, 6000);
    ok(inside(before).length > 100, String(inside(before).length));
    eq(inside(after), inside(before));
});

test('a row\'s parts: six orders of value, name and graph; the default for an unknown one', () => {
    eq(LAYOUTS.length, 6);
    eq(layoutParts('graph-name-value'), ['graph', 'name', 'value']);
    eq(layoutParts('nope'), ['value', 'name', 'graph']);
    ok(LAYOUTS.every(l => [...l.split('-')].sort().join() === 'graph,name,value'));
});

test('service: the period and the average from the settings; a shorter period prunes at once', () => {
    forgetHistory();
    let now = 1e12;
    const settings = fakeSettings({'widgets-system-metrics': ['cpu-load'], 'widgets-system-average': '60'});
    const service = new SystemHistoryService(settings, {wallNow: () => now});
    eq([service.periodMs, service.averageMs], [30 * MINUTE_MS, 60000]);
    service.snapshot = SNAPSHOT;
    service.emit('changed');
    now += 20 * MINUTE_MS;
    service.emit('changed');
    eq(service.history('cpu-load').points.length, 2);
    settings.set_string('widgets-system-period', 10);
    settings.handlers.forEach(([signal, fn]) => signal === 'changed::widgets-system-period' && fn());
    eq(service.history('cpu-load').points.length, 1, 'the reading 20 minutes old went');
    service.stop();
});

test('service: each sample joins the history of each chosen metric', () => {
    forgetHistory();
    let now = 1e12;
    const settings = fakeSettings({'widgets-system-metrics': ['cpu-load', 'ram-usage']});
    const service = new SystemHistoryService(settings, {wallNow: () => now});
    eq([...service.sections], ['cpu', 'memory']);
    eq(service.interval, 5);
    service.snapshot = SNAPSHOT;
    service.emit('changed');
    now += 5000;
    service.snapshot = {...SNAPSHOT, cpu: {...SNAPSHOT.cpu, load: 50}};
    service.emit('changed');
    eq(service.history('cpu-load').points.map(p => p.v), [42, 50]);
    eq(service.history('ram-usage').points.length, 2);
    service.stop();
    eq(settings.handlers.size, 0, 'stop lets go of the settings');
});

test('service: the history outlives a screen lock, and goes when switched off', () => {
    forgetHistory();
    const settings = () => fakeSettings({'widgets-system-metrics': ['cpu-load']});
    const first = new SystemHistoryService(settings(), {wallNow: () => 1e12});
    first.snapshot = SNAPSHOT;
    first.emit('changed');
    first.stop();
    const again = new SystemHistoryService(settings(), {wallNow: () => 1e12 + 1000});
    eq(again.history('cpu-load').points.length, 1, 'a new card after unlock sees it');
    forgetHistory();
    eq(again.history('cpu-load'), null);
    again.stop();
});

test('service: a metric no longer chosen loses its history', () => {
    forgetHistory();
    const settings = fakeSettings({'widgets-system-metrics': ['cpu-load', 'net-down']});
    const service = new SystemHistoryService(settings, {wallNow: () => 1e12});
    service.snapshot = SNAPSHOT;
    service.emit('changed');
    settings.set_strv('widgets-system-metrics', ['cpu-load']);
    eq(service.history('net-down'), null);
    ok(service.history('cpu-load'));
    eq([...service.sections], ['cpu']);
    service.stop();
});

await done();
