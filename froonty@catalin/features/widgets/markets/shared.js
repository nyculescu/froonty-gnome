// SPDX-License-Identifier: GPL-3.0-or-later
// One MarketsService per Shell, held by the Widgets tab and the desktop
// card, so they show the same readings from one set of requests.

import {MarketsService} from './service.js';

let service = null;
let holders = 0;

export function acquireMarketsService(settings) {
    if (!service) {
        service = new MarketsService(settings);
        service.start();
    }
    holders++;
    return service;
}

export function releaseMarketsService() {
    if (holders === 0)
        return;
    holders--;
    if (holders === 0) {
        service.stop();
        service = null;
    }
}
