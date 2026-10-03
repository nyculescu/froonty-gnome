# Feature: Notifications

Status: **first iteration, implemented**, 2026-10-02. Public (in `make
pack` output). **On by default** (section 3).

The user asked (2026-10-02): "The PC events or notifications will appear
separately from the Calendar, in a Notifications tab". This tab lists the
computer's notifications, GNOME's own, in the island. It is a view of
GNOME's list, not a second one: Froonty keeps no copy and stores nothing.

## 1. What the user gets

```
┌────┬──────────────────────────────────────────────┐
│ 🕒 │  5 notifications                [🔕] [Clear all] │
│ 🔔•│  ┌──────────────────────────────────────┐ [×] │  red outline: urgent
│ 📝 │  │ ⚙ Froonty build · 30 minutes ago     │     │
│ …  │  │ [⚠] Build failed                     │     │
│    │  │     Build failed: the log says…      │     │
│    │  └──────────────────────────────────────┘     │
│    │  ┌──────────────────────────────────────┐ [×] │
│    │  │ ✉ Mail · Just now                  • │     │  • = not seen yet
│    │  │ [👤] New mail                         │     │
│    │  │     Hello, the body wraps over at    │     │
│    │  │     most three lines and then…       │     │
│    │  └──────────────────────────────────────┘     │
│    │     [ Open ] [ Reply ] [ Archive ]            │  at most three actions
└────┴──────────────────────────────────────────────┘
```

