// SPDX-License-Identifier: GPL-3.0-or-later
// One Media service per Shell (docs/features/media.md), held by whoever
// shows it: the collapsed pill's music (while its settings want it), the
// Media tab while it is on screen, and the "Pause all media" panic button
// while the island is open. The last release stops it, which undoes
// everything it started (D-Bus subscription, players, timers, network).

import St from 'gi://St';

import {shellApps} from './apps.js';
import {MediaService} from './service.js';

let shared = null;
let users = 0;

// "Froonty/0.4.0-rc0": one product token, no spaces.
function userAgent(version) {
    return version ? `Froonty/${String(version).trim().replace(/\s+/g, '-')}` : 'Froonty';
}

/**
 * @param {object} ctx feature context ({settings, memory, version})
 * @returns {MediaService}
 */
export function acquireMedia(ctx) {
    if (!shared) {
        shared = new MediaService({
            settings: ctx.settings,
            memory: ctx.memory ?? {},
            apps: shellApps,
            artSide: () => Math.round(200 * St.ThemeContext.get_for_stage(global.stage).scale_factor),
            userAgent: userAgent(ctx.version),
        });
        shared.start();
    }
    users++;
    return shared;
}

export function releaseMedia() {
    if (--users > 0)
        return;
    shared?.stop();
    shared = null;
    users = 0;
}

/** For tests and the lifecycle footprint: holders, and the service or null. */
export const mediaUsers = () => users;
export const sharedMedia = () => shared;
