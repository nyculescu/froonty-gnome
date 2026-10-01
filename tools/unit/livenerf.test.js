// SPDX-License-Identifier: GPL-3.0-or-later
// livenerf: the README and chart readers (pure), checked against the
// submodule's real files too, and the service with a fake fetch (plain
// gjs, no network).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {test, eq, ok, done} from './test.js';
import * as Livenerf from '../../froonty@catalin/features/claude/livenerf.js';
import {LivenerfService, MIN_FETCH_INTERVAL_MS} from '../../froonty@catalin/features/claude/livenerfService.js';
import {ClaudeService} from '../../froonty@catalin/features/claude/service.js';

// Shaped like livenerf's README on 2026-09-30 (day 7): hard-wrapped
// progress line, a Results table with only the baseline row.
const PROGRESS = `## Status

**The series is running.** Day 1 was 2026-09-24 22:10 UTC.

**Progress (2026-09-30):** 7 of 30 days collected (baseline 7 of
10), none missed. All 7 days ran the full 90 samples.
`;

const TABLE_HEAD = `## Results

The main thing this repo will maintain is a running 10-day table.

| # | window | samples | score | Δ vs baseline ± SE | output tok (median) | control Δ | CLI | decision |
|---|------|---------|-------|--------------------|---------------------|-----------|-----|----------|
| 0 | days 1–10 (from 2026-09-24) | - | - | baseline | - | baseline | pinned | baseline (collecting) |
`;

const TABLE_TAIL = `
The primary metric is the paired per-item score difference.

## Getting started
`;

const readme = (rows = '') => `# livenerf\n\n${PROGRESS}\n${TABLE_HEAD}${rows}${TABLE_TAIL}`;

// ---- parser

test('livenerf: the progress line, across a line break; no Δ yet', () => {
    eq(Livenerf.benchmarkFromReadme(readme()), {
        progress: {date: '2026-09-30', collected: 7, total: 30,
            baselineCollected: 7, baselineTotal: 10},
        result: null,
    });
});

test('livenerf: the last row with a Δ, Unicode minus and emphasis included', () => {
    const {result} = Livenerf.benchmarkFromReadme(readme(
        '| 1 | days 11–20 | 7020 | 61.2% | **−2.1 ± 1.4** | 812 | +0.3 ± 1.9 | pinned | no change |\n' +
        '| 2 | days 21–30 | 7020 | 60.0% | −3.4 pts ± 1.5 | 790 | −0.2 ± 2.0 | pinned | pending |\n'));
    eq(result, {window: 'days 21–30', delta: -3.4, se: 1.5, deltaText: '−3.4 pts ± 1.5',
        decision: 'pending'});
});

test('livenerf: a positive Δ keeps its sign; columns found by name, not place', () => {
    const text = readme().replace('| # | window | samples | score | Δ vs baseline ± SE |',
        '| # | samples | window | Δ vs baseline ± SE | score |');
    const {result} = Livenerf.benchmarkFromReadme(text.replace(
        '| 0 | days 1–10 (from 2026-09-24) | - | - | baseline |',
        '| 1 | 7020 | days 11–20 | +0.8 ± 1.2 | 62.0% |'));
    eq([result.window, result.delta, result.se, result.decision], ['days 11–20', 0.8, 1.2, 'baseline (collecting)']);
});

test('livenerf: nothing recognisable is null, not a guess', () => {
    eq(Livenerf.benchmarkFromReadme(''), null);
    eq(Livenerf.benchmarkFromReadme(null), null);
    eq(Livenerf.benchmarkFromReadme('<html>404: Not Found</html>'), null);
    // A Δ in a format not known here is left out.
    eq(Livenerf.benchmarkFromReadme(TABLE_HEAD +
        '| 1 | days 11–20 | 1 | 1 | about minus two | 1 | 1 | 1 | ? |\n'), null);
    // Days that do not add up.
    eq(Livenerf.benchmarkFromReadme('**Progress (2026-10-01):** 31 of 30 days collected'), null);
});

