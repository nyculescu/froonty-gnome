// SPDX-License-Identifier: GPL-3.0-or-later
// Claude: the usage parser (pure) and the service against a temporary file
// and a fake network monitor (plain gjs, no Shell).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {test, eq, ok, done} from './test.js';
import * as Usage from '../../froonty@catalin/features/claude/usage.js';
import {ClaudeService} from '../../froonty@catalin/features/claude/service.js';

const ACCOUNT = '9692865c-d2c5-49c0-b405-eba056a61511';
const FETCHED = Date.parse('2026-09-29T18:44:12.799Z');
const SESSION_RESET = '2026-09-29T22:49:59.714213+00:00';
const WEEK_RESET = '2026-10-03T05:59:59.714235+00:00';

// Shaped like the cache Claude Code 2.1.280 wrote on 2026-09-29.
// limits: null leaves the field out (older caches).
function config({limits = defaultLimits(), accountUuid = ACCOUNT, extra = {}} = {}) {
    return {
        oauthAccount: {accountUuid: ACCOUNT, organizationRateLimitTier: 'default_claude_max_20x'},
        cachedUsageUtilization: {
            fetchedAtMs: FETCHED,
            accountUuid,
            utilization: {
                five_hour: {utilization: 13, resets_at: SESSION_RESET},
                seven_day: {utilization: 33, resets_at: WEEK_RESET},
                seven_day_opus: null,
                seven_day_sonnet: null,
                ...limits && {limits},
                ...extra,
            },
        },
    };
}

function defaultLimits() {
    return [
        {kind: 'session', group: 'session', percent: 13, severity: 'normal',
            resets_at: SESSION_RESET, scope: null, is_active: false},
        {kind: 'weekly_all', group: 'weekly', percent: 33, severity: 'normal',
            resets_at: WEEK_RESET, scope: null, is_active: true},
        {kind: 'weekly_scoped', group: 'weekly', percent: 18, severity: 'normal',
            resets_at: WEEK_RESET,
            scope: {model: {id: null, display_name: 'Fable'}, surface: null},
            is_active: false},
    ];
}

const summary = usage => usage?.windows.map(w => `${w.id}=${w.percent}`).join(' ') ?? null;

// ---- parser

test('usage: session, weekly and weekly Fable, in that order, with resets', () => {
    const usage = Usage.usageFromConfig(config());
    eq(summary(usage), 'session=13 weekly=33 model:fable=18');
    eq(usage.fetchedAt, FETCHED);
    eq(usage.windows[0].resetsAt, Date.parse(SESSION_RESET));
    eq(usage.windows[2].model, 'Fable');
    eq(usage.windows[2].kind, Usage.MODEL);
    eq(usage.windows[2].severity, 'normal');
});

test('usage: rows out of order are shown session, weekly, models', () => {
    const [session, weekly, fable] = config().cachedUsageUtilization.utilization.limits;
    eq(summary(Usage.usageFromConfig(config({limits: [fable, weekly, session]}))),
        'session=13 weekly=33 model:fable=18');
});

test('usage: without limits[], the older five_hour and seven_day fields are used', () => {
    eq(summary(Usage.usageFromConfig(config({limits: null}))), 'session=13 weekly=33');
    eq(summary(Usage.usageFromConfig(config({limits: [],
        extra: {seven_day_opus: {utilization: 5, resets_at: WEEK_RESET}}}))),
    'session=13 weekly=33 model:opus=5');
});

test('usage: rows for a product ("surface"), unknown kinds and bad values are left out', () => {
    const usage = Usage.usageFromConfig(config({limits: [
        {kind: 'weekly_scoped', percent: 50, resets_at: WEEK_RESET,
            scope: {model: null, surface: {display_name: 'Cowork'}}},
        {kind: 'weekly_scoped', percent: 50, resets_at: WEEK_RESET,
            scope: {model: {display_name: 'Fable'}, surface: {display_name: 'Cowork'}}},
        {kind: 'monthly_everything', percent: 1},
        {kind: 'weekly_scoped', percent: 'lots', scope: {model: {display_name: 'Opus'}}},
        {kind: 'weekly_scoped', percent: -3, scope: {model: {display_name: 'Opus'}}},
        {kind: 'weekly_scoped', percent: 7, scope: {model: {display_name: '  '}}},
        null, 42,
    ]}));
    eq(summary(usage), 'session=13 weekly=33');
});

