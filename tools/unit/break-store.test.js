// SPDX-License-Identifier: GPL-3.0-or-later
// The Break tab's files (features/break/store.js): state.json and
// history.json, 0700/0600, one write queue.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {done, eq, ok, test} from './test.js';
import {froontySettings, makeService, setup, tempFolder} from './breakWorld.js';
import {makeWorld} from './gnomeBreakManager.js';
import {BreakStore} from '../../froonty@catalin/features/break/store.js';

const mode = file => file.query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null)
    .get_attribute_uint32('unix::mode') & 0o777;

test('round trip of the state and the history', async () => {
    const store = new BreakStore(tempFolder());
    await store.saveState({savedAt: 5, today: {day: '2026-10-02'}});
    await store.saveHistory([{day: '2026-10-01', activeSeconds: 60}]);
    eq(await store.loadState(), {savedAt: 5, today: {day: '2026-10-02'}});
    eq(await store.loadHistory(), [{day: '2026-10-01', activeSeconds: 60}]);
});

test('a missing, corrupt or unknown file reads as nothing', async () => {
    const store = new BreakStore(tempFolder());
    eq(await store.loadState(), null);
    eq(await store.loadHistory(), []);
    await store.saveState({});
    GLib.file_set_contents(store.stateFile.get_path(), '{nope');
    eq(await store.loadState(), null);
    GLib.file_set_contents(store.stateFile.get_path(), JSON.stringify({format: 2, savedAt: 1}));
    eq(await store.loadState(), null);
    GLib.file_set_contents(store.historyFile.get_path(), JSON.stringify({format: 1, days: [{x: 1}]}));
    eq(await store.loadHistory(), []);
});

test('a folder only the user can open (0700), files only the user can read (0600)', async () => {
    const store = new BreakStore(tempFolder());
    await store.saveState({savedAt: 1});
    await store.saveHistory([]);
    eq(mode(store.folder).toString(8), '700');
    eq(mode(store.stateFile).toString(8), '600');
    eq(mode(store.historyFile).toString(8), '600');
});

test('writes land in the order they were made; a load waits for them', async () => {
    const store = new BreakStore(tempFolder());
    for (let i = 1; i <= 5; i++)
        store.saveState({savedAt: i});
    const other = new BreakStore(store.folder);
    eq((await other.loadState()).savedAt, 5);
});

test('"Forget" deletes the history file', async () => {
    const store = new BreakStore(tempFolder());
    await store.saveHistory([{day: '2026-10-01', activeSeconds: 60}]);
    ok(store.historyFile.query_exists(null));
    await store.forgetHistory();
    ok(!store.historyFile.query_exists(null));
});

test('nothing is saved before the state is read: stopped while loading, no file', async () => {
    const world = makeWorld();
    // GNOME's engine in this world; the service below never finishes starting.
    (await setup({world})).service.stop();
    const store = new BreakStore(tempFolder());
    const service = makeService({world, manager: world.manager, settings: froontySettings(), store});
    const started = service.start();
    service.stop();
    await started;
    await store.flush();
    ok(!store.stateFile.query_exists(null), 'no state.json');
    eq(service.resources.engineSignals, false);
});

test('the service: "Forget" removes the history and zeroes today, keeping posture and plan', async () => {
    const {world, service, store} = await setup({froonty: {'posture-enabled': true}});
    service.setPosture('standing');
    service.setMinimumToday(true);
    world.work(30);
    await store.saveHistory([{day: '2026-09-30', activeSeconds: 60, eyesight: {}, movement: {}}]);
    service.forgetHistory();
    await store.flush();
    ok(!store.historyFile.query_exists(null));
    eq(service.history, []);
    eq(service.state.today.activeSeconds, 0);
    eq(service.state.posture.mode, 'standing');
    ok(service.state.plan.minimumDay);
    service.stop();
    await store.flush();
    ok(store.stateFile.query_exists(null), 'state.json written on stop');
});

await done();
