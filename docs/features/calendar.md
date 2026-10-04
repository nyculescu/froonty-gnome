# Feature: Calendar (GNOME's own calendar and notification menu)

Status:

- **A. GNOME's own calendar and notification menu, from the island:
  implemented** (Unreleased, 2026-10-02). The pill covers GNOME's clock;
  this step makes what the clock opens reachable again, and shows the
  clock's unread-notifications dot on the pill. Since 2026-10-03 a date
  pill in the hub header opens it (it replaced a 📅 icon button, and the
  Clock tab went).
- **B. A Calendar tab on Evolution Data Server: removed** (after
  0.5.0-rc0). It showed the events of every calendar GNOME knows,
  read-only. GNOME's own menu, which the date pill opens, already shows
  them (and the notifications, which a Notifications tab also listed), so
  both tabs were duplicates. Their design notes are in the git history
  (0.5.0-rc0).

## A. GNOME's own calendar and notification menu (implemented)

### A.1 Goal

Froonty's pill sits on GNOME's top bar clock, which is transparent
underneath ([DESIGN.md §5](../DESIGN.md#5-reusing-gnomes-date--notification-menu)).
A click on the clock used to open GNOME's menu: the notification list (with
Do Not Disturb and Clear), the month calendar, events, world clocks and
weather. The pill takes that click, and it hid the clock's
unread-notifications dot. Step A gives both back **without reimplementing
either**: no calendar and no notification store of Froonty's own
(DESIGN.md §2, principle 1).

```
 collapsed:      ( 14:35 • )                    • = GNOME's unread dot
 expanded:  ┌────┬───────────────────────────────────────────┐
            │ 📝 │   [🎤][🔊] ( Sat Oct 3 14:35 • )          │  the date pill opens
            │ …  │   active tab                              │  GNOME's menu
            │ ⚙️ │                                           │
            └────┴───────────────────────────────────────────┘
```

### A.2 What the user can do

1. **Open it with the pointer:** open the island, then click the **date
   pill** (the date and the time, centred at the top of the island; its
   tooltip says "Calendar and notifications"). The island closes and GNOME's own menu opens under
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
    rounded, the date dimmer than the bold time), as tall as the panic
    buttons beside it.
  - It is centred on the whole island, over GNOME's clock under it, with
    the panic buttons on its two sides (the first 4 left, the next 4
    right) and a tab's own buttons (Notes' All notes) at the header's
    right end; on a tab too narrow for that it moves just enough to stay
    clear of them and of the tab column. Tab reaches it after ⚙️ (at the
    bottom of the tab column) and the panic buttons on its left.
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
  nothing.
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
  bar clock updates it; its accessible name; as tall as a panic button, rounded,
  text not cut; screenshots `hub-header-pill`, `hub-header-pill-12h`.
  None without a date menu (a header built without one: the panic groups
  alone, which are then centred as one group); one
  handler on the clock service while it exists, none after; with the
  island turned off, no handler left on the clock service at all.
- The date pill between the panic groups, centred on the island or moved
  just clear, its tooltip.
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