- **The list:** GNOME's notifications (`Main.messageTray`), live while
  the tab is on screen. One flat list: critical ones first (outlined in
  red), then newest first. Each row is labelled with its app (icon and
  name), and shows how long ago it came in (GNOME's own wording, "10
  minutes ago"), its title, its body (at most three lines), its own icon
  if it has one, and at most three action buttons (GNOME's limit).
  Hovering a row shows the app, the time, the title and up to 600
  characters of the body.
- **Click a row:** what a click in GNOME's list does, `activate()`: the
  app opens it, and GNOME removes it unless it is resident. The island
  then closes, as GNOME's menu does. **GNOME's rule for an app that sent
  its notification without a "default" action** (over
  `org.freedesktop.Notifications`): GNOME opens the app instead, and
  removes *all* of that app's notifications that are not resident, not
  only the one clicked. GNOME's own list does exactly the same; Froonty
  makes the same call and cannot tell such a notification apart
  beforehand (section 5).
- **An action button:** the app's action, as in GNOME's list
  (`Action.activate()`); the island closes.
- **× or Delete** (also KP_Delete and BackSpace, as GNOME's list):
  dismisses that one. The island stays open; the keyboard focus moves to
  the row now in its place. Holding Delete down dismisses one: the
  keyboard's repeats are ignored. The row below moves up at once, so for
  the system's double-click time (and distance) after a removal by a
  click, a second click there does nothing: a double click on × dismisses
  one, not two.
- **Clear all:** two clicks. The first turns "Clear all" into "Keep them"
  and shows a red "Clear N?" beside it; "Clear N?" dismisses what was
  listed at the first click, as it was then: a notification that came in
  meanwhile stays, and so does one its app updated meanwhile (new text,
  unseen again), and N counts down. A double click on "Clear all" lands
  on "Keep them". From the keyboard, Enter on "Clear all" puts the focus
  on "Keep them" too, so a second Enter keeps them; confirming takes a
  move to "Clear N?" (Shift+Tab or Left), then Enter.
- **Do Not Disturb:** the 🔕 toggle in the header is GNOME's own switch
  (Quick Settings' one). Under Do Not Disturb the header starts with "Do
  Not Disturb ·": no banners, and notifications still arrive here.
- **The unread dot:** the tab's icon carries GNOME's unread dot, the same
  one as on the pill and on 📅 (calendar.md §A).
- **Size:** 400 × 440 px by default; Settings → Notifications → Size
  (`notifications-width` 320-960, `notifications-height` 200-720), live.
- **Empty:** "No notifications" (and "Do Not Disturb is on" under it).
  Without GNOME's message tray (a changed Shell): "GNOME Shell's
  notifications are not available here."

## 2. GNOME Shell 50.1, checked

From the JavaScript in `/usr/lib/gnome-shell/libshell-18.so`
(`gresource extract … /org/gnome/shell/ui/<file>.js`):

- `ui/messageTray.js`: `Urgency` (`CRITICAL` 3),
  `NotificationDestroyedReason` (`DISMISSED` 2). A `Notification` has
  `title`, `body`, `use-body-markup`, `gicon`, `datetime`, `urgency`,
  `acknowledged` (GNOME's "seen"), `resident`, an `actions` array
  (`label`, `activate()`), signals `action-added`, `action-removed`,
  `activated`, `destroy(reason)`. Any property change re-stamps its
  `datetime` in an idle (so an updated notification moves up). GJS
  notifies a property only when its value changes.
  `activate()` and `Action.activate()` destroy it unless resident;
  `destroy()` disposes it. A `Source` keeps `notifications` (oldest
  first, at most 10), emits `notification-added` and
  `notification-removed` (from inside the notification's `destroy`), and
  destroys itself once empty. `MessageTray` has `getSources()`,
  `source-added` and `source-removed` (also when an app is switched off in
  Settings, without a destroy). A banner shown sets `acknowledged`; LOW
  never gets one; while `bannerBlocked`, banners wait in the private
  `_notificationQueue` (at most three, unless critical), and
  `_updateState()` returns before it drops seen ones from that queue: it
  drops them only once banners are released.
- `ui/messageList.js`: GNOME's list. A click calls `activate()`, an
  action button `action.activate()`, the close button
  `destroy(DISMISSED)`; Delete, KP_Delete and BackSpace close; at most
  three buttons; titles and bodies through `Util.fixMarkup`, newlines as
  spaces. Mapping its group sets `acknowledged` on every notification it
  shows ("shown = seen").
- `ui/dateMenu.js` `MessagesIndicator`: the clock's dot, unseen minus
  those queued for a banner, hidden under Do Not Disturb.
- `ui/notificationDaemon.js`: an app's notification over D-Bus
  (`org.freedesktop.Notifications`, through the `org.gnome.Shell.Notifications`
  service): the default action and named actions become `ActionInvoked`;
  a `DISMISSED` destroy becomes `NotificationClosed` reason 2. Without a
  "default" action, `activated` runs `source.open()`: the app is
  activated (if GNOME knows it) and `destroyNonResidentNotifications()`
  removes every one of that source's notifications that is not resident
  (`notificationDaemon.js` 233-240, 362-366). An update (`replaces_id`)
  sets the same object's text and `acknowledged: false`.

## 3. Decisions

- **Froonty's own rows, GNOME's calls.** GNOME's `MessageView` was
  rejected: it brings media player cards (not asked for) and leaks an MPRIS
  D-Bus proxy per instance (`new Mpris.MprisSource()`, never torn down),
  and the island is rebuilt on every screen lock. GNOME's
  `NotificationMessage` was rejected: its action buttons are private and
  emit nothing (the island could not close after one), they appear only
  once a message is expanded, and its card styling is tuned for the date
  menu. Froonty's rows call the same three methods GNOME's widgets call
  (`activate()`, `Action.activate()`, `destroy(DISMISSED)`), so what
  happens to a notification is GNOME's behaviour.
- **What counts as seen.** `acknowledged` is GNOME's "seen" flag (not
  read, not dismissed). GNOME sets it when a banner shows or its list is
  shown. Froonty sets it only on a deliberate act while this tab is on
  screen: the island opened by click, keyboard, shortcut or Ctrl+Alt+Tab,
  or input inside the open island that shows the user is at it (the
  island tells the hub, `Hub.noteUserInput()`; `Island._isDeliberate()`):
  - a press or touch anywhere in it;
  - a key, but never a modifier alone (Shift, Control, Alt, Super,
    AltGr…) nor the keyboard's auto-repeat;
  - a scroll.

  **Opening by hover alone marks nothing**, and after a hover-open the
  user may still be typing into their window: the key focus is on the
  pill and the pointer rests where the pill was, over the island's
  header. So until they click in it, a key counts only once the key focus
  has moved into the island (Tab moves it; Tab itself, and Space or Enter
  on the pill, which close it, do not count), and a scroll only over the
  tab's own content (the list), not over the header. Side effects:
  clicking another tab or ⚙️ with this list on screen counts as seen; a
  notification arriving while the tab is on screen stays unseen until
  the next input. **One waiting for its banner** (GNOME's queue, while
  the island holds banners) is never marked seen by Froonty: its banner
  shows when the island closes, and GNOME marks it seen then. Its row
  keeps its dot meanwhile. (GNOME's own list marks those seen too, and
  drops their banners; but GNOME counts unseen minus queued and, while
  banners are held, does not drop seen ones from its queue, so each
  would be subtracted twice and a later unseen notification would light
  no dot until the island closed.) (A setting could offer GNOME's looser
  rule.)
- **One dot rule.** The tab's dot is GNOME's `MessagesIndicator`
  (`CalendarMenu.hasUnread`), as for the pill and 📅. A NORMAL
  notification arriving while the island is open waits for its banner, so
  it lights no dot (GNOME counts unseen minus queued); a LOW one, or one
  past the queue's limit of three, lights it at once, also after the user
  marked the list seen (the one waiting stays unseen, see above).
- **Clear all takes two clicks**, GNOME's takes one: it removes from
  GNOME's own history, and the island is opened in passing more often
  than GNOME's menu. The confirmation applies to what was listed at the
  first click, as it was: the store keeps a version per listed
  notification, bumped when what its row shows changes (title, body,
  icon, time, urgency, actions) or it comes back unseen, and the first
  click keeps (notification, version) pairs. An app updating one in place
  (`replaces_id`) changes its version, so it stays, and "Clear N?" counts
  only the unchanged ones. Being marked seen is not a change. From the
  keyboard, the first activation focuses "Keep them", the choice that
  removes nothing. **Deviation from the plan:** the plan had the "Clear all"
  button turn into "Clear N?"; then a double click would clear. As in Kill
  Process, the second click lands on "Keep them" instead, which takes
  the button's place (at least as wide), and "Clear N?" appears beside
  it.
- **No second click after a removal.** × removes its row at once, and the
  next row's × moves up under the pointer; after "Clear N?", the header's
  🔕 or "Clear all" moves into its place. GNOME's list animates a removal
  for 100 ms, less than a double click. Instead, the view keeps the time
  and position of the last removal made by a click, and ignores a click or
  touch on a row, its ×, its action buttons, 🔕 or "Clear all" within the
  system's double-click time and distance of it (`Clutter.Settings`).
  Keys are not affected (two presses of Delete dismiss two), and a click
  elsewhere, or later, works at once. No timer: a timestamp is compared.
- **Other departures from the plan, each found while testing:** a change
  of a notification's time or urgency re-sorts the list *and* updates its
  row (the plan only re-sorted, so a re-stamped row kept "10 minutes
  ago"); the body's three-line cap fills its label itself instead of
  through `x_expand`/`y_expand` (expand flags spread up to the row, and
  a lone row then filled the whole list); the hover bubble's text is
  wrapped by a small pure module (`text.js`), since the shared tooltip
  does not wrap.
- **Do Not Disturb** writes GNOME's own key,
  `org.gnome.desktop.notifications show-banners` (inverted), only on the
  user's click: what Quick Settings' toggle does. (The camera panic button
  writes `org.gnome.desktop.privacy` the same way.)
- **Not shown:** media player cards (this tab is for notifications);
  links in a body are text, not clickable (GNOME's `URLHighlighter`
  makes them clickable; here a click on the row activates it); body
  markup is shown as plain text (bold and italic are dropped); no expand
  button (three lines, the rest in the hover bubble).
- **On by default.** The user asked for this tab by name. It is a
  read-only view of GNOME's own list: no copy, no file, no network, no
  timer, nothing watched until it is on screen. It never removes a
  notification without a click, Delete or the confirmed "Clear N?", and a
  double click, a held key or a double Enter does no more than one such
  act. It marks one seen only on a deliberate act, which is as strict as
  GNOME (where a banner shown or the list shown counts) or stricter. It is where the pill's unread dot
  now leads. Unlike Clipboard (it records data) and Kill Process (it
  ends programs), it carries no privacy or destructive risk. Its cost is
  one more tab in the column (about 32 px), which the Clock tab's 140 px
  height already exceeds.

## 4. Data flow

1. **Opened on purpose with this tab selected.** `Hub.setShown(true)`:
   the service watches GNOME's tray (the store emits `changed`), the view
   reconciles its rows, describes each again (nothing was followed while
   hidden), follows the clock for the ages, and scrolls to the top. Then
   the island calls `hub.noteUserInput()` → `view.onUserInput()` →
   `service.markSeen()`: GNOME's `acknowledged` on each listed one, except
   one waiting in GNOME's banner queue; GNOME's dot goes, so the pill's,
   📅's and the tab's go, and so do the rows' dots.
2. **Arrival while on screen:** a row appears in its place with its dot,
   not seen. A LOW one (no banner) is marked seen by the next deliberate
   input (§3). A NORMAL or critical one waits for its banner (the island
   holds banners), unless GNOME's queue of three is full: it stays unseen,
   and its banner shows when the island closes, which marks it seen.
3. **A click:** the press marks the list seen; then `activate()`. GNOME
   may destroy it at once, which removes its row inside the row's own
   click (the Clipboard tab does the same); for an app's notification
   without a default action, GNOME removes all of that app's that are not
   resident. Then `ctx.collapse()`.
4. **× or Delete:** `destroy(DISMISSED)`; apps on D-Bus get
   `NotificationClosed` reason 2. The island stays open. A click on ×
   notes its time and place: a second click there within the double-click
   time does nothing.
5. **Collapse, or another tab:** the service stops watching (no handler
   left), the view stops following the clock, hides its bubble and drops a
   pending "Clear all". The rows stay for the fade-out with their last
   plain descriptions; they never read GNOME's objects.
6. **Disable** (also every screen lock): the hub destroys the view and
   stops the service. No notification is changed.

## 5. Edge cases

- **Updated in place** (an app replacing it, or any property set): the
  row updates, comes back unseen if the app says so, and moves up once
  GNOME re-stamps its time.
- **Replaced** (a GTK app's): GNOME destroys the old one and adds a new
  one; one row goes, another comes.
- **GNOME's own removals** (10 per app at most, a transient one after its
  banner, an app closing it, a window's attention request once focused)
  show as rows leaving. Never Froonty's doing.
- **An app switched off in Settings:** its rows leave and nothing is
  destroyed; they are back when it is switched on again.
- **Resident:** a click or an action keeps it, as in GNOME.
- **Sent without a default action** (an app over D-Bus that did not
  offer "default"): a click on it removes every notification of that app
  that is not resident (GNOME's `Source.open()`), as a click in GNOME's
  own list does. The other apps' stay. Froonty cannot see beforehand
  whether one has a default action (GNOME keeps that in a closure), so
  the row cannot warn about it.
- **Transient ones** marked seen while their banner waited are never
  expired by GNOME and stay until dismissed; GNOME's own list has the
  same effect.
- **Clicks during the collapse fade** do nothing: the service is
  inactive, so a notification that may be gone is never touched.
- **A double click on ×:** the first click dismisses it, and the next row
  moves up under the pointer; the second click, within the double-click
  time and distance, does nothing. A triple click too. A click at the
  same spot after the double-click time dismisses the next one.
- **Delete held down:** one dismissed; the repeats (they reach the next
  row, which has the focus by then) do nothing.
- **Enter twice on "Clear all":** the first asks and focuses "Keep them",
  the second keeps them.
- **Updated while "Clear N?" waits:** it stays, N counts down; if nothing
  unchanged is left, the question goes.
- **No time:** no age, and it sorts after the timed ones. **No app
  name:** "Unknown app". **No app icon:** a generic one. **No icon of
  its own:** none shown.
- **Clock with seconds:** the ages are refreshed on the top bar clock's
  ticks, but a label is set only when its text changes.

## 6. Structure

```
shell/messageTray.js         private adapter: gnomeNotifications() → ctx.notifications
                             {createStore, plainText (fixMarkup, Pango), timeAgo
                             (formatTimeSpan)}; null without a message tray
shell/notificationStore.js   Shell-free: the only code reading or writing GNOME's
                             notifications; sorted list, follow while watching,
                             describe(), and the five writes
features/notifications/
├── index.js     descriptor (unreadDot: true), on by default, 400 × 440
├── service.js   NotificationsService: the store and Do Not Disturb, only while shown
├── view.js      header (status, 🔕, Clear all), list, empty state; reconcile by identity
├── row.js       NotificationRow (a widget subclass) and LineCapLayout (three lines)
├── text.js      the hover bubble's text (pure)
└── prefs.js     Settings → Notifications: show the tab, size
```

The feature reaches GNOME only through `ctx.notifications` and closes the
island through `ctx.collapse()` (both from `ui/island.js`); it imports
nothing from `shell/`. The hub shows the dot on tabs that declare
`unreadDot`, and passes deliberate input on to the active view
(`onUserInput`).

## 7. Resources

- **While on screen:** `Main.messageTray` ×2 (`source-added`,
  `source-removed`); per source ×4 (`notification-added`,
  `notification-removed`, `notify::title`, `notify::icon`); per
  notification ×3 (`notify`, `action-added`, `action-removed`); one
  `org.gnome.desktop.notifications` `Gio.Settings` with 2 handlers; one
  handler on the clock service's `changed`.
- **Hidden:** none. The `Gio.Settings` is kept until the tab is turned
  off or Froonty disabled.
- **The island:** one `captured-event` handler on the pill, for its
  lifetime.
- **The view:** the time and position of the last removal by a click (a
  number and two coordinates, no timer).
- No timers, no idle sources, no file or network I/O, no subprocesses,
  no D-Bus of its own. Nothing is created at module load: the row is a
  registered widget class (as Kill Process's), enum values are read when
  the store is made. The view is made when the tab is first selected.

## 8. Tests

- `tools/unit/notifications.test.js` (plain gjs; GNOME's tray, sources and
  notifications as GObject fakes of the same shape; a destroyed fake
  throws on any access; GNOME's settings on a memory backend): the order
  (urgent, newest, latest arrival; untimed last), nothing connected before
  watching, the sorted list with one `changed`, adds and removes,
  re-sorting (and the row updated) on a time or urgency change and only a
  row update on other changes, a source's name or icon, an app switched off and on, zero
  handlers after unwatching, a notification destroyed while not watched
  never touched again, `describe()`, seen marking, activate and actions
  (out of range ignored, resident kept), dismiss (once), clear (only the
  snapshot's live ones, one `changed`, across a source destroying
  itself); versions: one updated in place after the snapshot (text,
  unseen again, time, urgency, actions) is kept and not counted, one
  marked seen is still cleared, one listed again (its app switched off
  and on) is kept; seen marking leaves one waiting in GNOME's banner
  queue; the service (nothing until shown, Do Not Disturb, no tray,
  every call a no-op while hidden, `snapshot()` / `countClearable()`,
  `stop()`); the bubble's wrapping.
- `tools/headless-test/checks.js` `testNotifications` (both session
  modes): on by default and after Clock; nothing watched before it is
  shown; the dot on the tab and in its name; hover-open lists and marks
  nothing seen, nor does Shift then, but after Tab a key marks them seen
  and every dot goes; urgent
  first, then newest; app, icon, age, title, body, own icon, markup; a
  long body stopping at three lines with its last one ellipsized;
  handlers only while on screen; a live arrival (new-dot, banner held);
  an update in place (text, age, moved up); the next key marks a LOW
  arrival seen but not the one waiting for its banner; one closed by its
  app; a deliberate open marks seen
  and removes nothing; a LOW one on another tab lights the tab's dot;
  a row click (activated once, dismissed, island closed, no grab); a
  resident one kept; four actions → three buttons, the second runs;
  × dismisses one; keyboard (Tab, Delete moves the focus, Enter);
  Clear all asks, keeps, clears exactly the first click's list, is
  dropped on collapse; a lone row keeps its own height; empty; Do Not Disturb (default mode only); three
  real notifications over D-Bus (`ActionInvoked` "reply" and "default",
  `NotificationClosed` 2, and GNOME's destroy reasons); its size; five
  open/close/tab/disable rounds that remove and change nothing; disable
  while shown leaves no handler. `testLifecycle` runs its 25 cycles with
  this tab on screen and counts the tray's handlers too.
- `testNotificationSafeguards` (both session modes), the accidents:
  after a hover-open, Shift, Control and Alt alone, a key with the focus
  on the pill, a scroll where the pill was (the header) and Space (which
  closes it) mark nothing; Tab marks nothing, the key after it does;
  moving onto the list marks nothing, a scroll over it does; a double
  click on × dismisses one, and the next one is then under the pointer;
  a click there after the double-click time dismisses it; Delete held
  1.5 s with key repeat dismisses one; Enter twice on "Clear all" keeps
  them, Enter, Shift+Tab, Enter clears; a chat notification updated over
  D-Bus (`replaces_id`) while "Clear 3?" waits turns it into "Clear 2?"
  and stays; a click on a D-Bus notification without a default action
  removes its app's two non-resident ones (`NotificationClosed` 2 each,
  no `ActionInvoked`) and keeps the resident one and another app's; with
  banners held, a key leaves the queued one unseen, a LOW one on the
  Clock tab then lights the tab's dot, and once the island closes the
  banner shows and marks it seen.
- Screenshots: `notifications-list`, `notifications-live`,
  `notifications-tab-dot`, `notifications-urgent-actions`,
  `notifications-confirm`, `notifications-empty`, `notifications-dnd`,
  `notifications-hover-input`, `notifications-confirm-updated`.

## 9. Risks

- **Private APIs** (DESIGN.md §6.3), all exported but not an extension
  contract: `Main.messageTray` and its signals, `Source` and
  `Notification` fields, signals and methods (including writing
  `acknowledged`), `Action.activate()`, the two enums, `fixMarkup` and
  `formatTimeSpan`, and, read only, the private field
  `Main.messageTray._notificationQueue` (which notifications wait for
  their banner; without it, every listed one is marked seen, and the dot
  can lag while the island is open, as described in §3). They moved between GNOME 45 and 48 (the object-param
  `Notification`; `NotificationMessage` from `calendar.js` to
  `messageList.js`, with groups). All of it is in `shell/messageTray.js`
  and `shell/notificationStore.js`, with optional chaining; without a tray
  the tab shows a notice; the headless suite fails loudly on a change.
  `metadata.json` declares only shell-version 50.
- **Not verified here:** real apps' notifications (Firefox, Thunderbird,
  Flatpak apps through the portal, Chromium); whether an app's window
  comes to the front after the island closes on Wayland (activation
  tokens: the tests only see GNOME's own calls and D-Bus signals); Yaru
  beyond the Ubuntu-mode screenshots; HiDPI; many sources; other locales'
  "time ago" (the tests compare with GNOME's own function); other GNOME
  versions.
