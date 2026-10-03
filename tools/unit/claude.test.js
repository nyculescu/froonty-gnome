// SPDX-License-Identifier: GPL-3.0-or-later
// Claude: the usage parser (pure) and the service against a temporary file
// and a fake network monitor (plain gjs, no Shell).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {test, eq, ok, done} from './test.js';
import * as Usage from '../../froonty@catalin/features/claude/usage.js';
import * as Setup from '../../froonty@catalin/features/claude/statusLineSetup.js';
import {ClaudeService} from '../../froonty@catalin/features/claude/service.js';
import {lowPowerReason} from '../../froonty@catalin/features/claude/power.js';
import {
    ClaudeRefresher, HANDLED, MIN_INTERVAL_MS, PAUSED, SETTING, newestExtension,
} from '../../froonty@catalin/features/claude/refresher.js';
import {Emitter} from '../../froonty@catalin/core/emitter.js';

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

const CREDITS_RESET = '2026-11-05T07:59:00+00:00';
const credits = (entry = {}) => ({iguana_necktie: {utilization: 27.5626988, resets_at: CREDITS_RESET,
    limit_dollars: 250, used_dollars: 68.906747, remaining_dollars: 181.093253,
    locked_reason: null, ...entry}});

test('usage: cloud session credits come last, in dollars, with their reset', () => {
    const usage = Usage.usageFromConfig(config({extra: credits()}));
    eq(summary(usage), 'session=13 weekly=33 model:fable=18 credits=27.5626988');
    const row = usage.windows[3];
    eq(row.kind, Usage.CREDITS);
    eq([row.limit, row.used, row.remaining], [250, 68.906747, 181.093253]);
    eq(row.resetsAt, Date.parse(CREDITS_RESET));
    eq(row.severity, null);
});

test('usage: credits without remaining or utilization are worked out; locked is flagged', () => {
    const row = Usage.usageFromConfig(config({extra: credits({utilization: null,
        remaining_dollars: null, used_dollars: 50, locked_reason: 'spend_limit'})})).windows[3];
    eq([row.percent, row.remaining, row.severity], [20, 200, 'locked']);
});

test('usage: no credits (null limits, as without a grant) or bad values leave the row out', () => {
    for (const entry of [
        {limit_dollars: null, used_dollars: null, remaining_dollars: null},
        {limit_dollars: 0},
        {limit_dollars: '250'},
        {used_dollars: -1},
    ])
        eq(summary(Usage.usageFromConfig(config({extra: credits(entry)}))),
            'session=13 weekly=33 model:fable=18', JSON.stringify(entry));
    eq(summary(Usage.usageFromConfig(config({extra: {iguana_necktie: null}}))),
        'session=13 weekly=33 model:fable=18');
});

// ---- status line (B)

const WRITTEN = FETCHED + 10 * 60000;
const statusFileData = ({writtenAtMs = WRITTEN, session = 41, weekly = 35} = {}) => ({
    writtenAtMs,
    rate_limits: {
        five_hour: {used_percentage: session, resets_at: Date.parse(SESSION_RESET) / 1000},
        seven_day: {used_percentage: weekly, resets_at: Date.parse(WEEK_RESET) / 1000},
    },
});

test('statusLine: Session and Weekly from rate_limits, resets in ms', () => {
    const status = Usage.statusLineFromFile(statusFileData());
    eq(status.writtenAt, WRITTEN);
    eq(status.windows.map(w => [w.id, w.percent, w.resetsAt, w.fetchedAt]), [
        ['session', 41, Date.parse(SESSION_RESET), WRITTEN],
        ['weekly', 35, Date.parse(WEEK_RESET), WRITTEN],
    ]);
});

test('statusLine: no time, no rate_limits or bad values is nothing', () => {
    eq(Usage.statusLineFromFile({rate_limits: statusFileData().rate_limits}), null);
    eq(Usage.statusLineFromFile({writtenAtMs: WRITTEN}), null);
    eq(Usage.statusLineFromFile({writtenAtMs: WRITTEN, rate_limits: {five_hour: {used_percentage: 'x'}}}), null);
    eq(Usage.statusLineFromFile(null), null);
    const noReset = Usage.statusLineFromFile({writtenAtMs: WRITTEN,
        rate_limits: {seven_day: {used_percentage: 3}}});
    eq(noReset.windows.map(w => [w.id, w.resetsAt]), [['weekly', null]]);
});

