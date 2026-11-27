// SPDX-License-Identifier: GPL-3.0-or-later
// Weather: Open-Meteo's readers and the service's refreshes with a fake
// fetch (plain gjs, no network).

import GLib from 'gi://GLib';

import {WeatherService} from '../../froonty@catalin/features/weather/service.js';
import {
    MAX_CITIES, citiesOf, conditionOf, forecastUrl, parseForecast, parseSearch, searchUrl,
} from '../../froonty@catalin/features/weather/sources.js';
import {done, eq, makeSettings, ok, test, waitFor} from './test.js';

const SHAUGHNESSY = {name: 'Shaughnessy, Vancouver', lat: 49.25, lon: -123.13333};
const DUBLIN = {name: 'Dublin', lat: 53.35, lon: -6.26};

// Shaped like Open-Meteo's answer for Shaughnessy on 2026-11-23.
const place = (temp = 8.2) => ({
    latitude: 49.235542, longitude: -123.1441, utc_offset_seconds: -25200, timezone: 'America/Vancouver',
    current: {
        time: '2026-11-23T17:00', interval: 900, temperature_2m: temp, apparent_temperature: 3.8,
        weather_code: 3, is_day: 1, wind_speed_10m: 17.0, relative_humidity_2m: 62,
    },
    daily: {
        time: ['2026-11-23', '2026-11-24', '2026-11-25'], weather_code: [61, 61, 61],
        temperature_2m_max: [9.3, 10.9, 10.2], temperature_2m_min: [4.9, 7.2, 8.9],
        precipitation_probability_max: [96, 100, 99],
    },
});

test('the address: every city in one request, 10 variables, local days', () => {
    const url = forecastUrl([SHAUGHNESSY, DUBLIN]);
    ok(url.startsWith('https://api.open-meteo.com/v1/forecast?latitude=49.2500,53.3500&longitude=-123.1333,-6.2600'));
    ok(url.includes('&forecast_days=3&timezone=auto'));
    const variables = url.match(/current=([^&]+)/)[1].split(',').length + url.match(/daily=([^&]+)/)[1].split(',').length;
    eq(variables, 10);
});

test('one city: its reading, in UTC, with three days', () => {
    const [r] = parseForecast(JSON.stringify(place()), [SHAUGHNESSY]);
    eq([r.name, r.temp, r.feels, r.code, r.isDay, r.wind, r.humidity],
        ['Shaughnessy, Vancouver', 8.2, 3.8, 3, true, 17, 62]);
    eq(r.timeMs, Date.parse('2026-11-24T00:00:00Z'), '17:00 at UTC-7');
    eq(r.days.map(d => [d.date, d.code, d.max, d.min, d.rain])[1], ['2026-11-24', 61, 10.9, 7.2, 100]);
});

test('several cities: a list, in the order asked; a short list is refused', () => {
    const readings = parseForecast(JSON.stringify([place(8), place(11)]), [SHAUGHNESSY, DUBLIN]);
    eq(readings.map(r => [r.name, r.temp]), [['Shaughnessy, Vancouver', 8], ['Dublin', 11]]);
    let message = '';
    try {
        parseForecast(JSON.stringify([place()]), [SHAUGHNESSY, DUBLIN]);
    } catch (e) {
        message = e.message;
    }
    eq(message, 'Open-Meteo answered for other cities');
});

test('Open-Meteo\'s own reason for a refusal', () => {
    let message = '';
    try {
        parseForecast('{"error":true,"reason":"Latitude must be in range of -90 to 90°. Given: 999.0."}', [SHAUGHNESSY]);
    } catch (e) {
        message = e.message;
    }
    eq(message, 'Latitude must be in range of -90 to 90°. Given: 999.0.');
});

