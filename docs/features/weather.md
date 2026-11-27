# Feature: Weather

Status: **implemented**, 2026-11-23 (owner: "Start a new widget, weather …
updated every 15 or 30 minutes from a very reliable and trusted source
and also free of charge"; "The weather app must be lightweight too, no
overengineering"; "up to 3 cities as favourites, but start with
Vancouver (Shaughnessy, if possible), every 15 minutes").

A card in the Widgets tab and on the desktop ([widgets.md](widgets.md)):
per favourite city its weather icon and temperature, its name, then the
condition, the feels-like temperature and the wind, each on its own line
(owner, 2026-11-23), and the next days' icons, highs and lows. Under them
the link Open-Meteo's terms ask for. It is not a hub tab.

Bright colours on purpose (owner, 2026-11-23: "I need to see, so use some
bright colors"), as the card sits on any wallpaper: white text, the
details at 85 %, each icon tinted by what it shows (`view.js` `tone`: sun
yellow, rain blue, storm purple, night lavender, clouds and fog off-white,
snow white), the high warm orange and the low light blue.

Code: `froonty@catalin/features/weather/`: `sources.js` (pure: addresses,
readers, WMO codes), `service.js`, `shared.js`, `view.js`, `prefs.js`.

## 1. Settings

Settings → Weather (`prefs.js`):

- `weather-enabled` (on): off, the card shows nowhere and nothing is
  fetched.
- `weather-cities` (`a(sdd)`: name, latitude, longitude; default
  `('Shaughnessy, Vancouver', 49.25, -123.13333)`): up to 3 favourites.
  Added from a search box (Open-Meteo's city search: "Shaughnessy" finds
  the Vancouver neighbourhood, told apart from the Alberta village by its
  region), removed with Remove.

Settings → Widgets → Weather: "Show Weather in the Widgets tab"
(`widgets-weather-enabled`). The desktop card: Settings → Widgets → On
the desktop (`widgets-weather-pin-desktop`, off). Its desktop placement id
is `weather`.

## 2. Source: Open-Meteo, and only it

Chosen 2026-11-23 after a researched and verified comparison (official
docs and terms read that day):

- **Trust:** run by OpenMeteo GmbH (Switzerland) from national weather
  services' and ECMWF models (the UK Met Office's 2 km model for Ireland
  and the UK); its server is open source (AGPLv3), its data CC BY 4.0.
- **Free:** for non-commercial use, without a key or sign-up. Limits:
  under 10,000 calls a day, 5,000 an hour, 600 a minute; a city with at
  most 10 variables counts as one call. Froonty asks for 6 current and 4
  daily variables, so 3 cities every 15 minutes are 288 calls a day.
- **Fresh:** "current" is 15-minutely model data (native in Central
  Europe and North America, interpolated from hourly data elsewhere), not
  station observations.
- **No contact details:** Open-Meteo has no User-Agent rule, so requests
  carry only "Froonty", as Markets' do.
- **Its terms:** a link to Open-Meteo next to its data (the card's "Weather
  data by Open-Meteo.com" opens open-meteo.com), and non-commercial use.

Not used: MET Norway (it requires a real contact, an email or website, in
every request, and asks outside the Nordics for at most one request every
3 hours); libgweather 4.4.4, installed with GNOME (the same contact rule,
its METAR address answers 404, MET's deprecated XML); GeoClue for the
location (Location Services off; a fixed city is simpler); Bright Sky
(one maintainer, outages this year). Kept lightweight on purpose: no
second source, no unit setting (°C, km/h), no panic button.

## 3. Refreshes

`WeatherService` (`service.js`) runs while a card holds it (`shared.js`).
One request for all cities (Open-Meteo answers an object for one city, a
list in the same order for several), at start, every 15 minutes, at once
when the cities change, and 2 minutes after a failure. A failed fetch
keeps the readings, marked "Not updated: <reason>" in the header; the
readings for other cities are never shown. The last readings are kept in
`$XDG_CACHE_HOME/froonty/weather.json` and shown at start until the first
fetch ends. Open-Meteo's own reason for a refusal is shown as it is.

The header says when the reading is from ("At 17:00", Open-Meteo's
15-minute step, in local time). Days: "Today", then the weekday's short
name. Icons: GNOME's `weather-*-symbolic`, the night ones for clear and
few clouds at night (`conditionOf`).

## 4. Tests

`tools/unit/weather.test.js`: the address (one request, 10 variables),
one and several cities (as Open-Meteo answered for Shaughnessy on
2026-11-23), a refusal's reason, the city search, the WMO codes, and the
service on a fake fetch (the default city at start, a failure keeping
stale readings, other cities never showing the old ones, no cities no
request). Headless: `testWeatherCard` draws the card from a fake service.