test('merge: a newer status line replaces Session and Weekly; models and credits stay', () => {
    const usage = Usage.usageFromConfig(config({extra: {iguana_necktie: {utilization: 10,
        limit_dollars: 250, used_dollars: 25, remaining_dollars: 225, resets_at: WEEK_RESET}}}));
    const merged = Usage.mergeStatusLine(usage, Usage.statusLineFromFile(statusFileData()));
    eq(summary(merged), 'session=41 weekly=35 model:fable=18 credits=10');
    eq(merged.fetchedAt, WRITTEN);
    eq(merged.windows.map(w => w.fetchedAt), [WRITTEN, WRITTEN, FETCHED, FETCHED]);
    eq(summary(usage), 'session=13 weekly=33 model:fable=18 credits=10', 'the cache is not changed');
});

test('merge: an older status line loses; alone, it is enough', () => {
    const usage = Usage.usageFromConfig(config());
    const old = Usage.statusLineFromFile(statusFileData({writtenAtMs: FETCHED - 60000,
        session: 5, weekly: 20}));
    eq(summary(Usage.mergeStatusLine(usage, old)), 'session=13 weekly=33 model:fable=18');
    eq(Usage.mergeStatusLine(usage, old).fetchedAt, FETCHED);
    eq(summary(Usage.mergeStatusLine(null, old)), 'session=5 weekly=20');
    eq(Usage.mergeStatusLine(usage, null), usage);
    eq(Usage.mergeStatusLine(null, null), null);
});

test('merge: an idle session\'s old numbers lose to a newer window or a higher use', () => {
    const usage = Usage.usageFromConfig(config());
    const later = Date.parse(SESSION_RESET) + 5 * 3600000;
    // Saved after the cache, but from the window before the cache's.
    const idle = Usage.statusLineFromFile({writtenAtMs: WRITTEN, rate_limits: {
        five_hour: {used_percentage: 80, resets_at: Date.parse(SESSION_RESET) / 1000 - 5 * 3600}}});
    eq(summary(Usage.mergeStatusLine(usage, idle)), 'session=13 weekly=33 model:fable=18');
    // Same window (the reset differs by under a second), lower use: older.
    const lower = Usage.statusLineFromFile({writtenAtMs: WRITTEN, rate_limits: {
        five_hour: {used_percentage: 9, resets_at: Math.floor(Date.parse(SESSION_RESET) / 1000)}}});
    eq(summary(Usage.mergeStatusLine(usage, lower)), 'session=13 weekly=33 model:fable=18');
    // A later window wins even if saved before the cache.
    const next = Usage.statusLineFromFile({writtenAtMs: FETCHED - 1, rate_limits: {
        five_hour: {used_percentage: 2, resets_at: later / 1000}}});
    eq(summary(Usage.mergeStatusLine(usage, next)), 'session=2 weekly=33 model:fable=18');
});

// ---- low power

test('lowPowerReason: Power Saver, or on battery below 20%', () => {
    const battery = (state, percentage) => ({present: true, type: 2, state, percentage});
    eq(lowPowerReason({profile: 'power-saver'}), 'power-saver');
    eq(lowPowerReason({profile: 'balanced', battery: battery(2, 19.9)}), 'battery');
    eq(lowPowerReason({profile: 'balanced', battery: battery(6, 5)}), 'battery');
    eq(lowPowerReason({profile: 'balanced', battery: battery(2, 20)}), null, '20% is not under 20%');
    eq(lowPowerReason({profile: 'performance', battery: battery(1, 10)}), null, 'charging');
    eq(lowPowerReason({profile: 'balanced', battery: battery(4, 10)}), null, 'plugged in');
    eq(lowPowerReason({battery: {present: false, type: 2, state: 2, percentage: 5}}), null);
    eq(lowPowerReason({battery: {present: true, type: 1, state: 2, percentage: 5}}), null, 'a mains device');
    eq(lowPowerReason({}), null);
});

// ---- refresher (A)

