// SPDX-License-Identifier: GPL-3.0-or-later
// Vancouver-based time calculations and saved comparison cities.

import GLib from 'gi://GLib';

import {
    decodeCity, encodeCity, favoriteCities, formatDateAt, formatTimeAt, isTimezoneIdentifier,
    MAX_FAVORITES,
    SLIDER_WINDOW_SECONDS, sliderTimestamp, VANCOUVER_TIMEZONE,
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

test('manual city records round-trip and invalid timezone IDs are rejected', () => {
    const record = encodeCity('Timisoara', 'Europe/Bucharest');
    eq(decodeCity(record), {name: 'Timisoara', timezone: 'Europe/Bucharest'});
    ok(isTimezoneIdentifier('Europe/Dublin'));
    ok(!isTimezoneIdentifier('Not/A_Timezone'));
});

test('favourites select only matching saved cities and are capped at two', () => {
    const cities = [
        'Dublin|Europe/Dublin', 'Timisoara|Europe/Bucharest', 'Paris|Europe/Paris',
    ];
    eq(favoriteCities(cities, ['Europe/Paris', 'Europe/Dublin']), [
        {name: 'Dublin', timezone: 'Europe/Dublin'},
        {name: 'Paris', timezone: 'Europe/Paris'},
    ]);
    let rejected = false;
    try {
        favoriteCities(cities, ['Europe/Dublin', 'Europe/Bucharest', 'Europe/Paris']);
    } catch (error) {
        rejected = error.message.includes('At most 2');
    }
    ok(rejected, 'more than two favourites are rejected');
});

await done();
