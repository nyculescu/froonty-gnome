// SPDX-License-Identifier: GPL-3.0-or-later
// One WeatherService per Shell, held by the Widgets tab's card and the
// desktop card, so they show the same readings from one set of requests.

import {WeatherService} from './service.js';

let service = null;
let holders = 0;

export function acquireWeatherService(settings) {
    if (!service) {
        service = new WeatherService(settings);
        service.start();
    }
    holders++;
    return service;
}

export function releaseWeatherService() {
    if (holders === 0)
        return;
    holders--;
    if (holders === 0) {
        service.stop();
        service = null;
    }
}
