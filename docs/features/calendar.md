# Feature: Calendar

Status: **design**, next after Notes. Answered 2026-09-28: all calendars
enabled in GNOME are shown, with a per-calendar opt-out in the Calendar
settings tab (for now); the week start follows the locale; the countdown to
the next event in the collapsed island comes later, as a separate step. No
questions are open; waiting for `gir1.2-ecal-2.0` and the accounts.

## 1. Goal

The hub gets a Calendar tab:

- **Left:** a month grid with a **Day / Week / Month** switch.
- **Right:** the events in the selected day, week or month.
- **Aggregation:** events come from all of the user's calendars (Google,
  Outlook, Apple iCloud, and anything else GNOME knows).
- **Links:** clicking an event opens its day in the web calendar it came
  from. A row of Google / Outlook / iCloud buttons opens each web calendar.

## 2. Data source (agreed): GNOME's Evolution Data Server

Froonty does **not** aggregate calendars itself. GNOME already does:

| Provider | How it reaches EDS | Package needed |
|---|---|---|
| Google | Settings → Online Accounts → Google | none |
| Outlook / Microsoft 365 | Settings → Online Accounts → Microsoft 365 (or Microsoft Exchange) | `evolution-ews` (provides the EDS backend) |
| Apple iCloud | GNOME Calendar / Evolution → add a CalDAV calendar (`caldav.icloud.com`, app-specific password) | none (GNOME Calendar only for setup) |
| Any ICS / CalDAV | GNOME Calendar → "Add calendar from URL" | none |

Froonty reads EDS through its GObject-introspection bindings.
**New runtime dependency:** `gir1.2-ecal-2.0` (which pulls in
`gir1.2-edataserver-1.2` and `gir1.2-ical-3.0`). If it is missing, the tab
shows how to install it, and nothing else fails.

Why not the Shell's own calendar server (`org.gnome.Shell.CalendarServer`)?

- It has **one** global time range (`Since`/`Until`). Froonty changing it
  would change what the top-bar calendar has loaded.
- Its events carry only title and times: no calendar name, colour or
  location.

## 3. Structure

```
features/calendar/
├── index.js        descriptor
├── service.js      EDS: registry → enabled calendar sources → async clients
│                   → live views for the visible range; emits 'changed'
├── range.js        pure date math: day/week/month ranges, locale week start
├── providers.js    pure: ESource → {provider: google|microsoft|icloud|other,
│                   webDayUrl(date)}
├── monthGrid.js    St: month grid, today/selected/range highlight, dots
├── agenda.js       St: grouped event cards, "Now"/"Next", past dimmed
├── view.js         St: composes switch + grid + agenda + provider buttons
└── prefs.js        Calendar tab: enable, choose calendars, week start
```

`range.js` and `providers.js` get unit tests (plain `gjs`).

## 4. Behaviour

- **Granularity:**
  - *Day* shows the selected day.
  - *Week* shows the selected day's week.
  - *Month* shows the selected day's month.
  - The grid highlights the selected span, whether one cell, a row or the
    whole month.
  - The chosen granularity is remembered.
- **Recurring events** are expanded by EDS, not by Froonty.
- **Live updates:** EDS view signals. No polling.
- **Resource use:** while the tab is hidden or the island is collapsed,
  the live views are closed. The source registry stays open until disable.
- **Event card:**
  - calendar-coloured bar
  - title
  - time ("HH:MM – HH:MM", or "All day")
  - calendar name
  - location
  - "Now"/"Next" labels
  - dimmed if in the past
- **Visual language** is adapted from vorssaint-utils' layout (not its
  code or branding):
  - month grid about 200 px wide on the left, then a divider, then the agenda
  - 24 px round day cells; today filled with the accent colour
  - up to 3 calendar-colour dots per day
  - event cards with a 3 px coloured bar and a 10% colour fill

## 5. Links

- **Per event:** open the event's **day** in the provider's web calendar
  (`providers.js`). Candidate URL patterns, **to verify during
  implementation** because they are not confirmed:
  - Google: `https://calendar.google.com/calendar/r/day/YYYY/M/D`
  - Outlook (Microsoft 365): `https://outlook.office.com/calendar/view/day/YYYY/M/D`
  - Outlook.com: `https://outlook.live.com/calendar/0/view/day/YYYY/M/D`
  - iCloud: `https://www.icloud.com/calendar/` (I know of no per-day deep link)
- **Provider detection** from EDS source data (the backend name and the
  CalDAV host, e.g. `apidata.googleusercontent.com`, `caldav.icloud.com`),
  with unit tests. The exact fields need to be checked on real sources.
- **Provider buttons:** a small row that opens each web calendar. Only the
  providers found among the user's calendars are shown.

## 6. Open questions

1. **Week start:** follow the locale (default), or a setting?
2. **Collapsed island:** should it show a countdown to the next event
   (e.g. "Standup in 12 min"), as vorssaint-utils does? I suggest adding
   it later, as a separate step.
3. **Which calendars:** all enabled GNOME calendars by default, with
   per-calendar opt-out in the Calendar settings tab. Is that right?
