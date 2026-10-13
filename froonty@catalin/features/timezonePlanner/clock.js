// SPDX-License-Identifier: GPL-3.0-or-later
// Timezone comparison on a real instant, so DST and date changes are
// handled by GLib's timezone database rather than fixed hour offsets.

import GLib from 'gi://GLib';

export const VANCOUVER_TIMEZONE = 'America/Vancouver';
export const MAX_FAVORITES = 2;
export const SLIDER_WINDOW_SECONDS = 24 * 60 * 60;

export function isTimezoneIdentifier(identifier) {
    return Boolean(identifier && GLib.TimeZone.new_identifier(identifier));
}

export function encodeCity(name, timezone) {
    return `${name}|${timezone}`;
}

export function decodeCity(record) {
    const fields = record.split('|');
    if (fields.length !== 2 || !fields[0] || !isTimezoneIdentifier(fields[1]))
        throw new Error('Invalid saved timezone city');
    return {name: fields[0], timezone: fields[1]};
}

export function favoriteCities(cityRecords, favoriteTimezones) {
    if (favoriteTimezones.length > MAX_FAVORITES)
        throw new Error(`At most ${MAX_FAVORITES} timezone favourites are supported`);
    const cities = cityRecords.map(decodeCity);
    return cities.filter(city => favoriteTimezones.includes(city.timezone));
}

export function sliderTimestamp(anchor, value) {
    return Math.round(anchor - SLIDER_WINDOW_SECONDS / 2 + value * SLIDER_WINDOW_SECONDS);
}

export function timeAt(timestamp, timezone) {
    const zone = GLib.TimeZone.new_identifier(timezone);
    if (!zone)
        throw new Error(`Invalid timezone: ${timezone}`);
    return GLib.DateTime.new_from_unix_utc(Math.floor(timestamp)).to_timezone(zone);
}

export function formatTimeAt(timestamp, timezone) {
    return timeAt(timestamp, timezone).format('%H:%M');
}

export function formatDateAt(timestamp, timezone) {
    return timeAt(timestamp, timezone).format('%a, %d %b');
}
