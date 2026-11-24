// SPDX-License-Identifier: GPL-3.0-or-later
// Night Light's schedule, without the Shell (unit-tested; nightLightMenu.js
// shows it). GNOME stores a time as hours from midnight (20.5 is 20:30)
// and keeps Night Light on all day when start and end are equal
// (gsd_night_light_frac_day_is_between in gnome-settings-daemon).

export const MINUTE_STEP = 5;

/** [hours, minutes] of a stored time, to the nearest minute. */
export function clockFromHours(value) {
    const minutes = ((Math.round(value * 60) % 1440) + 1440) % 1440;
    return [Math.floor(minutes / 60), minutes % 60];
}

export function hoursFromClock(hours, minutes) {
    return hours + minutes / 60;
}

/** Two digits, as GNOME Settings shows them. */
export function twoDigits(n) {
    return String(n).padStart(2, '0');
}

/** The time one hour later (delta 1) or earlier (-1), round midnight; the minutes stay. */
export function stepHour(value, delta) {
    const [hours, minutes] = clockFromHours(value);
    return hoursFromClock((hours + delta + 24) % 24, minutes);
}

/** The next multiple of MINUTE_STEP after (delta 1) or before (-1), round the hour; the hour stays. */
export function stepMinutes(value, delta) {
    const [hours, minutes] = clockFromHours(value);
    const next = delta > 0
        ? (Math.floor(minutes / MINUTE_STEP) + 1) * MINUTE_STEP
        : (Math.ceil(minutes / MINUTE_STEP) - 1) * MINUTE_STEP;
    return hoursFromClock(hours, (next + 60) % 60);
}

/** The schedule All day writes over `schedule`: To set to From, by hand. */
export function allDaySchedule(schedule) {
    return {from: schedule.from, to: schedule.from, automatic: false};
}

/** Whether GNOME runs `schedule` all day; once it doesn't, All day was changed elsewhere. */
export function isAllDay(schedule) {
    return !schedule.automatic && schedule.from === schedule.to;
}
