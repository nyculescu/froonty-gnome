// SPDX-License-Identifier: GPL-3.0-or-later
// Vancouver-based time calculations and saved comparison cities.

import GLib from 'gi://GLib';

import {
    decodeCity, encodeCity, favoriteCities, formatDateAt, formatTimeAt, isTimezoneIdentifier,
    MAX_FAVORITES, plannerTimeFormat,
    SLIDER_WINDOW_SECONDS, sliderTimestamp, TIME_FORMATS, VANCOUVER_TIMEZONE,
} from '../../froonty@catalin/features/timezonePlanner/clock.js';
import {done, eq, ok, test} from './test.js';

test('the planner uses Vancouver as its base and starts with two comparison slots', () => {
    eq(VANCOUVER_TIMEZONE, 'America/Vancouver');
    eq(MAX_FAVORITES, 2);
});

test('the slider spans 24 hours centered on the actual current instant', () => {
    const anchor = 1_800_000_000;
    eq(sliderTimestamp(anchor, 0), anchor - SLIDER_WINDOW_SECONDS / 2);
    eq(sliderTimestamp(anchor, 0.5), anchor);
    eq(sliderTimestamp(anchor, 1), anchor + SLIDER_WINDOW_SECONDS / 2);
});

test('GLib timezone conversions account for DST and date rollover', () => {
    const winter = GLib.DateTime.new(GLib.TimeZone.new_utc(), 2026, 1, 15, 12, 0, 0).to_unix();
    eq(formatTimeAt(winter, VANCOUVER_TIMEZONE), '04:00');
    eq(formatTimeAt(winter, 'Europe/Dublin'), '12:00');

    const summer = GLib.DateTime.new(GLib.TimeZone.new_utc(), 2026, 7, 15, 12, 0, 0).to_unix();
    eq(formatTimeAt(summer, VANCOUVER_TIMEZONE), '05:00');
    eq(formatTimeAt(summer, 'Europe/Dublin'), '13:00');

    const late = GLib.DateTime.new(GLib.TimeZone.new_utc(), 2026, 1, 15, 23, 30, 0).to_unix();
    eq(formatTimeAt(late, 'Europe/Dublin'), '23:30');
    eq(formatDateAt(late, 'America/Vancouver'), 'Thu, 15 Jan');
});

test('times follow the chosen format: the clock\'s own, 24-hour or 12-hour', () => {
    eq(TIME_FORMATS, ['clock', '24h', '12h']);
    const clock12h = '%-l:%M %p';
    eq(plannerTimeFormat('clock', clock12h), clock12h);
    eq(plannerTimeFormat('clock', '%H:%M'), '%H:%M');

    const afternoon = GLib.DateTime.new(GLib.TimeZone.new_utc(), 2026, 1, 15, 14, 5, 0).to_unix();
    eq(formatTimeAt(afternoon, 'Europe/Dublin', plannerTimeFormat('24h', clock12h)), '14:05');
    eq(formatTimeAt(afternoon, 'Europe/Dublin', plannerTimeFormat('12h', '%H:%M')), '2:05 PM');
    eq(formatTimeAt(afternoon, VANCOUVER_TIMEZONE, plannerTimeFormat('12h', '%H:%M')), '6:05 AM');
    const noon = GLib.DateTime.new(GLib.TimeZone.new_utc(), 2026, 1, 15, 12, 5, 0).to_unix();
    eq(formatTimeAt(noon, 'Europe/Dublin', plannerTimeFormat('12h', '%H:%M')), '12:05 PM');
});

test('manual city records round-trip and invalid timezone IDs are rejected', () => {
    const record = encodeCity('Timisoara', 'Europe/Bucharest');
    eq(decodeCity(record), {name: 'Timisoara', timezone: 'Europe/Bucharest'});
    ok(isTimezoneIdentifier('Europe/Dublin'));
    ok(!isTimezoneIdentifier('Not/A_Timezone'));
    ok(isTimezoneIdentifier('UTC'));
    // A POSIX TZ string GLib would take: three hours behind UTC.
    ok(!isTimezoneIdentifier('UTC+3'));
    eq(decodeCity('Nowhere|Not/A_Timezone'), null);
    eq(decodeCity('no separator'), null);
});

test('a saved record that is not a city is skipped', () => {
    eq(favoriteCities(['Dublin|Europe/Dublin', 'broken'], ['Europe/Dublin']),
        [{name: 'Dublin', timezone: 'Europe/Dublin'}]);
});

test('favourites select only matching saved cities and are capped at two', () => {
    const cities = [
        'Dublin|Europe/Dublin', 'Timisoara|Europe/Bucharest', 'Paris|Europe/Paris',
    ];
    eq(favoriteCities(cities, ['Europe/Paris', 'Europe/Dublin']), [
        {name: 'Dublin', timezone: 'Europe/Dublin'},
        {name: 'Paris', timezone: 'Europe/Paris'},
    ]);
    // More than two: the first two count.
    eq(favoriteCities(cities, ['Europe/Dublin', 'Europe/Bucharest', 'Europe/Paris']), [
        {name: 'Dublin', timezone: 'Europe/Dublin'},
        {name: 'Timisoara', timezone: 'Europe/Bucharest'},
    ]);
});

await done();
