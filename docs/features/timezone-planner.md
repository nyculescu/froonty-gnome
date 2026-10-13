# Feature: Time zone planner

Status: **working-tree only** (`make install`); not in the published package.

Settings → Time zones lets you save any number of cities by name and IANA
timezone ID, and mark up to two as favourites. Dublin and Timisoara are the
defaults. Removing a city also removes it from favourites.

The Quick Settings button shows the favourite cities' current local times
instead of a generic label. Click it to open a Shell modal window for
planning across Vancouver and those favourites. The slider covers the 24
hours around now; moving right advances the time in Vancouver and every
favourite city together. Times and dates are converted from the same real
instant through GLib's timezone database, so daylight-saving changes and
crossing midnight are handled correctly. The **Now** button recenters the
slider on the current time.

The feature performs no network requests. The Quick Settings time display
follows GNOME's own wall clock and updates when the displayed minute or the
favourites change.
