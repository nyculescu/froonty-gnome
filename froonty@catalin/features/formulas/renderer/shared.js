// SPDX-License-Identifier: GPL-3.0-or-later
// One math renderer client per process (docs/features/formulas.md §4):
// the Formulas tab and the formulas in notes share it, so GNOME Shell runs
// at most one helper process, and the settings window one of its own. It
// is made by the first user and destroyed (its helper stopped) when the
// last one lets it go.

import {MathRenderClient} from './client.js';

let client = null;
let users = 0;

/** The shared client; each call needs its own releaseRenderer(). */
export function acquireRenderer() {
    users++;
    client ??= new MathRenderClient();
    return client;
}

export function releaseRenderer() {
    if (users === 0)
        return;
    users--;
    if (users === 0) {
        client?.destroy();
        client = null;
    }
}

/** The shared client while anyone holds it, else null (tests). */
export function sharedRenderer() {
    return client;
}
