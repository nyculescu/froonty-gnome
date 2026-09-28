// SPDX-License-Identifier: GPL-3.0-or-later
// Minimal test helper for plain `gjs -m` unit tests (no Shell, no deps).
//
//   import {test, eq, ok, done} from './test.js';
//   test('adds', () => eq(1 + 1, 2));
//   await done();

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
export async function done() {
    let failed = 0;
    for (const {name, fn} of tests) {
        try {
            await fn();
            print(`PASS ${name}`);
        } catch (e) {
            failed++;
            print(`FAIL ${name}: ${e.message}`);
        }
    }
    print(`${tests.length - failed}/${tests.length} passed`);
    if (failed)
        imports.system.exit(1);
}