// A chart in livenerf/plot.py's format: 40–80% over y 328–92, the plot
// from x 64 to 932.
const CHART = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="380">
<title id="t">Claude Opus 5.5 compared with its own launch week</title>
<rect width="960" height="380" rx="10" fill="#1a1a19"/>
<line x1="64" y1="328.0" x2="932" y2="328.0" stroke="#2c2c2a" stroke-width="1"/>
<text x="54" y="332.0" text-anchor="end" fill="#898781" font-size="12">40%</text>
<line x1="64" y1="92.0" x2="932" y2="92.0" stroke="#2c2c2a" stroke-width="1"/>
<text x="54" y="96.0" text-anchor="end" fill="#898781" font-size="12">80%</text>
<rect x="64.0" y="92" width="271.2" height="236" fill="#2c2c2a" opacity="0.6"/>
<text x="64.0" y="350" text-anchor="middle" fill="#898781" font-size="12">Sep 24</text>
<text x="498.0" y="350" text-anchor="middle" fill="#898781" font-size="12">Oct 08</text>
<line x1="64" y1="210.0" x2="932" y2="210.0" stroke="#c3c2b7" stroke-width="1.5" stroke-dasharray="6 5"/>
<text x="928" y="204.0" text-anchor="end" fill="#c3c2b7" font-size="12">baseline 60.0%</text>
<line x1="77.6" y1="269.0" x2="77.6" y2="151.0" stroke="#3987e5" stroke-width="1.5" opacity="0.5"/>
<circle cx="77.6" cy="210.0" r="3.5" fill="#3987e5" stroke="#1a1a19" stroke-width="1.5"/>
<line x1="498.0" y1="298.5" x2="498.0" y2="180.5" stroke="#3987e5" stroke-width="1.5" opacity="0.5"/>
<circle cx="498.0" cy="239.5" r="3.5" fill="#3987e5" stroke="#1a1a19" stroke-width="1.5"/>
<text x="508.0" y="231.5" fill="#ffffff" font-size="13" font-weight="600">55.0%</text>
<text x="932" y="368" text-anchor="end" fill="#898781" font-size="11">546 samples · updated 2026-09-30 19:44 UTC</text>
</svg>`;

test('livenerf chart: scores and intervals read back through the grid', () => {
    const chart = Livenerf.chartFromSvg(CHART);
    const round = v => Math.round(v * 100) / 100;
    eq(chart.points.map(p => [round(p.at), round(p.score), round(p.low), round(p.high)]),
        [[0.02, 60, 50, 70], [0.5, 55, 45, 65]]);
    eq(chart.grid, [40, 80]);
    eq(chart.band.map(round), [0, 0.31]);
    eq(chart.ticks.map(t => [round(t.at), t.label]), [[0, 'Sep 24'], [0.5, 'Oct 08']]);
    eq([chart.latest, chart.baselineMean, chart.collecting, chart.samples],
        [55, 60, null, 546]);
    eq(chart.updated, Date.parse('2026-09-30T19:44:00Z'));
});

test('livenerf chart: while collecting, the note; without points or a grid, null', () => {
    const collecting = CHART.replace(/<line x1="64" y1="210.0"[^\n]*\n<text[^\n]*baseline 60.0%<\/text>/,
        '<text x="633.6" y="210.0" text-anchor="middle" font-size="14">Collecting the baseline: day 7 of 10.</text>');
    const chart = Livenerf.chartFromSvg(collecting);
    eq([chart.baselineMean, chart.collecting], [null, {day: 7, of: 10}]);
    eq(Livenerf.chartFromSvg(CHART.replace(/<circle[^>]*>/g, '')), null);
    eq(Livenerf.chartFromSvg(CHART.replace(/>\d+%<\/text>/g, '>?</text>')), null);
    eq(Livenerf.chartFromSvg('404: Not Found'), null);
    eq(Livenerf.chartFromSvg(null), null);
});

// The submodule, when checked out: the readers still understand upstream.
const upstream = path => {
    const file = Gio.File.new_for_path(GLib.build_filenamev([
        GLib.path_get_dirname(import.meta.url.replace('file://', '')),
        '..', '..', 'third_party', 'livenerf', path]));
    if (!file.query_exists(null)) {
        print(`  (skipped: ${file.get_path()} not checked out; git submodule update --init)`);
        return null;
    }
    return new TextDecoder().decode(file.load_contents(null)[1]);
};

test('livenerf: the README in third_party/livenerf is understood', () => {
    const text = upstream(Livenerf.README_PATH);
    if (text === null)
        return;
    const benchmark = Livenerf.benchmarkFromReadme(text);
    ok(benchmark?.progress || benchmark?.result, 'neither progress nor a Δ found upstream');
});

test('livenerf: the chart in third_party/livenerf is understood', () => {
    const text = upstream(Livenerf.CHART_PATH);
    if (text === null)
        return;
    const chart = Livenerf.chartFromSvg(text);
    ok(chart?.points.length, 'no daily scores found upstream');
    ok(typeof chart.latest === 'number', 'no latest score label upstream');
    // The printed latest score and the last point read back agree.
    const last = chart.points[chart.points.length - 1];
    ok(Math.abs(last.score - chart.latest) < 0.1, `${last.score} vs ${chart.latest}`);
    ok(chart.points.every(p => p.low <= p.score && p.score <= p.high && p.at > 0 && p.at < 1),
        JSON.stringify(chart.points));
});

// ---- service

// rounds: one {readme, chart} per fetch, a text or an Error each; the last
// repeats. calls: one per fetch (both files).
function setup(rounds) {
    const calls = [];
    const service = new LivenerfService({fetch: path => {
        if (path === Livenerf.README_PATH)
            calls.push(Date.now());
        const round = rounds[Math.min(calls.length, rounds.length) - 1];
        const text = path === Livenerf.README_PATH ? round.readme : round.chart;
        return text instanceof Error ? Promise.reject(text) : Promise.resolve(text);
    }});
    let changes = 0;
    service.connect('changed', () => changes++);
    return {service, calls, changes: () => changes};
}

const GOOD = {readme: readme(), chart: CHART};

test('service: nothing is fetched before start; a fetch reads both files', async () => {
    const {service, calls, changes} = setup([GOOD]);
    await service.refresh();
    eq(calls.length, 0, 'not started');
    service.start();
    await service.refresh();
    eq(calls.length, 1);
    eq([service.benchmark.progress.collected, service.benchmark.chart.latest], [7, 55]);
    eq([service.loaded, service.error, changes()], [true, null, 1]);
    service.stop();
});

test('service: within the hour, no second fetch; after it, one', async () => {
    const {service, calls} = setup([GOOD]);
    service.start();
    await service.refresh();
    await service.refresh();
    eq(calls.length, 1);
    service.fetchedAt -= MIN_FETCH_INTERVAL_MS;
    await service.refresh();
    eq(calls.length, 2);
    service.stop();
});

test('service: failed first fetches are "unreadable" and retried next time', async () => {
    const {service, calls} = setup([{readme: new Error('HTTP 503'), chart: new Error('HTTP 503')},
        {readme: 'not the README', chart: 'not the chart'}, GOOD]);
    service.start();
    await service.refresh();
    eq([service.error, service.benchmark], ['unreadable', null]);
    await service.refresh();
    eq(service.error, 'unreadable', 'pages without results are no better');
    await service.refresh();
    eq([calls.length, service.error, service.benchmark.progress.total], [3, null, 30]);
    service.stop();
});

test('service: one file is enough; a failed one keeps its last reading and is retried', async () => {
    const {service, calls} = setup([{readme: readme(), chart: new Error('HTTP 404')},
        {readme: new Error('offline'), chart: CHART}, GOOD]);
    service.start();
    await service.refresh();
    eq([service.error, service.benchmark.progress.collected, service.benchmark.chart], [null, 7, null]);
    await service.refresh();
    eq([service.benchmark.progress.collected, service.benchmark.chart.latest], [7, 55],
        'the README\'s last reading kept, the chart added');
    eq(calls.length, 2, 'a partial failure does not wait the hour');
    await service.refresh();
    ok(service.fetchedAt !== null);
    service.stop();
});

test('service: failed later fetches keep the last good reading', async () => {
    const {service, changes} = setup([GOOD, {readme: new Error('offline'), chart: new Error('offline')}]);
    service.start();
    await service.refresh();
    service.fetchedAt -= MIN_FETCH_INTERVAL_MS;
    await service.refresh();
    eq([service.error, service.benchmark.progress.collected, service.benchmark.chart.latest, changes()],
        [null, 7, 55, 1]);
    service.stop();
});

// Just what ClaudeService uses of Gio.NetworkMonitor.
class FakeNetwork {
    constructor(online) {
        this.network_available = online;
        this.connectivity = online ? Gio.NetworkConnectivity.FULL : Gio.NetworkConnectivity.LOCAL;
        this._handlers = new Map();
        this._nextId = 1;
    }

    connect(signal, handler) {
        this._handlers.set(this._nextId, {signal, handler});
        return this._nextId++;
    }

    disconnect(id) {
        this._handlers.delete(id);
    }

    goOnline() {
        this.network_available = true;
        this.connectivity = Gio.NetworkConnectivity.FULL;
        for (const h of [...this._handlers.values()].filter(h => h.signal === 'notify::connectivity'))
            h.handler(this);
    }
}

test('claude service: the benchmark is fetched when shown and online only', async () => {
    const {service: benchmark, calls} = setup([GOOD]);
    const dir = GLib.dir_make_tmp('froonty-livenerf-XXXXXX');
    const network = new FakeNetwork(false);
    const claude = new ClaudeService({file: () => Gio.File.new_for_path(`${dir}/.claude.json`),
        network, benchmark});
    let changes = 0;
    claude.connect('changed', () => changes++);
    claude.start();
    await claude.refresh();
    eq(calls.length, 0, 'hidden');
    claude.setActive(true);
    await claude._reading;
    eq(calls.length, 0, 'shown but offline');
    network.goOnline();
    await benchmark._fetching;
    eq(calls.length, 1, 'fetched once back online');
    ok(changes >= 2, 'the benchmark\'s change reaches the tab');
    claude.stop();
    ok(benchmark._cancellable === null, 'stopping the tab stops the benchmark');
});

await done();
