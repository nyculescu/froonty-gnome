// SPDX-License-Identifier: GPL-3.0-or-later
// One HorizonService per Shell, held by the Widgets tab and the desktop
// card, so a refresh started in one shows in the other.

import {HorizonService} from './horizonService.js';

let service = null;
let holders = 0;

export function acquireHorizonService(settings) {
    if (!service) {
        service = new HorizonService(settings);
        service.start();
    }
    holders++;
    return service;
}

export function releaseHorizonService() {
    if (holders === 0)
        return;
    holders--;
    if (holders === 0) {
        service.stop();
        service = null;
    }
}
