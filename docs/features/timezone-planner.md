# Feature: Time zone planner

Status: **implemented**.

Settings → Time zones lets you save any number of cities by name and IANA
timezone ID, and mark up to five as favourites. Dublin and Timisoara are
the defaults. Removing a city also removes it from favourites.

The Quick Settings button shows the first two favourite cities' current
local times instead of a generic label; more lines would stretch the tile
beside it. A small raised "+1" or "−1" follows a time when that city is
already on the next day, or still on the day before, against the local
date, as on flight times (owner's request 2026-11-26).

Click it and the planner opens in its menu, inside Quick Settings, as
Software brightness's menu does (owner's request 2026-11-26; it was a
modal window before). The menu has Vancouver and every favourite city.
The slider covers the 24 hours around now; moving right advances the time
in Vancouver and every favourite city together. Times and dates are
converted from the same real instant through GLib's timezone database, so
daylight-saving changes and crossing midnight are handled correctly. Each
city's time has "+1" or "−1" by it when its date is not Vancouver's at the
slider's time. Each opening starts from now, and the **Now** button
recenters the slider on the current time. **Manage cities…** closes Quick
Settings and opens Settings → Time zones.

The menu has no colours of its own: its text takes the theme's, light or
dark. (The modal window had fixed white text, unreadable on a light
theme.)

**Time format** (Settings → Time zones → Times) sets how the planner and
the Quick Settings button write times: **Same as the clock** (the default)
follows the island's own Clock format setting, and through it GNOME's when
that is "Follow system"; **24-hour** writes 14:05 and **12-hour** 2:05 PM.
The menu and the button update as soon as either setting changes.

The feature performs no network requests. The Quick Settings time display
follows GNOME's own wall clock and updates when the displayed minute or the
favourites change.

The island's two time zone readouts (`timezone-1`, `timezone-2`) show the
first and second favourite in light blue, with "+1" or "−1" when the
city's date is not the local one (`dayOffsetAt` in clock.js;
docs/features/readouts.md).
