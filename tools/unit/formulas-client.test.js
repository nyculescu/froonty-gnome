// SPDX-License-Identifier: GPL-3.0-or-later
// The math renderer client (features/formulas/renderer/client.js) against
// a stand-in helper (fakeMathHelper.js): the cache, shared and superseded
// requests, stale replies, restarts after a crash, the time limit, the
// idle stop and destroy(). No MathJax, no St or Gtk.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {test, eq, ok, done} from './test.js';
import {EXTENSION_DIR, makeSettings, sleep} from './writing-helpers.js';

const {MathRenderClient, RenderError} = await import(
    `file://${EXTENSION_DIR}/features/formulas/renderer/client.js`);
const {FormulasService} = await import(`file://${EXTENSION_DIR}/features/formulas/service.js`);

const FAKE = GLib.build_filenamev([
    GLib.path_get_dirname(Gio.File.new_for_uri(import.meta.url).get_path()), 'fakeMathHelper.js']);

function client(options = {}) {
    const marker = GLib.build_filenamev([GLib.dir_make_tmp('froonty-math-XXXXXX'), 'marker']);
    return new MathRenderClient({
        argv: ['/usr/bin/gjs', '-m', FAKE],
        env: {FAKE_MATH_MARKER: marker},
        restartDelaysMs: [50, 100],
        ...options,
    });
}

async function failure(promise) {
    try {
        await promise;
    } catch (e) {
        return e;
    }
    throw new Error('expected a failure');
}

// Waits until fn() is true, for at most ms.
async function until(fn, ms = 5000) {
    const end = GLib.get_monotonic_time() + ms * 1000;
    while (!fn()) {
        if (GLib.get_monotonic_time() > end)
            throw new Error('timed out waiting');
        // eslint-disable-next-line no-await-in-loop
        await sleep(20);
    }
}

test('renders, starting the helper once, and answers again from the cache', async () => {
    const c = client();
    eq(c.running, false, 'nothing runs before the first request');
    const first = await c.render({tex: 'x', color: '#ffffff'});
    eq([first.width, first.height, first.baseline], [1, 1, 0.5]);
    ok(first.png.get_size() > 0, 'PNG bytes');
    const again = await c.render({tex: 'x', color: '#ffffff'});
    eq(again.width, 1, 'the cached answer (the helper would count 2)');
    const other = await c.render({tex: 'x', color: '#000000'});
    eq(other.width, 2, 'another colour is another request');
    eq(c.starts, 1);
    c.destroy();
});

test('the cache keeps the most recently used', async () => {
    const c = client({cacheSize: 2});
    await c.render({tex: 'a'});
    await c.render({tex: 'b'});
    await c.render({tex: 'a'}); // used: b is now the oldest
    await c.render({tex: 'c'}); // b goes
    eq((await c.render({tex: 'a'})).width, 1, 'a is still cached');
    eq((await c.render({tex: 'b'})).width, 4, 'b was asked again');
    c.destroy();
});

test('equal requests in flight share one answer', async () => {
    const c = client();
    const [a, b] = await Promise.all([c.render({tex: 'slow'}), c.render({tex: 'slow'})]);
    eq([a.width, b.width], [1, 1]);
    eq((await c.render({tex: 'y'})).width, 2, 'only one was sent');
    c.destroy();
});

test('a TeX error is MathJax\'s message, and is cached', async () => {
    const c = client();
    const e = await failure(c.render({tex: 'bad'}));
    ok(e instanceof RenderError);
    eq([e.kind, e.message], ['tex', 'Missing close brace']);
    const again = await failure(c.render({tex: 'bad'}));
    eq(again.kind, 'tex');
    eq((await c.render({tex: 'z'})).width, 2, 'the helper answered one error, not two');
    c.destroy();
});

test('a newer request on a channel supersedes the older one', async () => {
    const c = client();
    const older = c.render({tex: 'slow'}, {channel: 'preview'});
    const newer = c.render({tex: 'new'}, {channel: 'preview'});
    const e = await failure(older);
    eq(e.kind, 'superseded');
    eq((await newer).width, 2, 'answered after the slow one');
    // The older reply still filled the cache.
    eq((await c.render({tex: 'slow'})).width, 1);
    c.destroy();
});

test('a helper that dies is started again, and the formula sent once more', async () => {
    const c = client();
    const result = await c.render({tex: 'crash-once'});
    eq(result.width, 1, 'answered by the second helper');
    eq(c.starts, 2);
    c.destroy();
});

test('a formula that kills the helper twice fails; the others still render', async () => {
    const c = client();
    const crashing = c.render({tex: 'crash'});
    const e = await failure(crashing);
    eq(e.kind, 'crashed');
    eq((await c.render({tex: 'fine'})).width, 1);
    ok(c.starts >= 3, `${c.starts} helpers`);
    c.destroy();
});

test('a formula that takes too long fails, and the helper is replaced', async () => {
    const c = client({timeoutMs: 300});
    const stuck = c.render({tex: 'hang'});
    const behind = c.render({tex: 'after'});
    const e = await failure(stuck);
    eq(e.kind, 'timeout');
    eq((await behind).width, 1, 'sent again to a new helper');
    eq(c.starts, 2);
    c.destroy();
});

test('the helper stops when idle, and starts again when needed', async () => {
    const c = client({idleMs: 150});
    await c.render({tex: 'a'});
    eq(c.running, true);
    await until(() => !c.running);
    eq((await c.render({tex: 'b'})).width, 1, 'a new helper');
    eq(c.starts, 2);
    c.destroy();
});

test('destroy() fails what waits and stops the helper', async () => {
    const c = client();
    const waiting = c.render({tex: 'hang'});
    await sleep(100);
    c.destroy();
    const e = await failure(waiting);
    eq(e.kind, 'stopped');
    eq(c.running, false);
    eq((await failure(c.render({tex: 'x'}))).kind, 'stopped');
});

test('a helper that cannot start fails the request', async () => {
    const c = new MathRenderClient({argv: ['/nonexistent/gjs']});
    const e = await failure(c.render({tex: 'x'}));
    eq(e.kind, 'unavailable');
    c.destroy();
});

test('the service keeps recent and starred formulas in the settings', () => {
    const settings = makeSettings();
    const service = new FormulasService(settings, {client: client()});
    service.addRecent(' x^2 ');
    service.addRecent('y');
    service.addRecent('x^2');
    eq(settings.get_strv('formulas-recent'), ['x^2', 'y']);
    service.removeRecent('y');
    eq(service.recent, ['x^2']);
    service.toggleFavourite('E=mc^2');
    eq(service.favourites, ['E=mc^2']);
    service.toggleFavourite('E=mc^2');
    eq(service.favourites, []);
    service.stop();
});

test('the service renders until stopped', async () => {
    const service = new FormulasService(makeSettings(), {client: client(), isFetched: async () => true});
    service.start();
    eq(await service.available(), true);
    eq((await service.render({tex: 'q'})).width, 1);
    service.stop();
    ok(await failure(service.render({tex: 'q'})));
});

await done();
