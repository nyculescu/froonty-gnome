# Feature: Calendar

Status, in two steps:

- **A. GNOME's own calendar and notification menu, from the island:
  implemented** (Unreleased, 2026-10-02). The pill covers GNOME's clock;
  this step makes what the clock opens reachable again, and shows the
  clock's unread-notifications dot on the pill.
- **B. A Calendar tab on Evolution Data Server: design**, next after
  Notes. Answered 2026-09-28: all calendars enabled in GNOME are shown,
  with a per-calendar opt-out in the Calendar settings tab (for now); the
  week start follows the locale; the countdown to the next event in the
  collapsed island comes later, as a separate step. No questions are open;
  waiting for `gir1.2-ecal-2.0` and the accounts. Unchanged by step A.

## A. GNOME's own calendar and notification menu (implemented)

### A.1 Goal

Froonty's pill sits on GNOME's top bar clock, which is transparent
underneath ([DESIGN.md §5](../DESIGN.md#5-reusing-gnomes-date--notification-menu)).
A click on the clock used to open GNOME's menu: the notification list (with
Do Not Disturb and Clear), the month calendar, events, world clocks and
weather. The pill takes that click, and it hid the clock's
unread-notifications dot. Step A gives both back **without reimplementing
either**: no calendar, no notification list, no notification store of
Froonty's own (DESIGN.md §2, principle 1).

```
 collapsed:      ( 14:35 • )            • = GNOME's unread dot
 expanded:  ┌────┬─────────────────────────────┐
            │ 🕒 │      [🎤][🔊]        📅• ⚙️ │  📅 opens GNOME's menu
            │ …  │   active tab                │
            └────┴─────────────────────────────┘
```

### A.2 What the user can do

1. **Open it with the pointer:** open the island, then click **📅** (left
   of ⚙️; its tooltip says "Calendar and notifications"). The island
   closes and GNOME's own menu opens under the pill, its arrow pointing at
   the clock, exactly as a click on the clock opened it.
2. **Open it with the keyboard:** in the open island, Tab to 📅 and press
   Enter; or press GNOME's own shortcut, **Super+V** (also Super+M), at
   any time, also while the island is open. The keyboard focus moves into
   the menu.
3. **Use it:** it is GNOME's menu. Notifications keep their actions, Clear
   and the Do Not Disturb switch; the calendar, events, world clocks and
   weather work as before.
4. **Close it:** Escape, a click outside, or Super+V again. The focus goes
   back to where it was before the island was opened.
5. **Unread notifications:** while GNOME's clock would show its dot, the
   collapsed pill shows the same dot after the time, and 📅 carries it in
   the open island. Showing GNOME's list marks the notifications as seen,
   GNOME's own rule, and the dot goes. Do Not Disturb hides it, as on the
   clock.
6. **Banners:** a notification that arrives while the island is open waits
   until the island closes, then shows as usual. (Without this it would
   show underneath the open island and count as seen.)

### A.3 Decisions

- **📅 in the hub header**, not only in the Clock tab: it is one click
  from every tab, and notifications have nothing to do with the clock tab.
  It sits left of ⚙️, so ⚙️ stays in the corner; Tab reaches it before ⚙️.
  Icon: `x-office-calendar-symbolic` (in Adwaita and Yaru; also the
  island's Ctrl+Alt+Tab icon).
- **Super+V is GNOME's own.** Froonty adds no shortcut: GNOME's
  `toggle-message-tray` binding calls `Main.panel.toggleCalendar()`, which
  works because the transparent clock stays mapped and reactive.
- **One at a time**, like GNOME's own top bar menus, which close each
  other:
  - GNOME's menu opening, by any means (📅, Super+V, a click on a clock
    left visible with "Hide panel clock" off), collapses the island;
  - the island opening (click, shortcut, hover, Ctrl+Alt+Tab) first closes
    GNOME's menu.
- **📅 opens GNOME's menu first** and lets that collapse the island, the
  same path as Super+V. (DESIGN.md §5 had planned the reverse: release the
  island's grab, then open.) One code path for both; should the menu not
  open (another extension hid the clock), the island simply stays open;
  and banners are never released for an instant between the two. The
  island's grab is then released from under the menu's:
  `Main.popModal()` supports that and passes the focus to restore on to
  the menu's record, which is why Escape returns the focus to where it was
  before the island opened.
- **Above the island.** GNOME's menu is anchored to the clock under the
  pill (`BoxPointer.setPosition(sourceActor)`) and raises itself to the top
  of `uiGroup` when it opens (`PopupMenu.open()`), above the island's
  strip. No re-anchoring, no private menu internals.
- **The dot is GNOME's.** Froonty follows the `visible` property of the
  clock's own `MessagesIndicator`, which already applies GNOME's rules:
  notifications not yet seen, minus those waiting for their banner, and
  none under Do Not Disturb. Counting sources itself would duplicate them.
  Observe only: nothing is marked seen, dismissed or destroyed by
  Froonty.
- **The dot's look:** a 6 px white dot after the time, like the clock's.
  As GNOME's clock does, an invisible pad of the same size on the other
  side keeps the time centered. The pill's accessible name gains
  ", unread notifications". The clock grows by its dot, and the pill,
  which covers it, grows with it when the clock is the wider of the two.
- **Banners wait while the island is open.** GNOME shows banners at top
  center, under the clock (the message tray's `bannerAlignment` follows
  the clock), which is where the open island is. The island is chrome
  added after the message tray, so it is drawn above it: a banner would
  show underneath, and GNOME marks a notification as seen once its banner
  shows. GNOME's panel holds banners back while a menu is open in their
  place (`Panel._onMenuSet` sets `MessageTray.bannerBlocked`); the island
  does the same while open, only when banners are centered:
  `bannerBlocked = expanded || date menu open`, so it never releases them
  under GNOME's open menu. A held banner waits in GNOME's queue, is not
  counted as unseen (GNOME's rule for queued ones), and shows when the
  island closes. Urgency and policy stay GNOME's: a held critical banner
  waits too, exactly as under GNOME's own open menu.

### A.4 Structure

```
shell/dateMenu.js   CalendarMenu: open()/close() (Panel.toggleCalendar,
                    closeCalendar), isOpen, 'opened'; hasUnread,
                    'unread-changed' (the clock's MessagesIndicator);
                    holdBanners() (MessageTray.bannerBlocked)
ui/island.js        one at a time; holds banners while expanded
ui/hub.js           📅 with its tooltip and dot
ui/collapsedView.js the dot after the time, balanced by a pad
```

### A.5 Resources and lifecycle

Created with the island, released in `Island.destroy()` (so on every
disable and screen lock): one handler on the date menu's
`open-state-changed`, two on its unread indicator (`notify::visible`,
`destroy`). No timers, no polling, nothing created at module load. If the
island holds banners when it is destroyed, it releases them. When this
Shell has no date menu, there is no 📅; without the indicator, no dot.

### A.6 Tests

Headless (`testCalendarMenu` in `tools/headless-test/checks.js`, both
session modes):

- 📅 left of ⚙️, clear of the panic bar, named in its tooltip.
- A click opens GNOME's menu: raised above the island as it opens, the
  island collapsed and its grab released (one modal grab left, the
  menu's), the focus in the menu, the menu hanging below the clock and
  on top where it meets the island (picking finds the menu); the menu
  takes clicks (GNOME's calendar goes to the next month); Escape closes
  it and leaves no grab.
- Keyboard: Tab to 📅, Enter; Super+V over the open island; the island's
  shortcut over the open menu; hover-open not taking over from the open
  menu.
- The dot: none without unseen notifications; a test source's LOW
  notification shows it on the pill (and in its name) and on 📅; the pill
  still covers the widened clock; time and date are not ellipsized; Do Not
  Disturb hides it and it comes back (default mode only: in Ubuntu mode,
  ending Do Not Disturb makes Ubuntu Dock log TypeErrors of its own);
  showing GNOME's list clears it while the notification stays.
- Banners: the island is stacked above the message tray (the reason to
  hold them); one arriving while open waits (not shown, not seen), and
  shows once the island collapses.
- Disable while open: banners released, the date menu's handlers dropped;
  enable connects them again, once.

No unit tests: this step has no Shell-free logic.

### A.7 Risks

- `dateMenu._indicator` is private. Renamed or gone: no dot, and no error.
- Another extension hiding the clock (unmapped): `toggleCalendar()` does
  nothing, so 📅 does nothing and the island stays open.
- Another extension moving the clock to a side box: GNOME then shows
  banners on that side; the island no longer holds them, as it no longer
  covers them.

## B. Calendar tab on Evolution Data Server (design)

### B.1 Goal

The hub gets a Calendar tab:

- **Left:** a month grid with a **Day / Week / Month** switch.
- **Right:** the events in the selected day, week or month.
- **Aggregation:** events come from all of the user's calendars (Google,
  Outlook, Apple iCloud, and anything else GNOME knows).
- **Links:** clicking an event opens its day in the web calendar it came
  from. A row of Google / Outlook / iCloud buttons opens each web calendar.

### B.2 Data source (agreed): GNOME's Evolution Data Server

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

### B.3 Structure

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

### B.4 Behaviour

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

### B.5 Links

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

### B.6 Open questions

1. **Week start:** follow the locale (default), or a setting?
2. **Collapsed island:** should it show a countdown to the next event
   (e.g. "Standup in 12 min"), as vorssaint-utils does? I suggest adding
   it later, as a separate step.
3. **Which calendars:** all enabled GNOME calendars by default, with
   per-calendar opt-out in the Calendar settings tab. Is that right?