test('newestExtension: the highest version, any Linux architecture', () => {
    eq(newestExtension([
        'anthropic.claude-code-2.1.99-linux-x64',
        'anthropic.claude-code-2.1.285-linux-x64',
        'anthropic.claude-code-2.1.117-linux-arm64',
        'anthropic.claude-code-3.0.0-darwin-arm64',
        'ms-python.python-2026.1.0',
        'anthropic.claude-code-2.1.285-linux-x64.backup',
    ]), 'anthropic.claude-code-2.1.285-linux-x64');
    eq(newestExtension(['anthropic.claude-code-2.2-linux-x64', 'anthropic.claude-code-2.1.900-linux-x64']),
        'anthropic.claude-code-2.2-linux-x64');
    eq(newestExtension([]), null);
});

class FakeSettings extends Emitter {
    constructor() {
        super();
        this.values = {[SETTING]: true, [PAUSED]: false, [HANDLED]: false};
    }

    get_boolean(key) {
        return this.values[key];
    }

    set_boolean(key, value) {
        if (this.values[key] === value)
            return;
        this.values[key] = value;
        this.emit(`changed::${key}`);
    }

    set(key, value) {
        this.set_boolean(key, value);
    }
}

class FakePower extends Emitter {
    constructor(reason = null) {
        super();
        this.reason = reason;
        this.known = true;
        this.started = 0;
    }

    start() {
        this.started++;
        return Promise.resolve();
    }

    stop() {
        this.started = 0;
    }

    set(reason) {
        this.reason = reason;
        this.emit('changed');
    }
}

function refresher({binary = '/opt/claude', settings = new FakeSettings(), power = new FakePower()} = {}) {
    const clock = {now: FETCHED + 10 * 60000};
    const runs = [];
    const r = new ClaudeRefresher({
        settings,
        power,
        find: () => Promise.resolve(binary),
        run: path => {
            runs.push(path);
            return Promise.resolve(true);
        },
        now: () => clock.now,
    });
    return {r, runs, settings, power, clock};
}

test('refresher: on screen, runs Claude Code once; again only after a minute', async () => {
    const {r, runs, clock} = refresher();
    eq(await r.request(FETCHED), false, 'not while nothing is on screen');
    r.setActive(true);
    eq(r.mode, {mode: 'claude-code', reason: null});
    let done = 0;
    r.connect('done', () => done++);
    eq(await r.request(FETCHED), true);
    eq(runs, ['/opt/claude']);
    eq(done, 1);
    clock.now += MIN_INTERVAL_MS - 1;
    eq(await r.request(FETCHED), false, 'within a minute');
    clock.now += 1;
    eq(await r.request(FETCHED), true);
    eq(runs.length, 2);
});

test('refresher: a cache under a minute old is not asked again', async () => {
    const {r, runs, clock} = refresher();
    r.setActive(true);
    eq(await r.request(clock.now - 30000), false);
    eq(await r.request(null), true, 'no cache at all: ask');
    eq(runs.length, 1);
});

test('refresher: two views at once run it once', async () => {
    const {r, runs} = refresher();
    r.setActive(true);
    r.setActive(true);
    const [a, b] = await Promise.all([r.request(FETCHED), r.request(FETCHED)]);
    eq([a, b, runs.length], [true, false, 1]);
});

