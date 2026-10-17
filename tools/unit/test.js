// SPDX-License-Identifier: GPL-3.0-or-later
// Minimal test helper for plain `gjs -m` unit tests (no Shell, no deps).
//
//   import {test, eq, ok, done} from './test.js';
//   test('adds', () => eq(1 + 1, 2));
//   await done();
//
// Also the helpers most test files share: the extension's folder, sleep(),
// waitFor() and Froonty's settings on an in-memory backend.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

export const EXTENSION_DIR = GLib.build_filenamev([
    GLib.path_get_dirname(GLib.path_get_dirname(GLib.path_get_dirname(
        GLib.filename_from_uri(import.meta.url)[0]))),
    'froonty@catalin']);

export const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

/** Whether `predicate` came true within `timeoutMs`, looking every 20 ms. */
export async function waitFor(predicate, timeoutMs = 5000) {
    for (let waited = 0; waited < timeoutMs; waited += 20) {
        if (predicate())
            return true;
        // eslint-disable-next-line no-await-in-loop
        await sleep(20);
    }
    return predicate();
}

/** Froonty's real schema, with an in-memory backend: nothing touches dconf. */
export function makeSettings() {
    const source = Gio.SettingsSchemaSource.new_from_directory(
        GLib.build_filenamev([EXTENSION_DIR, 'schemas']), null, false);
    const settings = new Gio.Settings({
        settings_schema: source.lookup('org.gnome.shell.extensions.froonty', false),
        backend: Gio.memory_settings_backend_new(),
    });
    if (GObject.type_name(settings.backend.constructor.$gtype) !== 'GMemorySettingsBackend')
        throw new Error('test settings must be in memory');
    return settings;
}

const tests = [];

export function test(name, fn) {
    tests.push({name, fn});
}

export function eq(actual, expected, message = '') {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`${message}\n       expected ${e}\n       actual   ${a}`);
}

export function ok(value, message = 'expected a truthy value') {
    if (!value)
        throw new Error(message);
}

// FROONTY_TEST_SHARD=i/n (tools/unit/run.sh): only every n-th test from the
// i-th, so a slow file can run as n processes at once.
function shard() {
    const m = /^(\d+)\/(\d+)$/.exec(GLib.getenv('FROONTY_TEST_SHARD') ?? '');
    return m && Number(m[2]) > 1 ? [Number(m[1]), Number(m[2])] : [0, 1];
}

/** Runs the registered tests in order; exits non-zero on failure. */
export async function done() {
    let failed = 0;
    const [index, count] = shard();
    const chosen = tests.filter((_, k) => k % count === index);
    for (const {name, fn} of chosen) {
        try {
            await fn();
            print(`PASS ${name}`);
        } catch (e) {
            failed++;
            print(`FAIL ${name}: ${e.message}`);
        }
    }
    print(`${chosen.length - failed}/${chosen.length} passed`);
    if (failed)
        imports.system.exit(1);
}
