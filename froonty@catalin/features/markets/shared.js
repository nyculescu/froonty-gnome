// SPDX-License-Identifier: GPL-3.0-or-later
// One MarketsService per Shell, held by the Widgets tab and the desktop
// card, so they show the same readings from one set of requests.
// `marketsEvents` outlives the service, for the Markets panic button:
// 'busy' (bool) while a refresh runs, 'held' (bool) when a card starts or
// stops showing Markets.

import {Emitter} from '../../core/emitter.js';
import {MarketsService} from './service.js';

let service = null;
let holders = 0;
let changedId = 0;
let busy = false;

export const marketsEvents = new Emitter();

function syncBusy() {
    const now = service?.refreshing ?? false;
    if (now === busy)
        return;
    busy = now;
    marketsEvents.emit('busy', busy);
}

export function acquireMarketsService(settings) {
    if (!service) {
        service = new MarketsService(settings);
        changedId = service.connect('changed', syncBusy);
        service.start();
        marketsEvents.emit('held', true);
    }
    holders++;
    return service;
}

export function releaseMarketsService() {
    if (holders === 0)
        return;
    holders--;
    if (holders === 0) {
        service.disconnect(changedId);
        changedId = 0;
        service.stop();
        service = null;
        syncBusy();
        marketsEvents.emit('held', false);
    }
}

/** Whether a card shows Markets (so there is something to refresh). */
export function marketsHeld() {
    return service !== null;
}

export function marketsBusy() {
    return busy;
}

/** Fetches every symbol again; false when no card shows Markets. */
export function refreshMarkets() {
    if (!service)
        return false;
    service.refresh({all: true});
    return true;
}