const settle = () => new Promise(resolve => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

test('refresher: the setting off by hand means the status line only', async () => {
    const {r, runs, settings} = refresher();
    await settle();
    r.setActive(true);
    settings.set(SETTING, false);
    eq(r.mode, {mode: 'status-line', reason: 'off'});
    eq(await r.request(FETCHED), false);
    eq(runs.length, 0);
});

test('refresher: low power turns the setting off, and back on when it ends', async () => {
    const {r, runs, settings, power} = refresher();
    await settle();
    r.setActive(true);
    power.set('power-saver');
    eq([settings.values[SETTING], settings.values[PAUSED]], [false, true]);
    eq(r.mode, {mode: 'status-line', reason: 'power-saver'});
    eq(await r.request(FETCHED), false);
    power.set('battery');
    eq(r.mode, {mode: 'status-line', reason: 'battery'}, 'from Power Saver to low battery');
    power.set(null);
    eq([settings.values[SETTING], settings.values[PAUSED], settings.values[HANDLED]], [true, false, false]);
    eq(await r.request(FETCHED), true);
    eq(runs.length, 1);
});

test('refresher: turned back on during low power, it stays on (the user\'s choice)', async () => {
    const {r, runs, settings, power} = refresher();
    await settle();
    r.setActive(true);
    power.set('battery');
    eq(settings.values[SETTING], false);
    settings.set(SETTING, true);
    eq(settings.values[PAUSED], false, 'nothing left to restore');
    power.set('power-saver');
    eq(settings.values[SETTING], true, 'still the same low-power stretch');
    eq(r.mode, {mode: 'claude-code', reason: null});
    eq(await r.request(FETCHED), true, 'runs in low power by choice');
    power.set(null);
    eq(settings.values[SETTING], true);
    power.set('battery');
    eq(settings.values[SETTING], false, 'the next stretch turns it off again');
    eq(runs.length, 1);
});

test('refresher: off by hand before low power stays off after it', async () => {
    const {settings, power} = refresher();
    await settle();
    settings.set(SETTING, false);
    power.set('power-saver');
    power.set(null);
    eq([settings.values[SETTING], settings.values[PAUSED]], [false, false]);
});

test('refresher: starting in low power acts once; an already handled stretch is kept', async () => {
    const settings = new FakeSettings();
    refresher({settings, power: new FakePower('battery')});
    await settle();
    eq([settings.values[SETTING], settings.values[HANDLED]], [false, true]);
    settings.set(SETTING, true);
    // A new refresher (Shell restarted, screen unlocked) in the same stretch.
    refresher({settings, power: new FakePower('battery')});
    await settle();
    eq(settings.values[SETTING], true, 'the user\'s choice survives');
});

test('refresher: an unreadable power state changes nothing', async () => {
    const {settings, power} = refresher();
    await settle();
    power.set('battery');
    eq(settings.values[SETTING], false);
    // The daemon restarts: unknown, not "low power ended".
    power.known = false;
    power.reason = null;
    power.emit('changed');
    eq([settings.values[SETTING], settings.values[HANDLED]], [false, true]);
    power.known = true;
    power.set('battery');
    eq([settings.values[SETTING], settings.values[PAUSED]], [false, true]);
});

test('refresher: destroyed before the power state arrives, it never acts', async () => {
    const settings = new FakeSettings();
    settings.values[HANDLED] = true;
    settings.values[PAUSED] = true;
    settings.values[SETTING] = false;
    const power = new FakePower(null);
    const {r} = refresher({settings, power});
    r.destroy();
    await settle();
    eq([settings.values[SETTING], settings.values[HANDLED]], [false, true]);
});

test('refresher: power is watched from the start, also with nothing on screen', async () => {
    const {r, power, settings} = refresher();
    eq(power.started, 1);
    await settle();
    power.set('power-saver');
    eq(settings.values[SETTING], false, 'collapsed island: the setting follows anyway');
    r.destroy();
    eq(power.started, 0);
});

test('refresher: without Claude Code, "not found" and no run', async () => {
    const {r, runs} = refresher({binary: null});
    r.setActive(true);
    eq(await r.request(FETCHED), false);
    eq([r.found, runs.length], [false, 0]);
});

// ---- status line set-up

function settingsFile(content) {
    const dir = Gio.File.new_for_path(GLib.dir_make_tmp('froonty-claude-settings-XXXXXX'));
    const file = dir.get_child('settings.json');
    if (content !== undefined)
        file.replace_contents(content, null, false, Gio.FileCreateFlags.NONE, null);
    return file;
}

const readJson = file => JSON.parse(new TextDecoder().decode(file.load_contents(null)[1]));
const SCRIPT = '/home/u/.local/share/gnome-shell/extensions/froonty@catalin/features/claude/statusline.py';

test('setup: adds the status line, keeping the rest; removes only its own', () => {
    const file = settingsFile(JSON.stringify({model: 'opus', permissions: {allow: ['Bash(ls)']}}));
    eq(Setup.installStatusLine(file, SCRIPT), null);
    const after = readJson(file);
    eq(after.model, 'opus');
    eq(after.permissions, {allow: ['Bash(ls)']});
    eq(after.statusLine, {type: 'command', command: `python3 '${SCRIPT}'`, padding: 0});
    eq(Setup.statusLineState(after), 'ours');
    eq(Setup.removeStatusLine(file), null);
    eq(readJson(file), {model: 'opus', permissions: {allow: ['Bash(ls)']}});
});

test('setup: never over a status line of the user\'s; no file is fine; bad JSON is left alone', () => {
    const theirs = {statusLine: {type: 'command', command: '~/bin/my-line.sh'}};
    const file = settingsFile(JSON.stringify(theirs));
    eq(Setup.statusLineState(theirs), 'other');
    ok(Setup.installStatusLine(file, SCRIPT) !== null);
    eq(Setup.removeStatusLine(file), null);
    eq(readJson(file), theirs);

    const none = settingsFile();
    eq(Setup.installStatusLine(none, SCRIPT), null);
    eq(Setup.statusLineState(readJson(none)), 'ours');

    const bad = settingsFile('{"model": ');
    ok(Setup.installStatusLine(bad, SCRIPT) !== null);
    eq(new TextDecoder().decode(bad.load_contents(null)[1]), '{"model": ');
    eq(Setup.statusLineState(null), 'none');
});

test('setup: only the exact entry it writes counts as Froonty\'s', () => {
    eq(Setup.statusLineState({statusLine: Setup.statusLineEntry(SCRIPT)}), 'ours');
    eq(Setup.statusLineState({statusLine: Setup.statusLineEntry(
        "/home/o'neil/src/froonty@catalin/features/claude/statusline.py")}), 'ours');
    for (const command of [
        `sh -c 'python3 ${SCRIPT}; ~/bin/git-segment'`,
        `python3 '${SCRIPT}' | tee /tmp/x`,
        `python3 '/tmp/statusline.py'`,
    ])
        eq(Setup.statusLineState({statusLine: {type: 'command', command}}), 'other', command);
});

test('setup: a path with a quote is quoted for the shell', () => {
    eq(Setup.statusLineEntry("/tmp/it's/statusline.py").command, "python3 '/tmp/it'\\''s/statusline.py'");
});

// statusline.py, as Claude Code runs it: JSON on stdin, the line on stdout.
function runScript(input, cacheHome) {
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE,
    });
    launcher.setenv('XDG_CACHE_HOME', cacheHome, true);
    const proc = launcher.spawnv(['python3', Setup.scriptPath()]);
    const [, stdout] = proc.communicate_utf8(input, null);
    return stdout.trim();
}

