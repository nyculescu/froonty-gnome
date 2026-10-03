# Feature: Calendar

Status, in two steps:

- **A. GNOME's own calendar and notification menu, from the island:
  implemented** (Unreleased, 2026-10-02). The pill covers GNOME's clock;
  this step makes what the clock opens reachable again, and shows the
  clock's unread-notifications dot on the pill. Since 2026-10-03 a date
  pill in the hub header opens it (it replaced a 📅 icon button, and the
  Clock tab went).
- **B. A Calendar tab on Evolution Data Server: implemented**
  (Unreleased, 2026-10-02). The events of every calendar GNOME knows
  (Google, Microsoft 365, Nextcloud, iCloud, CalDAV, ICS), read-only,
  live, with links to the web calendars. Built to the design agreed on
  2026-09-28, with the revisions in §B.6. The countdown to the next event
  in the collapsed island is still for later, as its own step.

## A. GNOME's own calendar and notification menu (implemented)

### A.1 Goal

Froonty's pill sits on GNOME's top bar clock, which is transparent
underneath ([DESIGN.md §5](../DESIGN.md#5-reusing-gnomes-date--notification-menu)).
A click on the clock used to open GNOME's menu: the notification list (with
Do Not Disturb and Clear), the month calendar, events, world clocks and
weather. The pill takes that click, and it hid the clock's
unread-notifications dot. Step A gives both back **without reimplementing
either**: no calendar and no notification store of Froonty's own
(DESIGN.md §2, principle 1). (The later Notifications tab shows GNOME's
own list in the island, still with no store of its own:
[notifications.md](notifications.md).)

```
 collapsed:      ( 14:35 • )                    • = GNOME's unread dot
 expanded:  ┌────┬───────────────────────────────────────────┐
            │ 🗓 │   [🎤][🔊]   ( Sat Oct 3 14:35 • )  ⚙️ │  the date pill opens
            │ …  │   active tab                              │  GNOME's menu
            └────┴───────────────────────────────────────────┘
```

### A.2 What the user can do

1. **Open it with the pointer:** open the island, then click the **date
   pill** (the date and the time, left of ⚙️; its tooltip says "Calendar
   and notifications"). The island closes and GNOME's own menu opens under
   the pill, its arrow pointing at the clock, exactly as a click on the
   clock opened it.
2. **Open it with the keyboard:** in the open island, Tab to the date pill
   and press Enter or Space; or press GNOME's own shortcut, **Super+V**
   (also Super+M), at any time, also while the island is open. The
   keyboard focus moves into the menu.
3. **Use it:** it is GNOME's menu. Notifications keep their actions, Clear
   and the Do Not Disturb switch; the calendar, events, world clocks and
   weather work as before.
4. **Close it:** Escape, a click outside (also on the collapsed pill,
   where the clock is: as on GNOME's clock, the menu closes and nothing
   else opens), or Super+V again. The focus goes back to where it was
   before the island was opened.
5. **Unread notifications:** while GNOME's clock would show its dot, the
   collapsed pill shows the same dot after the time, and so does the date
   pill in the open island. Showing GNOME's list marks the notifications as seen,
   GNOME's own rule, and the dot goes. Do Not Disturb hides it, as on the
   clock.
6. **Banners:** a notification that arrives while the island is open waits
   until the island closes, then shows as usual. (Without this it would
   show underneath the open island and count as seen.)

### A.3 Decisions

- **A date pill in the hub header** (2026-10-03, at the user's request;
  it replaced a 📅 icon button, and the Clock tab went with it): it is
  one click from every tab, and it stands for the clock the island
  covers, which is what used to open the menu.
  - It shows the date as the top bar clock under the island writes it,
    "Sat Oct 3" (gnome-desktop's own translated format, so "Sat 3 Oct" in
    British English; weekday, month and day, where the collapsed pill
    has only "Sat 3"), and the time in Froonty's 12/24-hour setting
    ("Follow system" follows GNOME's): "Sat Oct 3 14:35". Always with the
    date: there is room in the header, and "Show date when collapsed" is
    the collapsed pill's. GNOME's unread dot follows the time, as on the
    collapsed pill. The figures are tabular, so the pill keeps its width
    from minute to minute; it changes a little when the hour gains a
    digit (12-hour), the day gains one, or the dot comes and goes, as
    GNOME's clock does.
  - It looks like the collapsed pill (black, a hairline border, fully
    rounded, the date dimmer than the bold time), as tall as the icon
    buttons beside it.
  - It sits left of ⚙️, and left of a tab's own buttons (Notes' All
    notes), so ⚙️ stays in the corner; Tab reaches it before ⚙️.
  - Its accessible name says what it opens and the full date: "Calendar
    and notifications, Saturday, October 3 2026, 14:35" (", unread
    notifications" while the dot shows); its tooltip says "Calendar and
    notifications".
  - It follows the clock service (the top bar's own WallClock ticks): no
    timer of its own, and its handler goes with the hub.
  - It is wider than 📅 was. At first the centred panic bar kept clear
    of it by widening the island (at least about 430 px with the two
    default panic buttons, about 498 px on the Notes tab), which made
    the narrow end of each tab's width setting do nothing. Now the panic
    bar moves left instead, just enough to keep 8 px clear of the
    header's buttons (`PanicLayout` in `ui/hub.js`), and the island
    grows only when the bar does not fit between the tab column and
    those buttons at all (`Hub.minWidth`; [notes.md](notes.md)). Every
    tab opens at its own width at the defaults.
  - A press (click, touch, Enter, Space) takes the menu's path below.
    Escape and a click outside close the menu as GNOME's own do.
- **Super+V is GNOME's own.** Froonty adds no shortcut: GNOME's
  `toggle-message-tray` binding calls `Main.panel.toggleCalendar()`, which
  works because the transparent clock stays mapped and reactive.
- **One at a time**, like GNOME's own top bar menus, which close each
  other:
  - GNOME's menu opening, by any means (the date pill, Super+V, a click
    on a clock left visible with "Hide panel clock" off), collapses the
    island;
  - the island opening (click, shortcut, hover, Ctrl+Alt+Tab) first closes
    GNOME's menu.
- **The date pill opens GNOME's menu first** and lets that collapse the
  island, the same path as Super+V. To the user it is "close Froonty, open
  GNOME's": the menu shows above the island, which shrinks back to the
  pill under it. (DESIGN.md §5 had planned the reverse: release the
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
  Observe only: step A marks nothing seen, and dismisses or destroys
  nothing. The Notifications tab's icon carries the same dot, by the same
  rule; that tab marks what it lists seen only on a deliberate act
  ([notifications.md](notifications.md) §3).
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
ui/hubHeader.js     the date pill: date, time, dot, name, tooltip
services/clock.js   snapshot(): date ("Sat Oct 3"), time, weekday,
                    longDate; 'changed' on the top bar clock's ticks
ui/collapsedView.js the dot after the time, balanced by a pad
```

### A.5 Resources and lifecycle

Created with the island, released in `Island.destroy()` (so on every
disable and screen lock): one handler on the date menu's
`open-state-changed`, two on its unread indicator (`notify::visible`,
`destroy`). The date pill: one handler on the clock service's `changed`,
removed when the hub is destroyed. No timers, no polling, nothing created
at module load. If the island holds banners when it is destroyed, it
releases them. When this Shell has no date menu, there is no date pill;
without the indicator, no dot.

### A.6 Tests

Headless (`testDatePill` and `testCalendarMenu` in
`tools/headless-test/checks.js`, both session modes):

- The date pill: its date and time as the clock service gives them, in
  24-hour, 12-hour and "Follow system" (GNOME's setting switched), with
  the date whatever "Show date when collapsed" says; a tick of the top
  bar clock updates it; its accessible name; as tall as ⚙️, rounded,
  text not cut; screenshots `hub-header-pill`, `hub-header-pill-12h`.
  None without a date menu (a header built without one: ⚙️ alone); one
  handler on the clock service while it exists, none after; with the
  island turned off, no handler left on the clock service at all.
- The date pill left of ⚙️, clear of the panic bar, its tooltip.
- A click opens GNOME's menu: raised above the island as it opens, the
  island collapsed (back to the pill's size, its hub hidden) and its grab
  released (one modal grab left, the menu's), the focus in the menu, the
  menu hanging below the clock and on top where it meets the island
  (picking finds the menu); the menu takes clicks (GNOME's calendar goes
  to the next month); Escape closes it, leaves no grab, and gives the key
  focus back to where it was before the island opened. With the menu
  open, a click on the pill (where the clock is) closes it, as on GNOME's
  clock, and the island stays closed.
- Keyboard: Tab to the date pill, Enter; Space; Super+V over the open
  island; the island's shortcut over the open menu; hover-open not taking
  over from the open menu.
- The dot: none without unseen notifications; a test source's LOW
  notification shows it on the pill (and in its name) and after the date
  pill's time (and in its name); the pill
  still covers the widened clock; time and date are not ellipsized; Do Not
  Disturb hides it and it comes back (default mode only: in Ubuntu mode,
  ending Do Not Disturb makes Ubuntu Dock log TypeErrors of its own);
  showing GNOME's list clears it (on the date pill and in its name too)
  while the notification stays.
- Banners: the island is stacked above the message tray (the reason to
  hold them); one arriving while open waits (not shown, not seen), and
  shows once the island collapses.
- Disable while open: banners released, the date menu's handlers dropped;
  enable connects them again, once.

No unit tests: this step has no Shell-free logic.

### A.7 Risks

- `dateMenu._indicator` is private. Renamed or gone: no dot, and no error.
- Another extension hiding the clock (unmapped): `toggleCalendar()` does
  nothing, so the date pill does nothing and the island stays open.
- Another extension moving the clock to a side box: GNOME then shows
  banners on that side; the island no longer holds them, as it no longer
  covers them.

## B. Calendar tab on Evolution Data Server (implemented)

### B.1 Goal

The user asked (2026-10-02): *"For the calendar tab, is it possible to
show the event too if connected to calendars like Apple calendar, google,
outlook, etc.?"* The hub has a Calendar tab, its first tab (since the
Clock tab went, 2026-10-03):

- **Left:** a month grid, as GNOME's own (six weeks, GNOME's first
  weekday, optional ISO week numbers), with up to three dots per day in
  the colours of the calendars with events that day.
- **Right:** a **Day / Week / Month** switch, then the events of the
  selected day, its week or its month, as cards.
- **Aggregation:** events come from every calendar GNOME knows (Google,
  Microsoft 365, Nextcloud, iCloud and any CalDAV or ICS calendar), live.
- **Links:** clicking an event opens its day in the web calendar it came
  from; a row of buttons (Google, Outlook, iCloud, …) opens each one on
  the selected day.
- **Read-only:** Froonty never creates, changes or removes an event or a
  calendar.

The computer's notifications are a separate tab (user, 2026-10-02: "The
PC events or notifications will appear separately from the Calendar, in
a Notifications tab"), built on its own.

```
┌ month grid ───────────────┐ │ [Day][Week][Month]
│ ‹      October        ›   │ │ 28 Sep – 4 Oct · Week 40
│ wk M  T  W  T  F  S  S    │ │ Today · Fri 2 Oct
│ 40 28 29 30  1 (2) 3  4   │ │ ▌Standup                       [Now]
│ 41  5  6 …     •• •       │ │ ▌09:00 – 09:15 · Work (Google) · Rm 1
│ [Google ↗] [⚙]            │ │ Unavailable: Team (Google)  (if any)
└───────────────────────────┘
```

### B.2 Data source: GNOME's Evolution Data Server

Froonty does **not** aggregate calendars itself; GNOME already does:

| Provider | How it reaches EDS | Package needed |
|---|---|---|
| Google | Settings → Online Accounts → Google | none |
| Outlook / Microsoft 365 | Settings → Online Accounts → Microsoft 365 (or Microsoft Exchange) | `evolution-ews-core` (the EDS backends only; `evolution-ews` also pulls in the Evolution mail client) |
| Apple iCloud | GNOME Calendar or Evolution → add a CalDAV calendar (`caldav.icloud.com`, app-specific password). Online Accounts' "Calendar, Contacts and Files" (WebDAV) may also do, where Settings offers it: not verified, and not in the providers listed on the development machine | `gnome-calendar` (or Evolution), only for setup |
| Nextcloud | Settings → Online Accounts → Nextcloud | none |
| Any ICS / CalDAV | GNOME Calendar → "Add calendar from URL" | none |

Froonty reads EDS through its GObject-introspection bindings: ECal 2.0,
EDataServer 1.2, ICalGLib 3.0. **Runtime dependency:** `gir1.2-ecal-2.0`
on Debian and Ubuntu (it pulls in the others; Fedora and Arch ship the
typelibs with evolution-data-server). Without it the tab says what to
install, and nothing else fails.

Why not the Shell's own calendar server (`org.gnome.Shell.CalendarServer`)?
It has **one** global time range (`SetTimeRange`), which Froonty would
take away from the top bar's calendar, and its events carry only an id,
a title and times (`a(ssxxa{sv})`): no calendar, colour or location.

### B.3 Structure

```
features/calendar/
├── index.js     descriptor; the one-time probe (setup); Shell-only deps
├── eds.js       the ONLY module touching ECal/EDataServer/ICalGLib/
│                GIRepository, imported at run time: probe, registry and
│                watcher, clients and their zones, live views, libecal's
│                expansion in slices
├── scheduler.js one idle for every view's expansion, a few ms per turn
├── service.js   CalendarService: state, selection, month, views per
│                visible calendar, 'changed' (no St, no Shell imports)
├── model.js     pure: events by calendar, moved occurrences, days,
│                Now/Next, dots, card cap
├── range.js     pure: dates, grid and spans, DST-safe, ISO weeks
├── providers.js pure: which web calendar, its day and home pages
├── color.js     pure: calendar colours parsed, only hex reaches CSS
├── view.js      CalendarView: the two columns, or a hint
├── monthGrid.js MonthGrid (St.BoxLayout subclass)
├── agenda.js    Agenda (St.BoxLayout subclass): day groups and cards
├── icon.js      the tab's bundled icon (icons/hicolor/…/froonty-calendar-symbolic.svg)
└── prefs.js     the Calendar settings page
```

Also: `ui/island.js` gives features `ctx.collapse()` (a browser or
Settings opened from a tab can take the focus), and `services/clock.js`
exposes the top bar clock's `timeZone`.

### B.4 Behaviour

- **Which calendars:** the ones GNOME's own calendar shows, picked the
  same way as `gnome-shell-calendar-server` does: enabled (with their
  account enabled) and ticked in GNOME Calendar or Evolution
  (`ESourceSelectable` `selected`), through
  `EDataServer.SourceRegistryWatcher`. Settings → Calendar can hide any
  of them in the tab (`calendar-hidden-sources`). Unticking a calendar
  in GNOME Calendar, removing it or its account takes it out at once;
  a new account's calendars come in while the tab is shown.
- **Granularity:** Day, Week (default) or Month around the selected day;
  remembered (`calendar-granularity`). The grid shades the span: a cell,
  a row, or the whole month.
- **Each visit starts on today**, as GNOME's date menu does, and the
  agenda scrolls so the selected day is at the top (earlier days of the
  week sit above). A live change keeps the scroll position.
- **Navigation:** ‹ and › (or the wheel over the grid) change the month,
  keeping the day as GNOME does; the month's name goes back to today; a
  day of the neighbouring month shows that month.
- **Week start and week numbers** follow GNOME's own settings
  (`org.gnome.desktop.calendar` `week-start-day`, else the locale, and
  `show-weekdate`), read, never written. Weekday letters, month names
  and days off come from GNOME Shell's own translations (its
  `grid monday` … msgids, `%OB`, `calendar-no-work`).
- **Recurring events** are expanded by EDS's library (libecal: RRULE,
  RDATE, EXDATE, durations); a moved or changed occurrence replaces the
  one its series would have. At most 1000 occurrences per event and
  range (a minutely event stops there). A large calendar never stalls a
  frame: the expansion runs a few milliseconds per main-loop turn, and a
  series begun years ago is not walked from its start (B.6, "Expansion
  off the frame path").
- **Time zones:** the clock's zone for floating times; a zone EDS knows
  but libical does not (Exchange's "Pacific Standard Time") is asked of
  the calendar once, shared by all its views, and every event that used
  it is expanded again, also the ones delivered while the answer was on
  its way. A request that fails is made again the next time an event
  needs the zone; only the calendar's own "not found" is remembered
  (floating times then).
- **Event card:** calendar-coloured bar and 10% fill; title (empty:
  "Untitled event"); time ("09:00 – 09:15", "All day", "09:00 – Sat
  02:00" on its first day, "Until 02:00" on its last); calendar name,
  with "(Google)" etc. for a web calendar; location. "Now" on an event
  going on, "Next" on the one timed event starting soonest after now,
  wherever it is: a span in the future has none unless it holds that
  event, and a month whose six weeks do not include today has none
  (Froonty does not know what comes before it). Past events dimmed;
  cancelled ones struck through and dimmed (never Now or Next). At most 200 cards per span ("and N more: pick a
  day"). Event text is always plain text, never markup.
- **Grid day:** today in the accent colour; the selected day ringed;
  other months' days and days off dimmed; up to three dots in calendar
  order; its name says how many events.
- **Hints instead of the two columns:** the bindings are missing
  ("Install gir1.2-ecal-2.0 …", with Online Accounts); they could not be
  loaded; EDS did not answer (tried again on the next visit); no
  calendar to show. "Loading…" in the agenda until the first calendar
  has delivered its events. A calendar that cannot be read is named
  under the agenda ("Unavailable: …"); the others still show.
- **Live:** EDS views notify additions, changes and removals; the tab
  redraws at most once per main-loop turn, and at most every 200 ms
  while a calendar is still delivering its first events (a large one
  arrives over many short expansion turns; its completion redraws at
  once). No polling; the minute ticks
  of the top bar's clock move Now, Next and past. While the tab is not
  on screen the views stay and only keep what EDS sends (an event
  changed many times waits once); it is expanded on the next visit.
- **Navigation cost:** another month replaces the views at once; the
  months a fast wheel or ›-clicking passes through within 250 ms of each
  other get none, only the one shown when it stops ("Loading…"
  meanwhile).

### B.5 Links

Per event: its **day** in the web calendar it came from; the provider
row: each web calendar on the selected day. Detection from what EDS
knows of the calendar (`providers.js`, unit-tested): the collection
backend GNOME Online Accounts set up (google, microsoft365, ews, outlook,
webdav) and the host of its CalDAV or ICS address. Hosts match exactly
or as a dot-suffix, so look-alikes are not attributed.

| Kind | Detected by | Opens |
|---|---|---|
| Google | collection `google`; host `apidata.googleusercontent.com`, `www.google.com` + `/calendar/dav`, `calendar.google.com` (ICS) | `https://calendar.google.com/calendar/r/day/Y/M/D`, plus `?authuser=<address>` when the account is known |
| Outlook | collection `microsoft365`, `ews` or `outlook`; host `outlook.office365.com`, `outlook.office.com`, `outlook.live.com` | `https://outlook.office.com/calendar/view/day/Y/M/D`; `https://outlook.live.com/calendar/0/view/day/Y/M/D` for outlook.com, hotmail, live and msn addresses |
| iCloud | host `icloud.com` or a subdomain (`caldav.icloud.com`, `p57-caldav.icloud.com`) | `https://www.icloud.com/calendar/` (no day page known) |
| Nextcloud | collection `webdav` with `/remote.php/dav/` in the path | `<server><prefix>/apps/calendar/` |
| Yahoo | host `caldav.calendar.yahoo.com` | `https://calendar.yahoo.com/` |
| none | Personal, Birthdays, Weather, any other host | the card is not a button |

None of these addresses is a documented API; **none was verified**
against a live account (there is none on the development machine). A
click closes the island first, so the browser takes the focus.

### B.6 Decisions and revisions to the design

Answered 2026-09-28: all of GNOME's calendars, with a per-calendar
opt-out in Settings; week start from the locale; the countdown in the
collapsed island later, as its own step. Revised while building, each
for a verified reason:

- **R1. Week start follows GNOME's setting**, not a Froonty one:
  GNOME Shell 50's `ui/calendar.js` reads `org.gnome.desktop.calendar`
  `week-start-day` (0 = the locale's, `Shell.util_get_week_start()`).
  Froonty does the same, and follows `show-weekdate` with ISO week
  numbers, as GNOME's grid does.
- **R2. Recurrences are expanded with libecal's
  `e_cal_recur_generate_instances_sync`**, with a time zone resolver that
  does no I/O, a few milliseconds per main-loop turn (next item).
  `ECal.Client.generate_instances*` return nothing and give JavaScript no
  signal when they are done (verified). Froonty drops the series'
  occurrence that a moved one replaces (matched by recurrence time).
- **Expansion off the frame path** (revised after review, 2026-10-02).
  Measured with libecal 3.56.2 on the development machine: libecal walks
  a series from its first occurrence to the end of the range asked for,
  and makes every occurrence of the range before it hands back the first
  (so the 1000 cap does not shorten the work). One daily series begun in
  2016 cost 15–35 ms over the grid's six weeks; 50 of them, the old 50
  events per turn, 440 ms in one turn; a minutely series begun the day
  before, 3–4 s. Now:
  - **One idle for every view** (`scheduler.js`), at the default idle
    priority; each turn stops after 3 ms of work. A step expected to be
    long (a series expanded in one call whose walk is estimated above
    200 occurrences) runs alone in its turn.
  - **Slices with a moved start.** A series repeating at most weekly
    with one RRULE (a COUNT only without BY parts), no EXRULE and no
    RDATE period is expanded in slices of the range of about 50
    occurrences each. Before each slice, a copy of the series gets a
    DTSTART (and DTEND) a whole number of INTERVALs later, just before
    the slice (a COUNT that many smaller): the same occurrences from there
    on, as libecal counts days and weeks in wall-clock time and seconds,
    minutes and hours in elapsed time (verified). An occurrence belongs to
    the slice it starts in; the first slice also takes what started before
    the range and lasts into it. Each libecal call then makes about 50
    occurrences (up to about 1.5 ms measured).
  - **One libical quirk** (libical 3.0 / libecal 3.56.2, verified): an
    occurrence of a seconds, minutes or hours series that falls in the
    hour a daylight saving change repeats is read as the second one, and
    the rest of the series follows an hour later. A period dividing an
    hour lands on the same times anyway, and a UTC series has no such
    change; any other one (every 2 hours, every 7 minutes, in a zone with
    daylight saving) is walked to each slice with libical's own iterator,
    128 occurrences per step, so it matches what GNOME's calendar shows.
  - Monthly and yearly series, several RRULEs, an EXRULE, a counted rule
    with BY parts or an RDATE period are expanded in one call, as before.
  - Checked against libecal's own one-call expansion for 24 kinds of
    series (unit tests; daylight saving changes, all-day, multi-day,
    floating, EXDATE, RDATE, COUNT, UNTIL, a DTSTART that is not an
    occurrence, the 1000 cap).
- **Moved occurrences are asked for.** An EDS view delivers a repeating
  event's master but not its moved occurrences (verified with EDS
  3.56.2's local calendars: a new view never sent one that existed
  before it started; a running view got one only as it was made, about
  2 s later). For each repeating event, Froonty asks the calendar for all
  of that event's objects with the asynchronous `get_objects_for_uid`
  (what libecal's `generate_instances_for_object` does synchronously,
  and GNOME's calendar server with it), one event at a time, and holds
  the view's 'complete' until the answers are in.
- **R3. Which calendars:** GNOME Shell's calendar server's rule
  (B.4), plus Froonty's opt-out.
- **R4. The tab's icon is bundled:** `x-office-calendar-symbolic` stood
  for GNOME's own menu (step A's 📅, now the date pill) and Adwaita has
  no other calendar icon (the others are Yaru-only).
- **ECal views start synchronously, and are never stopped.**
  `ECal.ClientView.start()` and `stop()` are synchronous D-Bus calls to
  evolution-calendar-factory (verified in libecal 3.56.2's machine code:
  `e_cal_client_view_start` calls `e_dbus_calendar_view_call_start_sync`;
  `stop` and `set_flags` likewise). Measured on the development machine
  against a private EDS with local calendars: about 0.3 ms per start and
  0.9 ms per stop (medians; at most 1.2 ms). Revised after review
  (2026-10-02): the views used to be started on every island open and
  stopped on every close and month change; now
  - a view lives from the first time the tab shows its month until
    another month or zone, a calendar hidden or gone, or disable; while
    the tab is not on screen it is paused (B.4), so closing and
    reopening the island makes no EDS call;
  - a view Froonty is done with is let go without `stop()`: libecal's
    dispose then tells the factory with the asynchronous
    `e_dbus_calendar_view_call_dispose`, once the garbage collector
    releases it (libecal 3.56.2's machine code calls only that
    asynchronous variant, from the view code; checked with objdump).
    Until then the factory keeps the view and its notifications reach
    nobody;
  - `set_flags()` is skipped: a new view already delivers its initial
    events (verified).
  So `start()` remains, once per visible calendar and month shown, and
  the months a fast wheel passes through get no views (B.4). Driving
  EDS's private view protocol asynchronously instead was tried: the
  factory accepts an asynchronous `Start`, but `ECalClientView` then
  ignores the notifications, so it would mean reimplementing libecal's
  wire protocol. Risk: a hung calendar factory would block the Shell
  for up to D-Bus's 25 s timeout per `start()`.
- **Connecting without waiting:** `ECal.Client.connect()` gets
  `(guint32) -1`, EDS's "do not wait for the backend to be online"
  (GJS rejects a plain `-1` for that unsigned argument, verified). A
  remote calendar opens with what EDS has cached; the meaning is from
  EDS's documentation and was not checked against a remote account.
- **Scrolling to the selected day** puts its heading at the top, after
  layout. Not `ensureActorVisibleInScrollView()`: it scrolls as little as
  possible, which leaves a heading below the fold at the bottom edge and
  shows the past days instead.
- **"Loading…"** lasts until a calendar has delivered its events (the
  previous visit's events show meanwhile), with no 1 s timer: a timer
  would say "No events" while they are still loading.
- **Layout:** the left column is 216 px (a 20 px week column and seven
  28 px days); the buttons under the grid go two to a row rather than
  being cut; the selected span is one shaded band.
- **Off-by-default?** No: **on by default.** It is read-only, shows what
  GNOME's own date menu shows, costs nothing until it is opened (no
  library loaded, no EDS connection before the tab is first shown), and
  is turned off once, on the first start, when `gir1.2-ecal-2.0` is
  missing (as the ZeroTier tab is without ZeroTier), so nobody gets a
  tab that can only say "install". Installed later: Settings → Calendar.
  Reconsidered after the review found that a large calendar could stall
  the Shell (Fedora and Arch always ship the bindings): with the
  expansion budgeted per turn and the views kept across visits, 50
  long-running series plus a minutely, an hourly and a 30-minute one
  measured about 4 ms per main-loop turn at most (unit test), so it
  stays on.

### B.7 Resources and lifecycle

- **Module load:** nothing. **enable():** only the one-time probe
  (GIRepository's typelib list; no library loaded).
- **The service** is created when the tab is first selected (or at
  enable when it was the last tab): settings handlers only (2 Froonty
  keys, 2 `org.gnome.desktop.calendar` keys). EDS is loaded the first
  time the tab comes on screen; while missing or failed, each visit
  probes again, so installing the package works without logging out (a
  failed import is never attempted, since GJS would remember it).
- **Once the tab has been shown, until disable:** 1 `ESourceRegistry`,
  1 `SourceRegistryWatcher` (3 handlers), 1 registry `source-changed`
  handler, 1 `ECal.Client` per visible calendar (1 `backend-died`
  handler each). The EDS processes are GNOME's (its own calendar server
  already uses them).
- **From the first time the tab shows a month until another month or
  zone, or disable:** 1 EDS view per visible calendar (4 handlers each),
  paused while the tab is not on screen (what EDS sends is kept,
  unexpanded, once per event); its one synchronous `start()` (B.6), and
  no `stop()`. One asynchronous `get_objects_for_uid` per repeating
  event delivered or changed (one at a time per view), and one
  `get_timezone` per calendar and zone libical does not know.
- **Timers:** none periodic. At most one idle to coalesce 'changed'
  (only while on screen), one idle for every view's expansion while
  there is work and the tab is on screen (removed when it goes), a
  one-shot 250 ms timeout after a month change (the quiet period, B.4),
  and while a calendar loads, the redraw as a one-shot timeout of at
  most 200 ms instead of an idle; all removed on disable. The view follows the top bar clock's minute
  ticks through `ClockService` (one handler).
- **Memory:** libecal, libedataserver, libical(-glib) and libcamel are
  mapped into the Shell the first time the tab opens and stay (a few MB;
  not measured).
- **disable()** (also every screen lock): the hub destroys the view,
  then `service.stop()` cancels what is in flight (late answers are
  dropped and late views let go), lets go of every view without a
  D-Bus call, disconnects every handler, removes the idles and the
  quiet timer, and lets go of the registry and clients (EDS objects are
  never disposed by hand; the garbage collector frees them, and nothing
  of Froonty's runs meanwhile).
- **Settings window:** the Calendars list's registry, adapter and
  settings handlers are released when the window closes
  (`close-request`; GTK 4 emits no `destroy` on its pages, verified
  with a headless GNOME Shell and GTK 4 / libadwaita).

### B.8 Tests

Unit (`tools/unit/calendar.test.js`, plain gjs, a fake EDS, no D-Bus):
grid and spans (week starts, GNOME's padding, DST days, ISO weeks, days
off), provider detection and links (look-alike hosts, integer dates
only), colour parsing, the model (multi-day, all-day, midnight, moved
occurrences in either order, removals, two calendars, dots, Now/Next,
the card cap), the service (lazy loading, the missing-bindings hint and
re-probe, one view per calendar and range, late opens stopped, one
'changed' per turn, calendars appearing and disappearing, hiding,
another month, the snapshot kept until 'complete', unavailable
calendars, a time zone change, nothing left after stop; views kept and
paused across island closes with no EDS call; the wheel's quiet period;
redraws at most every 200 ms while a calendar loads;
"Next" only when nothing before it can be missing), and static checks
over the sources: no write call, no synchronous call but the expansion
and one `ClientView.start()` (no `stop()`, `set_flags()` or
`run_dispose()`), no static import of the bindings, the settings'
clean-up on the window's `close-request`.

Unit, `tools/unit/calendar-eds.test.js`: the scheduler (budget, a long
step alone, pause, changes during a turn, stop), and `EdsView` over the
**real libecal and libical** with a fake calendar (skipped without
`gir1.2-ecal-2.0`): 24 kinds of series give libecal's own one-call
occurrences; 50 daily or weekday series begun 2016–2023 plus a minutely,
an hourly and a 30-minute one keep every turn under 16 ms (about 4 ms
measured); 160 events in an unknown zone with a 20 ms answer all end up
right with one request; a view let go mid-request leaves the answer to
the next; a failed request is made again, "not found" is remembered;
`release()` makes no D-Bus call; an event changed 100 times while paused
waits once.

Headless (`testCalendar` in `tools/headless-test/checks.js`, both session
modes) over the **real EDS** of the test session, after checking that it
is private (its registry and calendar factory run with the test's XDG
dirs, on its bus) and that the real home's calendars do not mention the
test, before and after: the hint without the bindings; on by default,
the first tab; the built-in calendars; test calendars and events written
by the test (all-day, now, next, a daily series with an excluded and a
moved occurrence, a cancelled event in a Windows-named zone): colours,
"All day", the series as EDS expands it, Now and Next, the zone fetched
from the calendar, text never markup, today's dots, week numbers with
GNOME's setting, the layout and a screenshot; live addition, rename and
removal, removal of the moved occurrence, a second calendar, hidden in
Froonty, unticked in GNOME; navigation, Day/Week/Month shading, another
month's day, Tab and Enter; EDS's files unchanged by Froonty's browsing;
links (a fake Google calendar; nothing is launched); collapsed: the same
EDS views kept, running and paused, an event added then waiting
unexpanded and nothing woken, then shown on reopening from the same
views; another month: new views, the old ones let go with their
ClientViews still running (no `stop()`); the hint in the hub. Then
`testCalendarLoad`: a third test calendar with 50 daily or weekday
series begun 2016–2023, a minutely and an hourly series and 120 events
in "Pacific Standard Time": every expansion turn under 16 ms (the main
loop's longest stall, the number of redraws and the longest one as a
note), at most 5 redraws a second while it loads, every series'
occurrence count,
the minutely one from its first minute, all 120 at 14:00 Pacific, the
zone fetched once. Last, disable while loading, 5 times, leaving
nothing (no view, connection, registry, idle or quiet timer). The tab
is then left as the last one, so the lifecycle checks' 25
enable/disable cycles run with it.

### B.9 Risks and what is not verified

- **No real account:** the collection backend names, the CalDAV hosts
  and paths of real Google, iCloud and Nextcloud calendars, and every
  web address (B.5) come from EDS's own strings and the providers' public
  pages, not from live accounts. Offline and expired-password behaviour,
  and many calendars or thousands of events, were not tried.
- **Microsoft 365 / Exchange** calendars exist only with EDS's EWS and
  Microsoft 365 backends installed (EDS logs "No suitable backend found"
  without them); Settings says so. On Debian and Ubuntu they are
  `evolution-ews-core` (its 3.56.2 package ships
  `libecalbackendmicrosoft365.so` and `libecalbackendews.so`, checked in
  the .deb's file list); `evolution-ews` adds the Evolution client.
- **Synchronous view start** (B.6), once per calendar and month shown.
- **Views let go, not stopped:** the factory keeps a view until the
  garbage collector releases Froonty's last reference (B.6).
- **What is still expanded in one call** (monthly and yearly series,
  several RRULEs, an EXRULE, a counted rule with BY parts, an RDATE
  period) costs what libecal's walk from the series' start costs; it runs
  alone in its turn, but a pathological one (a counted minutely rule with
  BY parts and a huge COUNT) can still stall a frame. A seconds, minutes
  or hours series in a zone with daylight saving whose period does not
  divide an hour is walked from its start in the background: cheap for a
  recent one, seconds of background work for an every-7-minutes series
  begun years ago (not seen in Google or Outlook, which offer no such
  rule).
- **Not tried in a real (non-headless) session**; the headless runs load
  the bindings inside GNOME Shell 50.1.
- Remote events are as fresh as EDS keeps them; its refresh interval is
  EDS's, not Froonty's.

### B.10 Trying it for real

1. With `gir1.2-ecal-2.0` installed (`sudo apt install gir1.2-ecal-2.0`,
   then reopen the tab), open the Calendar tab: "Personal" and
   "Birthdays & Anniversaries" appear in Settings → Calendar.
2. Google: Settings → Online Accounts → Google, Calendar on. Click an
   event: Google Calendar should open on that day, in that account.
3. Microsoft 365 or Exchange: `sudo apt install evolution-ews-core`
   (EDS's backends only; `evolution-ews` would also install the
   Evolution mail client), log out and in, then Online Accounts →
   Microsoft 365 (or Microsoft Exchange). Check the day link
   (outlook.office.com, or outlook.live.com for an outlook.com address).
4. iCloud: GNOME Calendar is not installed on the development machine:
   `sudo apt install gnome-calendar` (or Evolution) first. Then an
   app-specific password from appleid.apple.com, and GNOME Calendar →
   add a CalDAV calendar at `caldav.icloud.com`.
5. Check a repeating event, an all-day event, and a calendar unticked in
   GNOME Calendar (installed in step 4): it should leave the tab.