test('usage: a missing or bad reset time is null, not a guess', () => {
    const usage = Usage.usageFromConfig(config({limits: [
        {kind: 'session', percent: 3, resets_at: null},
        {kind: 'weekly_all', percent: 4, resets_at: 'soon'},
    ]}));
    eq(usage.windows.map(w => w.resetsAt), [null, null]);
});

test('usage: a cache left by another account, or none at all, is no usage', () => {
    eq(Usage.usageFromConfig(config({accountUuid: 'someone-else'})), null);
    eq(Usage.usageFromConfig({oauthAccount: {accountUuid: ACCOUNT}}), null);
    eq(Usage.usageFromConfig({}), null);
    eq(Usage.usageFromConfig(null), null);
    eq(Usage.usageFromConfig([]), null);
    const noTime = config();
    delete noTime.cachedUsageUtilization.fetchedAtMs;
    eq(Usage.usageFromConfig(noTime), null);
});

test('usage: above 100% is kept as is; the bar is capped', () => {
    const usage = Usage.usageFromConfig(config({limits: [{kind: 'session', percent: 104}]}));
    eq(usage.windows[0].percent, 104);
    eq(Usage.fillFraction(104), 1);
    eq(Usage.fillFraction(33), 0.33);
    eq(Usage.fillFraction(0), 0);
});

test('describeReset: relative under a day, a weekday after, "renewed" once past', () => {
    const reset = Date.parse(SESSION_RESET);
    eq(Usage.describeReset(reset, reset - (4 * 60 + 2) * 60000), {kind: 'in', hours: 4, minutes: 2});
    // Rounded up: 30 s left reads "in 1 min".
    eq(Usage.describeReset(reset, reset - 30000), {kind: 'in', hours: 0, minutes: 1});
    eq(Usage.describeReset(reset, reset - 60 * 60000), {kind: 'in', hours: 1, minutes: 0});
    eq(Usage.describeReset(reset, reset - Usage.RELATIVE_RESET_MS), {kind: 'at', time: reset});
    // 23 h 59 min 30 s rounds up to a whole day: a weekday, not "24 h 0 min".
    eq(Usage.describeReset(reset, reset - Usage.RELATIVE_RESET_MS + 30000), {kind: 'at', time: reset});
    eq(Usage.describeReset(reset, reset - Usage.RELATIVE_RESET_MS + 60000),
        {kind: 'in', hours: 23, minutes: 59});
    eq(Usage.describeReset(reset, reset), {kind: 'renewed', time: reset});
    eq(Usage.describeReset(null, reset), {kind: 'unknown'});
});

test('minutesSince: whole minutes, never negative', () => {
    eq(Usage.minutesSince(FETCHED, FETCHED + 59999), 0);
    eq(Usage.minutesSince(FETCHED, FETCHED + 125000), 2);
    eq(Usage.minutesSince(FETCHED, FETCHED - 5000), 0);
});

// ---- service

const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms,
    () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));

async function waitFor(predicate, timeoutMs = 3000) {
    for (let waited = 0; waited < timeoutMs; waited += 20) {
        if (predicate())
            return true;
        await sleep(20);
    }
    return predicate();
}