test('statusline.py: saves rate_limits for Froonty and prints the line', () => {
    const cache = GLib.dir_make_tmp('froonty-claude-cache-XXXXXX');
    const line = runScript(JSON.stringify({model: {display_name: 'Fable'},
        rate_limits: {five_hour: {used_percentage: 13.4, resets_at: 1790819999},
            seven_day: {used_percentage: 33, resets_at: 1791100000}},
        session_id: 'abc', cwd: '/home/u/secret'}), cache);
    eq(line, 'Fable · Session 13% · Weekly 33%');
    const saved = readJson(Gio.File.new_for_path(`${cache}/froonty/claude-status-line.json`));
    eq(Object.keys(saved).sort(), ['rate_limits', 'writtenAtMs'], 'nothing but the usage is kept');
    const status = Usage.statusLineFromFile(saved);
    eq(status.windows.map(w => w.percent), [13.4, 33]);
    ok(Math.abs(status.writtenAt - Date.now()) < 10000);
});

test('statusline.py: an idle session\'s older numbers do not replace newer ones', () => {
    const cache = GLib.dir_make_tmp('froonty-claude-cache-XXXXXX');
    const file = Gio.File.new_for_path(`${cache}/froonty/claude-status-line.json`);
    const input = (session, reset) => JSON.stringify({rate_limits: {
        five_hour: {used_percentage: session, resets_at: reset},
        seven_day: {used_percentage: 33, resets_at: 1791100000}}});
    runScript(input(40, 1790819999), cache);
    const first = readJson(file);
    // The idle session: the window before, then the same window lower.
    runScript(input(80, 1790801999), cache);
    runScript(input(30, 1790819999), cache);
    eq(readJson(file), first, 'left as it was');
    runScript(input(41, 1790819999), cache);
    eq(readJson(file).rate_limits.five_hour.used_percentage, 41);
    runScript(input(3, 1790837999), cache);
    eq(readJson(file).rate_limits.five_hour.used_percentage, 3, 'the next window');
});

