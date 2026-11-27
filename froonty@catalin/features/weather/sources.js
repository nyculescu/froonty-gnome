// SPDX-License-Identifier: GPL-3.0-or-later
// Where the Weather card's numbers come from, as pure functions: Open-Meteo's
// forecast and city search addresses and the readers of their answers, and
// what a WMO weather code means. Open-Meteo is free for non-commercial use,
// needs no key, and asks for a link to it next to its data.

export const MAX_CITIES = 3;
export const FORECAST_DAYS = 3;
export const ATTRIBUTION_URL = 'https://open-meteo.com/';

// 6 current and 4 daily variables: at most 10, so a city counts as one call
// against Open-Meteo's free limits.
const CURRENT = 'temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m,relative_humidity_2m';
const DAILY = 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max';

/** The favourite cities from the setting (a(sdd)): {name, lat, lon}, the first MAX_CITIES. */
export function citiesOf(value) {
    return value.slice(0, MAX_CITIES).map(([name, lat, lon]) => ({name, lat, lon}));
}

/** One request for every city; Open-Meteo answers them in the same order. */
export function forecastUrl(cities) {
    const list = key => cities.map(c => c[key].toFixed(4)).join(',');
    return `https://api.open-meteo.com/v1/forecast?latitude=${list('lat')}&longitude=${list('lon')}` +
        `&current=${CURRENT}&daily=${DAILY}&forecast_days=${FORECAST_DAYS}&timezone=auto`;
}

// Open-Meteo explains a refusal ({"error": true, "reason": …}).
export class OpenMeteoError extends Error {}

/**
 * A reading per city: {name, timeMs, temp, feels, code, isDay, wind,
 * humidity, days: [{date: 'YYYY-MM-DD', code, max, min, rain}]}.
 *
 * @param {string} text Open-Meteo's JSON: an object for one city, a list for several
 * @param {object[]} cities as asked, for their names
 */
export function parseForecast(text, cities) {
    const answer = JSON.parse(text);
    if (answer?.error)
        throw new OpenMeteoError(answer.reason ?? 'Open-Meteo refused the request');
    const places = Array.isArray(answer) ? answer : [answer];
    if (places.length !== cities.length)
        throw new Error('Open-Meteo answered for other cities');
    return places.map((place, i) => {
        const now = place.current ?? {};
        const daily = place.daily ?? {};
        if (!Number.isFinite(now.temperature_2m))
            throw new Error('No temperature in Open-Meteo\'s answer');
        // Its times are the place's local time; the offset makes them UTC.
        const timeMs = Date.parse(`${now.time}Z`) - (place.utc_offset_seconds ?? 0) * 1000;
        return {
            name: cities[i].name,
            timeMs,
            temp: now.temperature_2m,
            feels: now.apparent_temperature ?? null,
            code: now.weather_code ?? null,
            isDay: now.is_day !== 0,
            wind: now.wind_speed_10m ?? null,
            humidity: now.relative_humidity_2m ?? null,
            days: (daily.time ?? []).map((date, d) => ({
                date,
                code: daily.weather_code?.[d] ?? null,
                max: daily.temperature_2m_max?.[d] ?? null,
                min: daily.temperature_2m_min?.[d] ?? null,
                rain: daily.precipitation_probability_max?.[d] ?? null,
            })),
        };
    });
}

export function searchUrl(name, language = 'en') {
    return 'https://geocoding-api.open-meteo.com/v1/search' +
        `?name=${encodeURIComponent(name)}&count=8&language=${encodeURIComponent(language)}&format=json`;
}

/**
 * Open-Meteo's places for a search: {name, detail, lat, lon}. The detail
 * tells same-named places apart ("Metro Vancouver, British Columbia, Canada").
 */
export function parseSearch(text) {
    const answer = JSON.parse(text);
    if (answer?.error)
        throw new OpenMeteoError(answer.reason ?? 'Open-Meteo refused the search');
    return (answer.results ?? [])
        .filter(r => Number.isFinite(r.latitude) && Number.isFinite(r.longitude))
        .map(r => ({
            name: r.name,
            detail: [r.admin2, r.admin1, r.country].filter(Boolean).join(', '),
            lat: r.latitude,
            lon: r.longitude,
        }));
}

/**
 * What a WMO weather code means: a label (in the caller's gettext) and
 * GNOME's weather icon, the night one where there is one.
 *
 * @param {number|null} code
 * @param {boolean} isDay
 * @param {Function} _ gettext
 */
export function conditionOf(code, isDay, _) {
    const night = isDay ? '' : '-night';
    if (code === 0)
        return {label: _('Clear'), icon: `weather-clear${night}-symbolic`};
    if (code === 1)
        return {label: _('Mainly clear'), icon: `weather-few-clouds${night}-symbolic`};
    if (code === 2)
        return {label: _('Partly cloudy'), icon: `weather-few-clouds${night}-symbolic`};
    if (code === 3)
        return {label: _('Overcast'), icon: 'weather-overcast-symbolic'};
    if (code === 45 || code === 48)
        return {label: _('Fog'), icon: 'weather-fog-symbolic'};
    if (code >= 51 && code <= 57)
        return {label: _('Drizzle'), icon: 'weather-showers-scattered-symbolic'};
    if (code >= 61 && code <= 67)
        return {label: _('Rain'), icon: 'weather-showers-symbolic'};
    if (code >= 71 && code <= 77)
        return {label: _('Snow'), icon: 'weather-snow-symbolic'};
    if (code >= 80 && code <= 82)
        return {label: _('Rain showers'), icon: 'weather-showers-scattered-symbolic'};
    if (code === 85 || code === 86)
        return {label: _('Snow showers'), icon: 'weather-snow-symbolic'};
    if (code >= 95 && code <= 99)
        return {label: _('Thunderstorm'), icon: 'weather-storm-symbolic'};
    return {label: _('Unknown'), icon: 'weather-severe-alert-symbolic'};
}
