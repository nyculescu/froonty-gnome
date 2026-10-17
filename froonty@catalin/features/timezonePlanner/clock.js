// SPDX-License-Identifier: GPL-3.0-or-later
// Timezone comparison on a real instant, so DST and date changes are
// handled by GLib's timezone database rather than fixed hour offsets.

import GLib from 'gi://GLib';

export const VANCOUVER_TIMEZONE = 'America/Vancouver';
export const MAX_FAVORITES = 2;
export const SLIDER_WINDOW_SECONDS = 24 * 60 * 60;

// The timezone-planner-time-format choices: 'clock' is whatever the
// island's clock shows (services/clock.js resolves its clock-format).
export const TIME_FORMATS = ['clock', '24h', '12h'];
// As services/clock.js has them (it is Shell-only; this module is not).
const TIME_FORMAT_24H = '%H:%M';
const TIME_FORMAT_12H = '%-l:%M %p';

/**
 * The strftime format the planner writes times in.
 *
 * @param {string} choice one of TIME_FORMATS
 * @param {string} clockFormat the island clock's own format
 */
export function plannerTimeFormat(choice, clockFormat) {
    if (choice === 'clock')
        return clockFormat;
    return choice === '12h' ? TIME_FORMAT_12H : TIME_FORMAT_24H;
}

// A tzdata name such as Europe/Dublin, or UTC. GLib also takes POSIX TZ
// strings, where 'UTC+3' means three hours behind UTC, so those are refused.
export function isTimezoneIdentifier(identifier) {
    return /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$|^UTC$/.test(identifier) &&
        GLib.TimeZone.new_identifier(identifier) !== null;
}

export function encodeCity(name, timezone) {
    return `${name}|${timezone}`;
}

// Null for a record that is not a city (an outside edit, or a zone tzdata
// dropped): readers skip it rather than fail.
export function decodeCity(record) {
    const fields = record.split('|');
    if (fields.length !== 2 || !fields[0] || !isTimezoneIdentifier(fields[1]))
        return null;
    return {name: fields[0], timezone: fields[1]};
}

export function favoriteCities(cityRecords, favoriteTimezones) {
    const favorites = favoriteTimezones.slice(0, MAX_FAVORITES);
    return cityRecords.map(decodeCity)
        .filter(city => city && favorites.includes(city.timezone));
}

export function sliderTimestamp(anchor, value) {
    return Math.round(anchor - SLIDER_WINDOW_SECONDS / 2 + value * SLIDER_WINDOW_SECONDS);
}

function timeAt(timestamp, timezone) {
    const zone = GLib.TimeZone.new_identifier(timezone);
    return GLib.DateTime.new_from_unix_utc(Math.floor(timestamp)).to_timezone(zone);
}

// Some locales have no AM/PM designator: trim() drops the space %p leaves.
export function formatTimeAt(timestamp, timezone, format = TIME_FORMAT_24H) {
    return timeAt(timestamp, timezone).format(format).trim();
}

export function formatDateAt(timestamp, timezone) {
    return timeAt(timestamp, timezone).format('%a, %d %b');
}
