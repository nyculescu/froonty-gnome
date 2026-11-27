// SPDX-License-Identifier: GPL-3.0-or-later
// Timezone comparison on a real instant, so DST and date changes are
// handled by GLib's timezone database rather than fixed hour offsets.

import GLib from 'gi://GLib';

export const VANCOUVER_TIMEZONE = 'America/Vancouver';
export const MAX_FAVORITES = 5;
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

// Midnight UTC of the date it is in that zone, in days since 1970.
function dayNumber(timestamp, zone) {
    const t = GLib.DateTime.new_from_unix_utc(Math.floor(timestamp)).to_timezone(zone);
    const day = GLib.DateTime.new_utc(t.get_year(), t.get_month(), t.get_day_of_month(), 0, 0, 0);
    return Math.round(day.to_unix() / 86400);
}

/**
 * How many days the city's date is ahead of the local one at that instant,
 * as flight times have it: 1 when the city is already past midnight, -1
 * when it is still the day before.
 *
 * @param {number} timestamp Unix seconds
 * @param {string} timezone the city's tzdata name
 * @param {GLib.TimeZone} [localZone] the local zone, the computer's by default
 */
export function dayOffsetAt(timestamp, timezone, localZone = GLib.TimeZone.new_local()) {
    return dayNumber(timestamp, GLib.TimeZone.new_identifier(timezone)) -
        dayNumber(timestamp, localZone);
}

// '+1', '−1' (a minus sign, as wide as the plus) or '' on the same day.
export function dayOffsetLabel(offset) {
    if (!offset)
        return '';
    return offset > 0 ? `+${offset}` : `−${-offset}`;
}

/**
 * What +1 or −1 says, for accessible names; null on the same day.
 *
 * @param {number} offset from dayOffsetAt
 * @param {Function} _ gettext (this module is also loaded in Settings)
 */
export function dayOffsetName(offset, _) {
    if (!offset)
        return null;
    if (offset > 0)
        return offset === 1 ? _('the next day') : _('%d days later').format(offset);
    return offset === -1 ? _('the day before') : _('%d days earlier').format(-offset);
}
