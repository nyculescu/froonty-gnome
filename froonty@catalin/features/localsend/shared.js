// SPDX-License-Identifier: GPL-3.0-or-later
// One LocalSend service per Shell (docs/features/localsend.md). The
// extension holds it while the tab is enabled (index.js, background), so
// the iPhone can send with the island collapsed and the tab never opened;
// the tab holds it too while it exists. It follows the tab's settings:
// "Visible" off stops the helper; the name, port and ZeroTier restart it;
// the others (LIVE_KEYS) reach it while it runs.

import {LocalSendNotifier} from './notify.js';
import {startHelper} from './run.js';
import {helperConfig, LIVE_KEYS, liveConfig, LocalSendService, settingsStore} from './service.js';

const RESTART_KEYS = ['localsend-alias', 'localsend-port', 'localsend-zerotier'];

let shared = null;
let users = 0;
let settingsRef = null;

function sync() {
    if (settingsRef.get_boolean('localsend-visible'))
        shared.start();
    else
        shared.stop('hidden');
}

export function acquireService(settings) {
    if (!shared) {
        settingsRef = settings;
        shared = new LocalSendService({
            config: () => helperConfig(settings),
            start: startHelper,
            notifier: new LocalSendNotifier(),
            store: settingsStore(settings),
        });
        settings.connectObject('changed::localsend-visible', () => sync(), shared);
        // Folder, devices added by address, trust: sent to the running
        // helper, so a transfer under way goes on.
        for (const key of LIVE_KEYS)
            settings.connectObject(`changed::${key}`, () => shared.update(liveConfig(settings)), shared);
        for (const key of RESTART_KEYS) {
            settings.connectObject(`changed::${key}`, () => {
                if (shared.running || shared.state.status === 'failed')
                    shared.restart();
            }, shared);
        }
        sync();
    }
    users++;
    return shared;
}

export function releaseService() {
    if (--users > 0)
        return;
    settingsRef?.disconnectObject(shared);
    shared?.destroy();
    shared = null;
    settingsRef = null;
    users = 0;
}
