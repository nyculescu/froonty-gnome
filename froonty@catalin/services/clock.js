// SPDX-License-Identifier: GPL-3.0-or-later
// Clock service: formatted time/date strings, updated once per minute.
//
// Timing comes from GNOME's top bar clock: Froonty listens to its
// GnomeDesktop.WallClock (shell/dateMenu.js). It wakes up only on minute
// boundaries (or seconds, if the user enabled clock-show-seconds) and
// re-fires immediately when the wall clock jumps, e.g. after suspend/resume
// or a timezone change. Froonty therefore owns no timer of its own.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GnomeDesktop from 'gi://GnomeDesktop';
import Shell from 'gi://Shell';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {topBarWallClock} from '../shell/dateMenu.js';

const INTERFACE_SCHEMA = 'org.gnome.desktop.interface';

// Shell.util_translate_time_string() looks strings up in GNOME Shell's own
// translation catalog, so these must match msgids used by GNOME Shell 46
// (ui/dateMenu.js, "calendar heading" context). Froonty gets localized date
// layouts without shipping translations.
const pgettextKey = (context, msgid) => `${context}\u0004${msgid}`;
const LONG_DATE_FORMAT = pgettextKey('calendar heading', '%B %-d %Y');

const TIME_FORMAT_24H = '%H:%M';
const TIME_FORMAT_12H = '%-l:%M %p';
const WEEKDAY_FORMAT = '%A';
const SHORT_DATE_FORMAT = '%a %-d';

/**
 * Emits 'changed' whenever the displayed text may have changed.
 * Call snapshot() to get the current strings.
 */
export class ClockService extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._wallClock = null;
        this._interfaceSettings = null;
    }

    start() {
        if (this._wallClock)
            return;

        // Only if the top bar has none (a changed Shell): then a clock of
        // its own, left to the garbage collector after stop().
        this._wallClock = topBarWallClock() ?? new GnomeDesktop.WallClock();
        this._wallClock.connectObject(
            'notify::clock', () => this.emit('changed'),
            'notify::timezone', () => this.emit('changed'),
            this);

        this._interfaceSettings = new Gio.Settings({schema_id: INTERFACE_SCHEMA});
        this._interfaceSettings.connectObject(
            'changed::clock-format', () => this.emit('changed'), this);

        this._settings.connectObject(
            'changed::clock-format', () => this.emit('changed'),
            'changed::show-date', () => this.emit('changed'),
            this);
    }

    stop() {
        if (!this._wallClock)
            return;

        this._settings.disconnectObject(this);
        this._interfaceSettings.disconnectObject(this);
        this._interfaceSettings = null;

        // The top bar's clock is GNOME's; it is only let go of here.
        this._wallClock.disconnectObject(this);
        this._wallClock = null;
    }

    /**
     * @returns {{time: string, shortDate: string, weekday: string,
     *            longDate: string, showDate: boolean}}
     */
    snapshot() {
        const now = GLib.DateTime.new_now(this._timeZone());
        return {
            time: now.format(this._timeFormat()).trim(),
            shortDate: now.format(SHORT_DATE_FORMAT),
            weekday: now.format(WEEKDAY_FORMAT),
            longDate: now.format(Shell.util_translate_time_string(LONG_DATE_FORMAT)),
            showDate: this._settings.get_boolean('show-date'),
        };
    }

    /**
     * A moment in the clock's time zone and format: "22:59", with
     * `weekday` "Sat 22:59", with `date` "Thu 5 Nov 08:59".
     *
     * @param {number} ms since the epoch
     * @param {object} [options]
     * @param {boolean} [options.weekday]
     * @param {boolean} [options.date] weekday, day and month
     */
    formatTime(ms, {weekday = false, date = false} = {}) {
        const time = GLib.DateTime.new_from_unix_utc(Math.floor(ms / 1000))
            .to_timezone(this._timeZone());
        let format = this._timeFormat();
        if (date)
            format = `%a %-d %b ${format}`;
        else if (weekday)
            format = `%a ${format}`;
        return time.format(format).trim();
    }

    /** The top bar clock's time zone (GLib.TimeZone). */
    get timeZone() {
        return this._timeZone();
    }

    _timeZone() {
        return this._wallClock?.timezone ?? GLib.TimeZone.new_local();
    }

    _timeFormat() {
        let format = this._settings.get_string('clock-format');
        if (format === 'system')
            format = this._interfaceSettings?.get_string('clock-format') ?? '24h';

        // Some locales have no AM/PM designator; trim() in snapshot()
        // removes the dangling space %p then leaves behind.
        return format === '12h' ? TIME_FORMAT_12H : TIME_FORMAT_24H;
    }
}
