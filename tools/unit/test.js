// SPDX-License-Identifier: GPL-3.0-or-later
// Minimal test helper for plain `gjs -m` unit tests (no Shell, no deps).
//
//   import {test, eq, ok, done} from './test.js';
//   test('adds', () => eq(1 + 1, 2));
//   await done();

import GLib from 'gi://GLib';

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

/** Runs the registered tests in order; exits non-zero on failure. */
// FROONTY_TEST_SHARD=i/n (tools/unit/run.sh): only every n-th test from the
// i-th, so a slow file can run as n processes at once.
function shard() {
    const m = /^(\d+)\/(\d+)$/.exec(GLib.getenv('FROONTY_TEST_SHARD') ?? '');
    return m && Number(m[2]) > 1 ? [Number(m[1]), Number(m[2])] : [0, 1];
}

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
