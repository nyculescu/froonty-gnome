// SPDX-License-Identifier: GPL-3.0-or-later
// One HorizonService per Shell, held by the Widgets tab, the desktop card
// and, during a refresh it started, the Horizon panic button, so a refresh
// started in one shows in the others. `horizonEvents` outlives the
// service: 'busy' (bool) and 'error' (message), for the panic button.

import {Emitter} from '../../core/emitter.js';
import {HorizonService} from './horizonService.js';

let service = null;
let holders = 0;
let serviceIds = [];
// The last refresh's problem, until the next one starts.
let lastError = '';

export const horizonEvents = new Emitter();

export function acquireHorizonService(settings) {
    if (!service) {
        service = new HorizonService(settings);
        serviceIds = [
            service.connect('refresh-state', (_service, refreshing) => {
                if (refreshing)
                    lastError = '';
                horizonEvents.emit('busy', refreshing);
            }),
            service.connect('refresh-error', (_service, message) => {
                lastError = message;
                horizonEvents.emit('error', message);
            }),
        ];
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
        for (const id of serviceIds)
            service.disconnect(id);
        serviceIds = [];
        // A refresh still running is stopped with it.
        const wasBusy = service.refreshing;
        service.stop();
        service = null;
        if (wasBusy)
            horizonEvents.emit('busy', false);
    }
}

/** Whether Horizon is running for a new briefing. */
export function horizonBusy() {
    return service?.refreshing ?? false;
}

/** Why the last refresh failed, or ''. */
export function horizonError() {
    return lastError;
}

/**
 * Runs Horizon for a new briefing, holding the service until it ends, so
 * it also works while no card shows Horizon (the card shows the briefing
 * when it next opens).
 */
export function refreshHorizon(settings) {
    if (horizonBusy())
        return;
    const held = acquireHorizonService(settings);
    const id = horizonEvents.connect('busy', (_events, busy) => {
        if (busy)
            return;
        horizonEvents.disconnect(id);
        releaseHorizonService();
    });
    held.triggerRefresh();
}