test('city search: the address, and places told apart by their region', () => {
    eq(searchUrl('Shaughnessy'),
        'https://geocoding-api.open-meteo.com/v1/search?name=Shaughnessy&count=8&language=en&format=json');
    // As Open-Meteo answered on 2026-11-23.
    const places = parseSearch(JSON.stringify({results: [
        {name: 'Shaughnessy', latitude: 49.25, longitude: -123.13333, country: 'Canada',
            admin1: 'British Columbia', admin2: 'Metro Vancouver Regional District'},
        {name: 'Shaughnessy', latitude: 49.852, longitude: -112.84171, country: 'Canada', admin1: 'Alberta'},
        {name: 'Nowhere'},
    ]}));
    eq(places.map(p => [p.detail, p.lat]), [
        ['Metro Vancouver Regional District, British Columbia, Canada', 49.25], ['Alberta, Canada', 49.852]]);
    eq(parseSearch('{"generationtime_ms":0.2}'), [], 'no results');
});

test('the favourite cities: at most 3', () => {
    const value = [['A', 1, 2], ['B', 3, 4], ['C', 5, 6], ['D', 7, 8]];
    eq(citiesOf(value).map(c => c.name), ['A', 'B', 'C']);
    eq(MAX_CITIES, 3);
});

test('WMO codes: a label and GNOME\'s icon, the night one at night', () => {
    const id = s => s;
    eq(conditionOf(0, true, id), {label: 'Clear', icon: 'weather-clear-symbolic'});
    eq(conditionOf(0, false, id).icon, 'weather-clear-night-symbolic');
    eq(conditionOf(2, false, id).icon, 'weather-few-clouds-night-symbolic');
    eq([3, 45, 53, 63, 73, 81, 86, 95].map(code => conditionOf(code, true, id).icon), [
        'weather-overcast-symbolic', 'weather-fog-symbolic', 'weather-showers-scattered-symbolic',
        'weather-showers-symbolic', 'weather-snow-symbolic', 'weather-showers-scattered-symbolic',
        'weather-snow-symbolic', 'weather-storm-symbolic']);
    eq(conditionOf(null, true, id).label, 'Unknown');
});

function service(answer) {
    const settings = makeSettings();
    const urls = [];
    const fetch = url => {
        urls.push(url);
        const result = answer(url);
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    };
    return {service: new WeatherService(settings, {fetch, cachePath: null}), settings, urls};
}

test('service: the default city, Shaughnessy, fetched at start', async () => {
    const {service: s, urls} = service(() => ({status: 200, text: JSON.stringify(place())}));
    s.start();
    ok(await waitFor(() => !s.refreshing && s.readings.length === 1), 'fetched');
    s.stop();
    eq([s.readings[0].name, s.stale, s.error, urls.length], ['Shaughnessy, Vancouver', false, '', 1]);
    ok(urls[0].includes('latitude=49.2500&longitude=-123.1333'));
});

test('service: a failure keeps the readings, stale, with the reason', async () => {
    let online = true;
    const {service: s} = service(() => (online ? {status: 200, text: JSON.stringify(place())} : new Error('offline')));
    s.start();
    ok(await waitFor(() => !s.refreshing && s.readings.length === 1), 'fetched');
    online = false;
    await s.refresh();
    s.stop();
    eq([s.readings.length, s.stale, s.error], [1, true, 'offline']);
});

test('service: other cities fetch again; their failure does not show the old cities', async () => {
    let online = true;
    const {service: s, settings, urls} = service(() => (online
        ? {status: 200, text: JSON.stringify(place())} : {status: 503, text: 'Service Unavailable'}));
    s.start();
    ok(await waitFor(() => !s.refreshing && s.readings.length === 1), 'fetched');
    online = false;
    settings.set_value('weather-cities', new GLib.Variant('a(sdd)', [['Dublin', 53.35, -6.26]]));
    ok(await waitFor(() => urls.length === 2 && !s.refreshing), 'fetched again');
    s.stop();
    eq([s.readings.length, s.stale, s.error], [0, false, 'Open-Meteo: HTTP 503']);
});

test('service: no cities, no request', async () => {
    const {service: s, settings, urls} = service(() => ({status: 200, text: JSON.stringify(place())}));
    settings.set_value('weather-cities', new GLib.Variant('a(sdd)', []));
    s.start();
    ok(await waitFor(() => !s.refreshing), 'refreshed');
    s.stop();
    eq([urls.length, s.readings.length], [0, 0]);
});

await done();