test('statusline.py: before the first reply, the model only and nothing saved', () => {
    const cache = GLib.dir_make_tmp('froonty-claude-cache-XXXXXX');
    eq(runScript(JSON.stringify({model: {display_name: 'Fable'}}), cache), 'Fable');
    eq(runScript('not json', cache), '');
    ok(!GLib.file_test(`${cache}/froonty/claude-status-line.json`, GLib.FileTest.EXISTS));
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

function setup({refresher = null} = {}) {
    const dir = Gio.File.new_for_path(GLib.dir_make_tmp('froonty-claude-XXXXXX'));
    const file = dir.get_child('.claude.json');
    const statusFile = dir.get_child('claude-status-line.json');
    const network = new FakeNetwork();
    const service = new ClaudeService({file: () => file, statusFile: () => statusFile,
        network, refresher});
    let reads = 0;
    const read = service._read.bind(service);
    service._read = () => {
        reads++;
        return read();
    };
    let changes = 0;
    service.connect('changed', () => changes++);
    return {dir, file, statusFile, network, service, reads: () => reads, changes: () => changes};
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

test('service: the status line\'s file is merged in and followed while shown', async () => {
    const {dir, file, statusFile, service} = setup();
    write(dir, file, config());
    service.start();
    service.setActive(true);
    await service.refresh();
    eq(summary(service.usage), 'session=13 weekly=33 model:fable=18');
    statusFile.replace_contents(JSON.stringify(statusFileData({writtenAtMs: Date.now()})), null,
        false, Gio.FileCreateFlags.NONE, null);
    ok(await waitFor(() => service.usage?.windows[0].percent === 41), summary(service.usage));
    eq(summary(service.usage), 'session=41 weekly=35 model:fable=18');
    service.stop();
});

test('service: without Claude Code\'s file, the status line alone shows Session and Weekly', async () => {
    const {statusFile, service} = setup();
    statusFile.replace_contents(JSON.stringify(statusFileData()), null, false,
        Gio.FileCreateFlags.NONE, null);
    service.start();
    service.setActive(true);
    await service.refresh();
    eq([summary(service.usage), service.error], ['session=41 weekly=35', null]);
    service.stop();
});

test('service: showing it asks the refresher with the cache\'s own time; hiding tells it', async () => {
    const calls = [];
    const fake = new Emitter();
    fake.mode = {mode: 'claude-code', reason: null};
    fake.found = true;
    fake.setActive = active => calls.push(`active ${active}`);
    fake.request = fetchedAt => calls.push(`request ${fetchedAt}`);
    const {dir, file, statusFile, service} = setup({refresher: fake});
    write(dir, file, config());
    statusFile.replace_contents(JSON.stringify(statusFileData()), null, false,
        Gio.FileCreateFlags.NONE, null);
    service.start();
    service.setActive(true);
    ok(await waitFor(() => calls.length === 2), JSON.stringify(calls));
    eq(calls, ['active true', `request ${FETCHED}`], 'the cache\'s time, not the status line\'s');
    eq(service.refreshMode, {mode: 'claude-code', reason: null, found: true});
    let changes = 0;
    service.connect('changed', () => changes++);
    fake.emit('changed');
    eq(changes, 1, 'a mode change re-renders');
    service.setActive(false);
    eq(calls[2], 'active false');
    service.stop();
    fake.emit('changed');
    eq(changes, 1, 'stopped: disconnected from the refresher');
});

test('service: the status line\'s missing folder is made, so GLib never looks for it every 4 s', async () => {
    const dir = Gio.File.new_for_path(GLib.dir_make_tmp('froonty-claude-XXXXXX'));
    const statusDir = dir.get_child('cache').get_child('froonty');
    const service = new ClaudeService({file: () => dir.get_child('.claude.json'),
        statusFile: () => statusDir.get_child('claude-status-line.json'), network: new FakeNetwork()});
    service.start();
    ok(!statusDir.query_exists(null), 'nothing made before the tab is shown');
    service.setActive(true);
    ok(statusDir.query_exists(null), 'made when it is watched');
    const mode = statusDir.query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null)
        .get_attribute_uint32('unix::mode') & 0o777;
    eq(mode, 0o700);
    await service.refresh();
    service.setActive(false);
    service.stop();
});

await done();
