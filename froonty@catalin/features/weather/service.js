// SPDX-License-Identifier: GPL-3.0-or-later
// Fetches the Weather card's cities from Open-Meteo: one request for all of
// them every 15 minutes while a card holds the service (shared.js), at once
// when the cities change, and 2 minutes after a failure. A failed fetch
// keeps the last readings, marked stale. They are also kept on disk and
// shown at start until the first fetch ends.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {Emitter} from '../../core/emitter.js';
import {OpenMeteoError, citiesOf, forecastUrl, parseForecast} from './sources.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_async', 'replace_contents_finish');

export const REFRESH_S = 15 * 60;
export const RETRY_S = 2 * 60;
const TIMEOUT_S = 15;

// The cities a set of readings is for: another set must not show them.
const signature = cities => JSON.stringify(cities.map(c => [c.name, c.lat, c.lon]));

export class WeatherService extends Emitter {
    /**
     * @param {Gio.Settings} settings
     * @param {object} [options]
     * @param {Function} [options.fetch] (url, cancellable) → {status, text}
     * @param {string|null} [options.cachePath] null keeps nothing on disk
     */
    constructor(settings, {fetch, cachePath} = {}) {
        super();
        this._settings = settings;
        this._fetch = fetch ?? ((url, cancellable) => this._fetchDefault(url, cancellable));
        this._cachePath = cachePath !== undefined ? cachePath
            : GLib.build_filenamev([GLib.get_user_cache_dir(), 'froonty', 'weather.json']);
        this._readings = [];
        // signature() of the cities the readings are for.
        this._readingsFor = '';
        this._stale = false;
        this._error = '';
        this._refreshing = false;
        this._pending = false;
        this._timerId = 0;
        this._settingsId = 0;
        this._cancellable = null;
        this._session = null;
    }

    /** Per city: sources.js parseForecast's readings, in the settings' order. */
    get readings() {
        return this._readings;
    }

    /** Whether the readings are from before the last, failed fetch. */
    get stale() {
        return this._stale;
    }

    get error() {
        return this._error;
    }

    get refreshing() {
        return this._refreshing;
    }

    start() {
        this._cancellable = new Gio.Cancellable();
        this._settingsId = this._settings.connect('changed::weather-cities', () => this.refresh());
        this._loadCache().finally(() => this.refresh());
    }

    stop() {
        if (this._settingsId)
            this._settings.disconnect(this._settingsId);
        this._settingsId = 0;
        this._cancellable?.cancel();
        this._cancellable = null;
        this._session?.abort();
        this._session = null;
        this._clearTimer();
    }

    // One asked for during one runs once it ends, with the cities as they are then.
    async refresh() {
        if (!this._cancellable)
            return;
        if (this._refreshing) {
            this._pending = true;
            return;
        }
        this._clearTimer();
        this._refreshing = true;
        this.emit('changed');
        const cancellable = this._cancellable;
        let failed = false;
        try {
            do {
                this._pending = false;
                // eslint-disable-next-line no-await-in-loop
                failed = !await this._fetchOnce(cancellable);
            } while (this._pending && !cancellable.is_cancelled());
        } finally {
            this._refreshing = false;
        }
        if (cancellable.is_cancelled())
            return;
        this.emit('changed');
        if (this._readings.length || failed) {
            this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, failed ? RETRY_S : REFRESH_S, () => {
                this._timerId = 0;
                this.refresh();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // Whether it got readings (no cities counts as done).
    async _fetchOnce(cancellable) {
        const cities = this._cities();
        if (!cities.length) {
            this._readings = [];
            this._stale = false;
            this._error = '';
            return true;
        }
        const key = signature(cities);
        try {
            const {status, text} = await this._fetch(forecastUrl(cities), cancellable);
            let readings;
            try {
                readings = parseForecast(text, cities);
            } catch (e) {
                throw status === 200 || e instanceof OpenMeteoError ? e : new Error(`Open-Meteo: HTTP ${status}`);
            }
            if (cancellable.is_cancelled())
                return true;
            this._readings = readings;
            this._readingsFor = key;
            this._stale = false;
            this._error = '';
            this._saveCache().catch(e => console.warn(`Froonty: Weather cache: ${e.message}`));
            return true;
        } catch (e) {
            if (cancellable.is_cancelled())
                return true;
            this._error = e.message;
            // Readings for other cities would mislead.
            if (this._readingsFor !== key)
                this._readings = [];
            this._stale = this._readings.length > 0;
            return false;
        }
    }

    _cities() {
        return citiesOf(this._settings.get_value('weather-cities').deepUnpack());
    }

    _clearTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }

    async _fetchDefault(url, cancellable) {
        this._session ??= new Soup.Session({timeout: TIMEOUT_S, user_agent: 'Froonty'});
        const message = Soup.Message.new('GET', url);
        const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
        return {status: message.get_status(), text: new TextDecoder().decode(bytes.toArray())};
    }

    async _loadCache() {
        if (!this._cachePath)
            return;
        try {
            const [contents] = await Gio.File.new_for_path(this._cachePath).load_contents_async(this._cancellable);
            const cache = JSON.parse(new TextDecoder().decode(contents));
            if (cache.cities !== signature(this._cities()))
                return;
            this._readings = cache.readings;
            this._readingsFor = cache.cities;
            this._stale = true;
            this.emit('changed');
        } catch {}
    }

    async _saveCache() {
        if (!this._cachePath)
            return;
        const file = Gio.File.new_for_path(this._cachePath);
        GLib.mkdir_with_parents(file.get_parent().get_path(), 0o755);
        const cache = {cities: this._readingsFor, readings: this._readings};
        await file.replace_contents_async(new TextEncoder().encode(JSON.stringify(cache)),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }
}