// Just what the service uses of Gio.NetworkMonitor.
class FakeNetwork {
    constructor() {
        this.network_available = true;
        this.connectivity = Gio.NetworkConnectivity.FULL;
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

    get connections() {
        return this._handlers.size;
    }

    // Like GNetworkMonitorNM: NetworkManager's state and connectivity
    // check arrive as property notifications only.
    set(available, connectivity) {
        this.network_available = available;
        this.connectivity = connectivity;
        this.emit('notify::connectivity');
    }

    emit(signal) {
        for (const h of [...this._handlers.values()].filter(h => h.signal === signal))
            h.handler(this);
    }
}

function setup() {
    const dir = Gio.File.new_for_path(GLib.dir_make_tmp('froonty-claude-XXXXXX'));
    const file = dir.get_child('.claude.json');
    const network = new FakeNetwork();
    const service = new ClaudeService({file: () => file, network});
    let reads = 0;
    const read = service._read.bind(service);
    service._read = () => {
        reads++;
        return read();
    };
    let changes = 0;
    service.connect('changed', () => changes++);
    return {dir, file, network, service, reads: () => reads, changes: () => changes};
}

// Like Claude Code: a whole new file renamed onto the old one.
function write(dir, file, data) {
    const temp = dir.get_child('.claude.json.tmp');
    temp.replace_contents(JSON.stringify(data), null, false, Gio.FileCreateFlags.NONE, null);
    temp.move(file, Gio.FileCopyFlags.OVERWRITE, null, null);
}

test('service: nothing is read until the tab is shown', async () => {
    const {dir, file, network, service, reads} = setup();
    write(dir, file, config());
    service.start();
    await sleep(100);
    eq(reads(), 0);
    eq(service.usage, null);
    eq(network.connections, 0, 'no network watch while hidden');
    service.stop();
});

test('service: showing the tab reads the file', async () => {
    const {dir, file, service, reads} = setup();
    write(dir, file, config());
    service.start();
    service.setActive(true);
    await service._reading;
    eq(reads(), 1, 'showing the tab read the file, once');
    eq(summary(service.usage), 'session=13 weekly=33 model:fable=18');
    eq(service.error, null);
    eq(service.online, true);
    service.stop();
});

test('service: while shown, a new file from Claude Code is picked up', async () => {
    const {dir, file, service} = setup();
    write(dir, file, config());
    service.start();
    service.setActive(true);
    await service.refresh();
    const next = config();
    next.cachedUsageUtilization.utilization.limits[0].percent = 21;
    write(dir, file, next);
    ok(await waitFor(() => service.usage?.windows[0].percent === 21), summary(service.usage));
    service.stop();
});

test('service: hidden, changes are not followed; shown again, it reads afresh', async () => {
    const {dir, file, service, reads} = setup();
    write(dir, file, config());
    service.start();
    service.setActive(true);
    await service.refresh();
    service.setActive(false);
    const before = reads();

    const next = config();
    next.cachedUsageUtilization.utilization.limits[1].percent = 40;
    write(dir, file, next);
    await sleep(300);
    eq(reads(), before, 'no read while hidden');
    eq(service.usage.windows[1].percent, 33);

    service.setActive(true);
    eq(reads(), before + 1, 'showing the tab again started a read');
    await service._reading;
    eq(service.usage.windows[1].percent, 40);
    service.stop();
});

test('service: a burst of refreshes costs at most two reads', async () => {
    const {dir, file, service, reads} = setup();
    write(dir, file, config());
    service.start();
    service._active = true; // shown, without the file monitor adding reads
    const pending = [];
    for (let i = 0; i < 10; i++)
        pending.push(service.refresh());
    await Promise.all(pending);
    ok(reads() <= 2, `${reads()} reads`);
    service.stop();
});

test('service: no file is "missing"; a half-written file keeps the last reading', async () => {
    const {dir, file, service, changes} = setup();
    service.start();
    service.setActive(true);
    await service.refresh();
    eq(service.error, 'missing');
    eq(service.usage, null);

    write(dir, file, config());
    await waitFor(() => service.usage !== null);
    eq(service.error, null);

    const seen = changes();
    file.replace_contents('{"cachedUsageUtilization": {"fetch', null, false,
        Gio.FileCreateFlags.NONE, null);
    await sleep(200);
    await service.refresh();
    eq(summary(service.usage), 'session=13 weekly=33 model:fable=18');
    eq(changes(), seen, 'no change emitted for a partial write');
    service.stop();
});

test('service: a file that never parsed is "unreadable"', async () => {
    const {dir, service} = setup();
    dir.get_child('.claude.json').replace_contents('not json', null, false,
        Gio.FileCreateFlags.NONE, null);
    service.start();
    service.setActive(true);
    await service.refresh();
    eq(service.error, 'unreadable');
    eq(service.usage, null);
    service.stop();
});

test('service: offline unless the network has full connectivity', async () => {
    const {dir, file, network, service, changes} = setup();
    write(dir, file, config());
    network.set(false, Gio.NetworkConnectivity.LOCAL);
    service.start();
    service.setActive(true);
    await service.refresh();
    eq(service.online, false);

    for (const [available, connectivity, online] of [
        [true, Gio.NetworkConnectivity.FULL, true],
        [true, Gio.NetworkConnectivity.PORTAL, false],
        [true, Gio.NetworkConnectivity.LIMITED, false],
        [true, Gio.NetworkConnectivity.FULL, true],
    ]) {
        const [seen, was] = [changes(), service.online];
        network.set(available, connectivity);
        eq(service.online, online, `connectivity ${connectivity}`);
        eq(changes(), seen + (online === was ? 0 : 1), 'a change only when it flips');
    }

    service.setActive(false);
    eq(network.connections, 0, 'network watch dropped when hidden');
    service.stop();
});

await done();
