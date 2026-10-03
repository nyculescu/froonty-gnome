# Froonty design notes

Target: GNOME Shell 50 on Ubuntu 26.04 (Wayland only). This document records
what was inspected, what was decided and why, and every GNOME Shell API
Froonty depends on.

## 1. Verified environment

| Component | Version on the development machine |
|---|---|
| Ubuntu | 26.04.1 LTS |
| GNOME Shell | 50.1 (Ubuntu build) |
| Mutter | 50.1 |
| GJS | 1.88.0 |
| GLib | 2.88.0 |
| libadwaita (prefs) | 1.9.1 |
| WirePlumber (tests) | 0.5.13 |

Froonty was designed against GNOME Shell 46 (Ubuntu 24.04). Line numbers in
Shell source references below are from 46 unless noted; the APIs themselves
were re-checked against 50.1 by running `make test` (section 1.1).

GNOME Shell source references are to the JavaScript **extracted from the
installed binary** (the `libshell-*.so` gresource), not to upstream `main`,
so they match exactly what runs on Ubuntu.

To re-extract:

```sh
lib=$(ls /usr/lib/gnome-shell/libshell-*.so)
for r in $(/usr/bin/gresource list "$lib"); do
    mkdir -p "gs50$(dirname "$r")"
    /usr/bin/gresource extract "$lib" "$r" > "gs50$r"
done
```

### 1.1 Port from GNOME Shell 46 to 50

What changed for Froonty, and how it adapts:

- **No X11, no input region.** `LayoutManager.addChrome()`/`trackChrome()`
  reject `affectsInputRegion`. Input goes to whichever reactive actor is
  picked, so the non-reactive strip is click-through by itself
  (`ui/chrome.js`).
- **St.Button clicks through a `Clutter.ClickGesture`.** Stopping
  `button-press-event` on an ancestor (the hub used to, so empty hub clicks
  did not reach the pill) starves every button inside. The hub now carries
  its own primary-button `ClickGesture`, which wins over the pill's and
  loses to its buttons'. St.Button's gesture accepts any button and filters
  by `button_mask` only when emitting `clicked`; a separate middle-button
  gesture on the same button is cancelled by it. Note tabs therefore take
  `ONE | TWO` and branch on the `clicked` button.
- **Extensions are enabled during the startup animation**, while `uiGroup`
  is scaled to 0.75. The clock's bounds are measured in `uiGroup`
  coordinates, not stage coordinates, so the pill is not placed mid-screen
  (`shell/dateMenu.js`).
- `St.BoxLayout`'s `vertical` is replaced by `orientation`.
- Test harness: WirePlumber 0.5 config (SPA-JSON, not Lua), test roots under
  `~/.cache` (GLib refuses to trash on `/tmp`, a tmpfs), and window
  timestamps from `get_current_time_roundtrip()`.

## 2. Principles

1. Reuse GNOME Shell facilities; never duplicate a store, a daemon or a
   calendar that GNOME already has. The Break tab shows and drives GNOME's
   own break engine (`Main.breakManager`, §6.3) instead of timing breaks.
   It keeps one Mutter idle watch of its own beside the engine's (same
   rule: 10 s, uninhibitable, and a one-shot active watch while idle),
   because the engine never says when an idle period starts: in its "IDLE
   while working" state going idle changes nothing
   ([features/break.md](features/break.md)).
2. Event-driven. A timer may only be added with a written justification
   and a configurable interval. The periodic timers are the Btop tab's
   (system monitor) and the Kill Process tab's, each only while its tab
   is on screen: no event tells when a CPU's load, a GPU's temperature or
   a process's CPU use changes, and readings are only worth anything live
   ([features/sysmon.md](features/sysmon.md),
   [features/kill-process.md](features/kill-process.md)). The Media tab's
   display tick is not a poll (it reads nothing) and has no setting: it
   fires at the next whole second of the shown position, the unit the
   timeline shows (`m:ss`), and runs only while the tab is on screen and
   the shown song plays with a known length and position
   ([features/media.md](features/media.md#position)).
   **Exception, written:** the Break tab's one-shot timer has no setting
   of its own. At most one runs, armed at the next moment the tab or the
   pill's cue changes by itself (2 min before a break, at it, 60 s and one
   interval after it, the long-rest crossing, the posture reminder,
   midnight) and re-armed only by events. GNOME's engine emits nothing at
   those moments (its `break-due` only fires if the user is active then),
   and the moments come from the user's own settings (GNOME's intervals,
   the posture and long-rest minutes), so a separate interval would mean
   nothing ([features/break.md](features/break.md)). Exercise pictures are
   still, so there is no frame timer.
3. No background processes or polling loop. Short-lived local subprocesses
  are limited to the Claude usage refresh, the Btop tab's
  `nvidia-smi` (NVIDIA's driver puts its readings nowhere else; only while
  the tab is on screen and the card is awake), the Kill Process tab's
  `/usr/bin/kill -s TERM|KILL <pid>` (GJS, GLib and the Shell cannot
  signal another process; once per confirmed click, fixed path and
  arguments, no shell) and two working-tree-only integrations, left out
  of `make pack` with their settings and CSS (the build fails if any of
  it reaches the zip):
  - ZeroTier. Its status reads use the installed CLI; explicit actions
    (Start/Stop, allowing status access) use fixed `pkexec` arguments.
  - The Writing tab ([features/writing.md](features/writing.md)), only on
    a click of one of its actions: one `claude -p` of the user's own
    Claude Code with every tool, MCP server, skill, hook and settings
    file off (fixed argv, text on stdin, no shell, SIGTERM on Cancel,
    timeout or disable), or one HTTPS POST to LanguageTool's public
    service, or HTTP to Ollama on 127.0.0.1. If Froonty installed Ollama
    and it is stopped, `systemctl --user start froonty-ollama.service`
    runs first; Ollama then runs until logout or Stop. Set-up and removal
    run only in the settings window, on a click. Besides clicks, only
    readiness checks when the tab comes on screen, when a Writing setting
    changes, or when the network goes on or off line while it is shown:
    Ollama's `/api/version` and `/api/tags` on 127.0.0.1 (2 s), and
    nothing sent anywhere else. Its addresses are fixed (LanguageTool's
    public service, Ollama on 127.0.0.1); the variables that move them are
    read only under the tests.

  The Claude tab's livenerf row is the only direct network access by
  default: it GETs two public files from GitHub while the tab is on
  screen, at most once an hour ([features/claude.md](features/claude.md)).
  The Media tab has two opt-in uses, both off by default and declared in
  the extension's description: covers a player gives as a web address,
  and lyrics from lrclib.net
  ([features/media.md](features/media.md#network-and-privacy)).
  The Claude attention bar spawns nothing: after the user's Set up, Claude
  Code (not the Shell) runs Froonty's GJS hook script, which writes one
  small file per waiting session under `$XDG_RUNTIME_DIR/froonty`, and a
  one-line `sh` clear command
  ([features/claude-attention.md](features/claude-attention.md)).
4. Every private Shell API is listed in section 6 and isolated in `shell/`.
5. `disable()` undoes everything `enable()` did. GNOME Shell 46 calls
   `disable()` on every screen lock (default `session-modes` is `["user"]`,
   `ui/extensionSystem.js:440`), so this path runs many times a day.
   Two exceptions are kept on the extension object, which lives as long
   as the Shell process: the "started" state behind `start-at-login`, so a
   screen unlock does not undo a manual start; and in-memory choices
   (`ctx.memory`: Media's chosen player), so a lock does not forget them.
   Both are plain data, never GObjects. The Claude attention bar's state
   folder is kept through a screen lock only (what waits survives it), told
   apart by `Main.sessionMode.isLocked`; any other disable removes it, so
   Claude Code's hooks record nothing.
   Another exception: with the Break tab's reminders in the island,
   GNOME's Wellbeing notifications stay off while the screen is locked
   (`disable()` sees `Main.sessionMode.isLocked`). Restoring them there
   would put break notifications on the lock screen and make them flicker
   on every unlock. Any other `disable()` restores them, and the Break
   tab's day totals are saved to a file so they survive the lock.

## 3. NexNotch review

NexNotch (<https://github.com/NexVar/NexNotch>, GPL-3.0-or-later, targets
GNOME 49/50) was read as a reference only. **No NexNotch source code was
copied or adapted into Froonty.** Only visual ideas were borrowed: a black
pill, a hairline border, tabular figures, and fading content while the pill
resizes. Froonty's CSS was written from scratch.

| Feature | What NexNotch does | Fit for GNOME 46 | GNOME 46 already provides | Froonty decision |
|---|---|---|---|---|
| Pill and positioning | `addTopChrome`, primary monitor, recentered on its own `notify::allocation` on every frame | APIs exist in 46 | `layoutManager.addChrome()` / `trackChrome()` | **Adapt the idea.** Froonty centers through layout (full-width strip + `BinLayout`), with no per-frame JS |
| Hide clock | `dateMenu.container.visible = false` | Breaks reuse of the date menu (see §5) | — | **Rewrite.** Use opacity so the menu keeps its anchor |
| Clock | Own `GLib.timeout_add` chain plus logind `PrepareForSleep` resync | Works | `GnomeDesktop.WallClock`, which is suspend- and timezone-safe | **Discard** and use WallClock |
| Expand/collapse | Hover with 180/300 ms delays; `ease()` width/height; `EASE_OUT_BACK` | Works | Clutter `ease()`; `GrabHelper` for menu-like modality | **Adapt.** Click, keyboard, Escape and outside-click like a GNOME menu |
| Shortcut | `<Super>n` | **Conflicts** with GNOME's `focus-active-notification` (`ui/messageTray.js:779`) | — | Froonty uses `<Super><Alt>i`, free on stock Ubuntu 24.04 |
| Notifications | `source-added` + `notification-added`; hides `Main.messageTray._bannerBin` (never re-shown in 46); **calls `notification.destroy()` after N s**, which deletes it from GNOME's history | Signals exist; behavior harmful | `Source` `notification-request-banner`, `MessageTray.bannerBlocked`, object-param `Notification` (46 already uses `new Notification({source, title, body})`) | **Rewritten** as the Notifications tab: observe only, never destroy on its own, GNOME's urgency, policy and banners ([features/notifications.md](features/notifications.md)) |
| MPRIS | Own synchronous proxies with name watching | Works, but blocks the compositor thread at startup | `ui/mpris.js` exports `MprisPlayer` | **Done:** own async proxies (`features/media/mpris.js`). `MprisPlayer` was not used: no teardown, no position or seeking, placeholder texts ([features/media.md](features/media.md#code)) |
| Calendar | Own month grid; CalendarServer D-Bus; Google Tasks over REST with OAuth | Heavy; duplicates GNOME | `DateMenuButton` (the whole menu), `Calendar.Calendar`, `DBusEventSource`; Evolution Data Server (the user's calendars, GNOME Online Accounts) | **Discard** the fetchers. Open GNOME's own menu (§5). The Calendar tab reads EDS read-only through its own bindings (not CalendarServer: one global time range, no calendar or colour); no account, OAuth or network code of Froonty's ([features/calendar.md](features/calendar.md) §B) |
| Weather | Soup + wttr.in, always on, every 30 min | Works | `misc/weather.js` `WeatherClient` (GWeather; same locations as GNOME Weather) | **Discard** the fetcher and reuse `WeatherClient` in Phase 6, off by default |
| Quick actions | `loginctl`/`systemctl` subprocesses; polls `pactl`, `fuser`, `upower` every 15 s | Spawns processes | `misc/systemActions.js` `getDefault()`; `ui/status/*` | **Discard** the polling; use SystemActions if needed |
| System metrics | Synchronous `/proc` reads every 1 s while visible, 3 s otherwise, never stopped | Works | Nothing equivalent | **Rewritten** as the Btop tab: async reads, only while its tab is on screen, configurable interval |

Other NexNotch issues noted: `enable()` spawns `evolution-source-registry`
each time; several synchronous D-Bus calls on the compositor thread; some
idle callbacks are not tracked.

## 4. Creating the top-center island

Options considered:

1. **Add a `PanelMenu.Button` to the panel's center box.** The island would
   be clipped to the panel height and could not expand over windows. Rejected.
2. **Replace `dateMenu`'s actor.** This is invasive and breaks the date menu.
   Rejected.
3. **A separate chrome actor over the panel center** (chosen).

The actor tree (`ui/island.js`) is:

```
strip   St.Widget #froontyStrip, BinLayout, full monitor width, reactive only while expanded
 └ column  St.BoxLayout #froontyColumn .froonty-column, vertical, as wide as the strip, non-reactive
    ├ pill  St.Button #froontyPill (click + Enter/Space + a11y), clip_to_allocation, centered
    │  └ content  BinLayout: CollapsedView | Hub (cross-faded)
    │     └ grip layer  click-through, over both (ui/resizeGrip.js): the resize
    │                   grip, translated into the pill's bottom-right padding
    │                   corner, and its tooltip; the grip shows only while
    │                   expanded on a tab with hubSizeKeys
    └ bar   the Claude attention bar (features/claude/attentionBar.js), centered; only
            while that feature is on, shown only while the island is
            collapsed and a Claude session waits
```

The hub (`ui/hub.js`) is the expanded content:

```
hub     BinLayout, reactive (stops clicks from reaching the pill)
 ├ main     [tab column (GridLayout, TAB_COLUMNS = 1; the island grows to fit it)] [header 📅 [feature actions] ⚙️ / content]
 ├ panic    panic bar, centered across the island (click-through layer)
 └ overlay  tooltips (click-through, fixed positions)
```

- `Main.layoutManager.addChrome(strip, {affectsInputRegion: false, trackFullscreen: true})`
  places the strip above the panel and below popup menus. It is hidden over
  fullscreen windows, exactly like the panel.
- `Main.layoutManager.trackChrome(pill, {affectsInputRegion: true})` means only
  the pill takes input on X11. On Wayland the strip is click-through while
  collapsed because it is non-reactive.
- The column fills the strip's width and centers the pill while its width
  is eased, so no JavaScript runs per frame. A hidden attention bar takes
  no room, so the pill sits where it always did.
- Sizes are logical pixels multiplied by `St.ThemeContext.scale_factor`, which
  is 1 on Wayland's logical layout. `border-radius` is CSS; St clamps an
  oversized radius to half the shorter side. As a result the collapsed pill is
  always fully round, and the radius grows smoothly while it expands (verified
  by screenshot).
- **Expanded modality** reuses `ui/grabHelper.js` `GrabHelper`, the same helper
  GNOME's dialogs use. It gives Escape and click-outside dismissal, and focus
  save/restore. Two non-obvious requirements, both found by the headless
  tests:
  - The grab owner must be an *ancestor* of the grabbed actor, so the strip
    is the owner and the pill is grabbed.
  - Clutter only emits events on **reactive** actors. The strip is therefore
    made reactive for the duration of the grab only; otherwise GrabHelper
    never sees Escape or outside clicks.
- Keyboard:
  - Enter or Space on the focused pill (St.Button).
  - Escape (GrabHelper).
  - A global shortcut through `Main.wm.addKeybinding` (default `<Super><Alt>i`).
  - Ctrl+Alt+Tab through `Main.ctrlAltTabManager.addGroup`, which expands
    the island.
- **Resize grip** (`ui/resizeGrip.js`, clamping in `ui/hubResize.js`). An
  arc concentric with the island's bottom-right corner, drawn in an
  `St.DrawingArea` with the `SE_RESIZE` cursor (`Clutter.Actor`'s own
  `cursor-type`, so nothing global is set). A `Clutter.PanGesture` with a
  begin threshold of 0, as GNOME's sliders use, recognizes on the press, so
  the pill's own click gesture (an ancestor's) is cancelled and a press on
  the grip never closes the island; a stage grab on the grip, nested in the
  island's modal grab, holds the drag (Escape cancels it). While dragging,
  the island takes the size at once (`Island._previewHubSize()`: the size
  replaces the keys' values in `IslandGeometry.expandedSize()`, transitions
  removed); the release writes the two keys while that size still holds, so
  the island does not move. A click without movement counts towards a
  double-click (GNOME's `double-click-time`, no timer), which resets both
  keys.
- Multi-monitor: the island follows the **primary** monitor, like GNOME's
  panel. It re-syncs on `layoutManager` `monitors-changed`, `panelBox`
  `notify::height` and `ThemeContext` `notify::scale-factor`.

## 5. Reusing GNOME's date / notification menu

Findings from `ui/panel.js`, `ui/panelMenu.js`, `ui/popupMenu.js` and
`ui/dateMenu.js`:

- `Main.panel.toggleCalendar()` and `closeCalendar()` exist
  (`panel.js:826-836`). GNOME uses them itself: `toggleCalendar()` is the
  handler of the `toggle-message-tray` keybinding (Super+V,
  `windowManager.js:1735`).
- `Panel._toggleMenu()` returns early if the indicator is **not mapped** or
  not reactive (`panel.js:803`).
- `PopupMenu` closes itself when its source actor is unmapped
  (`popupMenu.js:890-895`). `BoxPointer` positions against the source actor
  (`popupMenu.js:979`).

Consequences:

- Froonty must **not** hide the panel clock with `hide()` or
  `visible = false`, as NexNotch does. Doing so makes GNOME's calendar and
  notification menu impossible to open. `shell/dateMenu.js` sets
  `container.opacity = 0` instead. The clock stays mapped, allocated and
  reactive at top center, directly under the island.
- Because the transparent clock is still clickable, the collapsed pill must
  **cover it completely**, otherwise clicks on the protruding edges open
  GNOME's menu. This was found on a real session where the clock shows
  weekday + date.
  - `collapsed-width` and `collapsed-height` are therefore minimums.
  - Horizontally, the pill grows to
    `2 × max(center − clockLeft, clockRight − center)` around the monitor
    center, with parity matching the monitor width so it stays on whole
    pixels. With Ubuntu's panel, the clock can sit off-center (33px in
    testing), which makes the pill wider than the clock.
  - Vertically, the pill takes at least the clock button's height, which is
    the full top bar height, and is centered on it.
  - The panel centers the clock with its own rounding and shifts it when the
    left box is crowded, so matching the width alone is not enough (a 1px
    sliver was exposed in testing).
  - Allocation is parent-relative, so the adapter watches `notify::allocation`
    on the clock and every ancestor up to `panelBox`. Moving the panel to a
    new primary monitor only re-allocates ancestors.
  - The adapter recomputes once per frame through a `BEFORE_REDRAW` later,
    after layout, so it never resizes actors mid-allocation.
- **Done** (Unreleased; [features/calendar.md](features/calendar.md) §A,
  `CalendarMenu` in `shell/dateMenu.js`; line numbers below are from
  50.1): 📅 in the hub calls
  `Main.panel.toggleCalendar()`, the handler of GNOME's own Super+V. GNOME's
  menu opens with its arrow pointing at top center, below the island. It
  needs no re-anchoring and no private menu internals. GNOME keeps full
  ownership of notification storage, actions, DND, the calendar, world
  clocks and weather.
  - The plan was to call it *after* releasing Froonty's own grab. It is
    called first instead: the menu's `open-state-changed` collapses the
    island, for 📅 and Super+V alike, and the island's grab is released
    from under the menu's. `Main.popModal()` supports a grab that is not
    the topmost and shifts its saved focus on to the menu's record
    (`main.js:845-870`), so Escape returns the focus to where it was
    before the island opened. Expanding the island first closes GNOME's
    menu (`closeCalendar()`): one modal at a time.
  - The clock's unread-notifications dot is under the pill. Froonty
    follows the `visible` property of the clock's own `MessagesIndicator`
    (`dateMenu.js:742-799`, GNOME's rule: unseen minus queued for a
    banner, hidden under DND) and shows the same dot on the pill and on 📅.
  - Banners show under the clock (`Panel._updatePanel()` aligns them with
    the date menu, `panel.js:641-647`), where the expanded island is, and
    the island is drawn above the message tray. While expanded it sets
    `Main.messageTray.bannerBlocked`, as `Panel._onMenuSet()` does for a
    menu open at the banners' alignment (`panel.js:731-750`); otherwise a
    banner would show under the island and be marked seen
    (`messageTray.js:1161`).
- A popup menu is raised to the top of `uiGroup` on open
  (`popupMenu.js:1069` in 50.1), so the menu draws above the island.

## 6. API inventory

### 6.1 Public / stable (GI libraries)

| API | Used for |
|---|---|
| `St`, `Clutter` (`ease()`, `BinLayout`, `AnimationMode`, `ActorAlign`) | Actors, layout, animation |
| `GnomeDesktop.WallClock` (4.0, the version the Shell pins) | Minute ticks; handles suspend and timezone changes |
| `GLib.DateTime`, `GLib.TimeZone` | Formatting |
| `Gio.Settings` (own schema; `org.gnome.desktop.interface clock-format`) | Settings |
| `Atk.StateType.EXPANDED` | Accessibility |
| `Gvc` streams (`change_is_muted`, `notify::is-muted`), through the Shell's mixer | Panic buttons: mute microphone / sound |
| `Gio.Settings` `org.gnome.desktop.privacy` `disable-camera` (`changed::`, `writable-changed::`): GNOME Settings' Camera Access switch, enforced by xdg-desktop-portal's camera portal only | Panic button: block camera for apps that ask GNOME ([features/panic-buttons.md](features/panic-buttons.md) §4) |
| `Gio.Settings` `org.gnome.desktop.notifications` `show-banners` (`changed::`, `writable-changed::`; inverted, it is GNOME's Do Not Disturb, the key Quick Settings' toggle is bound to) | Notifications tab: shows Do Not Disturb, and its toggle writes it on a click ([features/notifications.md](features/notifications.md)). The Claude attention bar hides under it (`changed::show-banners`) |
| `Pango.parse_markup` | Notifications tab: a notification's text without its markup, after GNOME's `fixMarkup` |
| `Gio.File` async I/O, `Gio.FileMonitor` | Notes: Markdown files, folder watching; Claude: Claude Code's config file; the attention bar: a directory monitor on its state folder |
| `Gio.NetworkMonitor` (`network-changed`, `notify::connectivity`, `notify::network-available`) | Claude: "Unknown" while offline, from NetworkManager's own check |
| `Soup` 3 (`Session.send_and_read_async`) | Claude: livenerf's README and chart from `raw.githubusercontent.com` |
| `Soup` 3 (`Session.send_async` and a streamed body; `form_encode_hash`; `Soup.Server` in the tests) | Writing (local builds): LanguageTool's form POST, Ollama's streamed NDJSON, the set-up's download |
| `Gio.SubprocessLauncher` (working folder, environment, stdin) | Writing (local builds): `claude -p` in a private folder, with paid-billing variables removed |
| `PangoCairo` | Claude: the labels of livenerf's chart, drawn on an `St.DrawingArea` |
| `Meta.KeyBindingFlags`, `Shell.ActionMode` | Keybinding |
| `global.compositor.get_laters()`, `Meta.LaterType.BEFORE_REDRAW` | Work after a layout pass, before the next frame: the clock cover's bounds (`shell/dateMenu.js`), the Kill Process list's rows after a scroll |
| `Gio.DBusConnection` (`signal_subscribe` with `MATCH_ARG0_NAMESPACE`, async `call`), `Gio.DBusProxy` (async, no interface info, on unique names) | Media: MPRIS players ([features/media.md](features/media.md)) |
| `GdkPixbuf` (`new_from_stream_at_scale_async`, `scale_simple`), `St.ImageContent.set_bytes` | Media: covers, decoded asynchronously; the tint |
| `Shell.AppSystem.lookup_app`, `Shell.WindowTracker.get_app_from_pid`, `Shell.App.activate` | Media: a player's app name and icon; "Open player" |
| `Soup` 3 (`Session.send_async`, `InputStream.read_bytes_async`) | Media, opt-in only: web covers, lrclib.net |
| `St.Settings` `enable-animations` | Media: the bars stand still with GNOME's animations off |
| `Adw` 1.5, `Gtk` 4 | Preferences |
| `ECal` 2.0, `EDataServer` 1.2, `ICalGLib` 3.0 (Evolution Data Server's bindings, `gir1.2-ecal-2.0`; optional, imported at run time by `features/calendar/eds.js` only): `SourceRegistry`, `SourceRegistryWatcher`, `ECal.Client.connect`/`get_view`/`get_timezone`/`get_objects_for_uid` (async), `ClientView` (its `start` is a synchronous D-Bus call, made once per view; `stop`/`set_flags` are too, and never called, §8), `recur_generate_instances_sync` (CPU only), `ICalGLib.RecurIterator` (CPU only) | Calendar tab: the user's calendars and live events, read-only |
| `GIRepository` 3.0 `Repository.enumerate_versions` | Calendar tab: whether the EDS bindings are installed, without importing them (GJS remembers a failed import) |
| `Gio.Settings` `org.gnome.desktop.calendar` (`week-start-day`, `show-weekdate`; read only) | Calendar tab: GNOME's week start and week numbers |
| `Gio.AppInfo.launch_default_for_uri_async` | Calendar tab: open an event's day in the web calendar |
| `Meta.IdleMonitor` (the core idle monitor: `add_idle_watch_full` with `UNINHIBITABLE`, `add_user_active_watch`, `remove_watch`, `get_idletime`) | Break tab: when the user was at the computer or away (`features/break/shared.js`) |
| `Gio.Credentials` (`get_unix_pid()`) | Break tab: tells a screen unlock (same Shell process: GNOME kept counting) from a new login |
| GNOME's `Gio.Settings` schemas `org.gnome.desktop.break-reminders` (+ `.eyesight`, `.movement`), `org.gnome.desktop.notifications.application` at `…/application/gnome-wellbeing-panel/` (`enable`), `org.gnome.desktop.screen-time-limits` (`daily-limit-enabled`, read only); each looked up before use | Break tab: GNOME's break settings; its notifications off and back ([features/break.md](features/break.md)) |
| Clutter actor transforms (`set_pivot_point`, `scale_x = -1`) | Break tab: Workrave's mirrored exercise pictures; the standing bar's fill |

### 6.2 Shell APIs commonly used by extensions (exported; not formally stable)

| API | Source (46) |
|---|---|
| `Extension`, `ExtensionPreferences`, `getSettings()`, `gettext` | `extensions/extension.js`, `extensions/prefs.js` |
| `Main.layoutManager.addChrome / trackChrome / primaryMonitor / panelBox`, signals `monitors-changed`, `system-modal-opened` | `ui/layout.js` |
| `Main.wm.addKeybinding / removeKeybinding` | `ui/windowManager.js:1100` |
| `Main.ctrlAltTabManager.addGroup / removeGroup` | `ui/ctrlAltTab.js:32` |
| `GrabHelper` (which uses `Main.pushModal`) | `ui/grabHelper.js` |
| `EventEmitter`, `connectObject` / `disconnectObject` | `misc/signals.js`, `misc/signalTracker.js` |
| `Shell.util_translate_time_string` with GNOME Shell's `calendar heading` msgid | `ui/dateMenu.js:175-178` |
| `Shell.util_translate_time_string` with GNOME Shell's grid msgids (`grid monday` …), `%OB`, `%OB %Y` and `calendar-no-work`; `Shell.util_get_week_start()` (Calendar tab) | `ui/calendar.js` (50.1) |
| `Shell.AppSystem.lookup_app()` (Online Accounts), `global.create_app_launch_context()` (Calendar tab) | `ui/dateMenu.js` (50.1) does the same |
| `global.compositor.get_laters()` (`Meta.LaterType.BEFORE_REDRAW`): the Calendar tab's scroll to the selected day, once laid out | `shell/dateMenu.js` uses it too |
| `global.focus_manager.navigate_from_event` (Tab navigation under a grab, as `PanelMenu.Button` does) | `ui/panelMenu.js` |
| `Main.panel.addToStatusArea`, `PanelMenu.Button` (top bar icon while the island is hidden) | `ui/panel.js:935`, `ui/panelMenu.js` |
| `getMixerControl()`: the shared Gvc mixer behind Quick Settings' volume sliders (through `shell/mixer.js`); also the Media tab's volume row | `ui/status/volume.js:24` |
| `Slider` (signals `drag-begin`/`drag-end`, `value`) and `BarLevel` (style properties `-barlevel-*`, `-slider-handle-radius`): Media's timeline and volume | `ui/slider.js`, `ui/barLevel.js` (50) |
| `Spinner` (Media: loading lyrics), `PopupMenu.Switch` (Media: "Find lyrics online") | `ui/animation.js`, `ui/popupMenu.js` (50) |
| `org.gnome.Shell.Extensions.OpenExtensionPrefs` (public D-Bus API of the prefs service); `global.display` `window-created`, `Meta.Window` `shown` / `get_wm_class()`; `Main.activateWindow` | `Shell/Extensions/js/extensionsService.js`, `ui/main.js:878` |
| Attention bar: `Shell.WindowTracker.get_app_from_pid` / `get_window_app`, `Shell.AppSystem.lookup_app`, `Shell.App.get_windows` / `get_name` / `get_id` / `get_app_info`, `global.display` `notify::focus-window` / `focus_window` / `focus_default_window`, `Main.activateWindow`, `Main.overview` `visible` / `showing` / `hidden` | `shell/claudeAttention.js`, `ui/attentionBar.js` (50.1) |
| `Main.sessionMode.isLocked`: set from the new mode before `updated`, on which the extension system disables extensions at a lock (`ui/sessionMode.js` `_sync()`, `ui/extensionSystem.js` `_sessionUpdated()`, 50.1) | `shell/claudeAttention.js` `screenLocked()`: the island keeps the attention bar's state folder through a screen lock only |
| `PopupMenu.PopupMenu`, `PopupMenuManager`, `PopupMenuSection`, `PopupBaseMenuItem` (subclassed; `activate()` overridden so flipping a label does not close the menu, `popupMenu.js:787` in 50.1), `PopupMenuItem`, `Ornament`; `BoxPointer.PopupAnimation`; `Main.uiGroup`. Only in `ui/contextMenu.js` (a note tab's label menu) | `ui/popupMenu.js`, `ui/boxpointer.js`, `ui/main.js` (50.1) |
| `Main.sessionMode.isLocked`: true while extensions are disabled for the lock screen (`unlock-dialog` mode); the Break tab then keeps GNOME's notifications off | `ui/sessionMode.js` (50.1) |
| `global.backend.get_core_idle_monitor()` (as GNOME's own break engine) | `misc/breakManager.js` (50.1) |

### 6.3 Private / internal (isolated in `shell/`)

| API | Why it is needed | Where |
|---|---|---|
| `Main.panel.statusArea.dateMenu._clock` | Listen to the top bar clock's `GnomeDesktop.WallClock` for minute ticks instead of owning one: a WallClock's timer is only removed in dispose, and extensions should not call `run_dispose()`. Without it, `ClockService` falls back to a WallClock of its own | `shell/dateMenu.js` `topBarWallClock()` |
| `Main.panel.statusArea.dateMenu.container.opacity` | Visually replace the top bar clock while keeping its menu usable; read its on-screen bounds (`notify::allocation` on it and its ancestors up to `panelBox`) so the pill covers it | `shell/dateMenu.js` |
| `Main.panel.toggleCalendar()` / `closeCalendar()` (Panel methods, not an extension API) | Open GNOME's own calendar and notification menu from 📅, as Super+V does; close it when the island expands | `shell/dateMenu.js` `CalendarMenu` |
| `Main.panel.statusArea.dateMenu.menu` (`isOpen`, signal `open-state-changed`) | Collapse the island whenever GNOME's menu opens (📅, Super+V); one modal at a time | `shell/dateMenu.js` `CalendarMenu` |
| `Main.panel.statusArea.dateMenu._indicator` (`MessagesIndicator`, its `visible`) | Show GNOME's unread-notifications dot on the pill that covers the clock, with GNOME's own rules | `shell/dateMenu.js` `CalendarMenu` |
| `Main.messageTray.bannerAlignment` / `bannerBlocked` (public setter) | Hold banners back while the expanded island covers their place, as the panel does for an open menu there | `shell/dateMenu.js` `CalendarMenu.holdBanners()` |
| `Main.messageTray` `getSources()`, signals `source-added` / `source-removed` (`ui/messageTray.js` 697-701, 887-901 in 50.1) | Notifications tab: GNOME's own notifications, followed only while the tab is on screen. The Claude attention bar: the Claude app's (and, if asked for, web browsers') notifications, through a store of its own with a `filter`, so other sources get no handler at all | `shell/messageTray.js`, `shell/notificationStore.js` |
| `MessageTray.Source`: `notifications`, `title`, `icon`, signals `notification-added` / `notification-removed` (emitted from inside the notification's `destroy`) | Notifications tab: each app's notifications, its name and icon | `shell/notificationStore.js` |
| `MessageTray.Notification`: `title`, `body`, `use-body-markup`, `gicon`, `datetime`, `urgency`, `acknowledged` (read, and written only on a deliberate act in the tab), `actions[].label`; signals `notify`, `action-added`, `action-removed`; `activate()`, `actions[i].activate()`, `destroy(DISMISSED)` (only on the user's click) | Notifications tab: rows, and the exact calls GNOME's own list makes (`ui/messageList.js` 726-758) | `shell/notificationStore.js` |
| `Main.messageTray._notificationQueue` (private field, read only: `includes()`) | Notifications tab: never mark seen a notification still waiting for its banner. GNOME's dot counts unseen minus queued, and while banners are held it does not drop seen ones from the queue (`_updateState()` returns first), so one marked seen there would be subtracted twice and a later unseen one would light no dot. Without the field, every listed one is marked seen (that lag comes back) | `shell/messageTray.js` (passed to the store as `waitingForBanner`) |
| `MessageTray.Urgency` (`CRITICAL`), `MessageTray.NotificationDestroyedReason` (`DISMISSED`) | Notifications tab: urgent first; dismiss as GNOME's close button does | `shell/messageTray.js` (read when a store is made) |
| `misc/util.js` `fixMarkup`, `misc/dateUtils.js` `formatTimeSpan` | Notifications tab: text and "10 minutes ago" exactly as GNOME's list shows them | `shell/messageTray.js` |
| `Main.messageTray.visible` (`notify::visible`; true while a banner is on screen, `MessageTray._updateState()`) | Hide the Claude attention bar while a banner shows where it is | `shell/claudeAttention.js` `ClaudeDesktop.busy` |
| A notification source's `app` (`FdoNotificationDaemonSource` only; the window-attention source has none) | The attention bar follows only the Claude app's source, and web browsers' (`WebBrowser` category); `describe()` gives the app's id | `shell/claudeAttention.js` `notificationFilter()`, `shell/notificationStore.js` |

| `Main.breakManager`: GNOME's break engine, an internal Shell component exported as a `let` (`main.js:95`) and made at startup in every session (`main.js:271-275`), since GNOME 48. Getters `state`, `currentBreakType`, `nextBreakDueTime`; methods `getNextBreakDue()`, `getCurrentTime()`, `getDurationForBreakType()`, `delayBreak()`, `skipBreak()`, `takeBreak()`; signals `notify::state`, `notify::next-break-due-time`, `notify::last-break-end-time`, `break-due`, `break-finished`, `take-break` | Show and drive GNOME's breaks (Take, Delay, Skip) instead of timing them; the state numbers are checked against the installed Shell by a unit test | `shell/breakManager.js` (the only reader), `shell/breakEngine.js` |
| `Main.breakManager._breakLastEnd`: a private `Map` of break type → last break end | Each type's next break (the public API gives only the earliest one), and telling a delay, a skip or a break taken apart. Without it the tab falls back to the next break only | `shell/breakEngine.js` `read()` |

`statusArea.dateMenu` is a role name set by `PANEL_ITEM_IMPLEMENTATIONS`
(`panel.js:633`). It is widely relied on, but it is not an API contract.

The message tray's objects are exported, but they are not an extension
contract either, and they changed between GNOME 45 and 48 (the
object-param `Notification`; `NotificationMessage` moved from
`calendar.js` to `messageList.js`, with groups). Only
`shell/notificationStore.js` reads or writes them; the feature reaches
them as `ctx.notifications` and never imports `shell/`
([features/notifications.md](features/notifications.md) §9).

### 6.4 Settings window (⚙️)

The expanded island has a ⚙️ button in its top-right corner. It opens the
settings window, a separate window in GNOME Shell's preferences process
with tabs (General, Appearance, Panic buttons, then one per feature tab
in the hub's order: Notifications, Notes, Claude, …). `shell/settingsWindow.js`
works around
three GNOME Shell 46 behaviors found while testing:

- A second `OpenExtensionPrefs` while a window is open fails with "Already
  showing a prefs dialog" (`extensionsService.js`), and
  `Extension.openPreferences()` drops that promise, so the rejection shows
  up as an unhandled rejection. Froonty raises the existing window instead,
  makes the D-Bus call itself, and handles the error.
- The request carries no activation token, so Mutter does not focus the new
  window. Froonty watches `window-created`, and activates the matching
  window once it is `shown`. The watch gives up after 10 s and is removed on
  disable.
- The window has no GTK application id. It is matched by WM class
  (`org.gnome.Shell.Extensions`) and title (the extension name).

The same window also holds the Notes **All notes** page
([features/notes.md](features/notes.md)), a subpage
(`Adw.PreferencesWindow.push_subpage`; the window is GNOME's
`ExtensionPrefsDialog`, an `Adw.PreferencesWindow`):

- The Shell cannot talk to the window, so the page to show travels in the
  internal `settings-window-view` key (`settings` | `all-notes`). The Shell
  sets it before it opens or raises the window (`SettingsWindow.open(view)`);
  the window reads it when it is filled (a subpage pushed before the window
  is first shown, checked by the headless tests) and follows its changes,
  sets it as the user navigates (Settings → Notes → All notes, the back
  arrow), and sets it back to `settings` when it closes on All notes, so the
  Extensions app opens on the settings next time. Its `close-request`
  handler runs after the preferences service's own (which forgets the
  window) and never stops the close.
- The key would outlive a window that never came ("Already showing a
  prefs dialog" while another extension's preferences are open) or went
  without `close-request` (logout, a killed process). With no window of
  Froonty's, the Shell sets it back to `settings`: on enable (login,
  unlock; a window left open through a lock keeps its page) and when the
  10 s wait for a requested window gives up.
- The preferences process exits 2 s after its last window closes
  (`IDLE_SHUTDOWN_TIME`, `dbusService.js`). A note write still pending then
  is cut off; `g_file_replace` keeps the previous file, so at most the last
  0.8 s of typing is lost.

Two St/Clutter rules also shaped the island:

- `Clutter.BinLayout` honors a child's `x_align`/`y_align` only when the
  child expands; otherwise it centers it.
- St never moves focus *into* a focusable widget. The pill therefore stops
  being focusable while expanded, so Tab reaches ⚙️. The modal grab keeps key
  events from the stage, where Tab navigation normally happens, so the pill
  forwards them to `global.focus_manager.navigate_from_event()`.

## 7. Compatibility risks

| Risk | Impact | Mitigation |
|---|---|---|
| `statusArea.dateMenu` renamed or restructured | Clock not hidden; no 📅 (no menu) or no unread dot (no `_indicator`) | All access is in one adapter; optional chaining; no-op if absent |
| Another extension moves or hides the clock | Opacity fight; or `toggleCalendar()` refuses to open while the clock is unmapped, so 📅 does nothing (the island stays open) | `hide-panel-clock` can be turned off; documented |
| GrabHelper semantics change (Clutter grab model changed in 42) | Escape or outside-click stop working | The headless tests cover it and fail loudly |
| Shell 47+ API changes (Clutter.Color removal, St accent colors, `--nested` → `--devkit`) | Porting needed | `metadata.json` declares only `"46"` |
| Panel hidden (e.g. by a hide-top-bar extension) | Island still sits at the top of the monitor | Acceptable; the offset falls back to 0 |
| HiDPI / fractional scaling | Wrong sizes | Scale-factor aware; **not yet verified on real HiDPI hardware** |
| Ubuntu session mode | Ubuntu patches Shell 46 | The tests run the Ubuntu build; `FROONTY_TEST_MODE=ubuntu` runs the Ubuntu session mode |
| Claude Code changes its private usage cache (`cachedUsageUtilization` in `~/.claude.json`) | Claude tab shows the hint instead of rows, or loses a row | Defensive parser that leaves out what it does not know; unit tests pin the format seen in Claude Code 2.1.280 ([features/claude.md](features/claude.md)) |
| livenerf rewords its README or redraws its chart differently | The livenerf row loses its chart or reads "could not be read" | Readers that leave out what they do not know; unit tests run them against the `third_party/livenerf` submodule |
| Claude Code changes its hook events or their fields, or drops the undocumented `worker_permission_prompt` | The attention bar shows less (never wrong text: unknown types are ignored) | Documented events only (except that one, harmless if unknown); unit tests pin the mapping ([features/claude-attention.md](features/claude-attention.md)) |
| The Claude app rewords or translates its notifications | Its entries read "Claude needs your attention" | One small classifier (`appNotificationKind`), unit-tested; the manual checks note the real wording |
| VS Code's window title template changes | Several VS Code windows are not told apart: focus does not clear, a click raises the most recent | Documented known gap |
| Claude Code rewrites `settings.json` from its cached copy | Froonty's hooks disappear | The settings row reads the file again on show and on change; Set up again |
| Flatpak hosts (sandboxed process ids, private runtime folder) and Flatpak browsers (portal notifications) | No attention entries from them | Not supported; documented |
| Media players' MPRIS quirks (wrong types, Position always 0, no `Seeked`, cleared metadata between songs, mirror names) | Wrong or flickering media state | Type-checked decoding, never placeholder text; a 3 s check of a stuck position; a 1.5 s gap hold; mirrors merged by process and song; commands re-validated and sent to the unique owner only ([features/media.md](features/media.md)) |
| Shell `Slider`/`BarLevel` style properties or signals change | Media's timeline or volume looks wrong or stops seeking | All in `features/media/view.js` and `volume.js`; the headless tests drag the slider and check the seek |
| Escape for the open tab first (Media's source list or lyrics) relies on the island's `captured-event` handler running before GrabHelper's, which GrabHelper connects at each grab | Escape closes the island instead of the list | The headless tests check both Escapes |
| Cover art from untrusted players | Large or broken images | Regular files up to 12 MiB, web covers up to 4 MiB and `image/*` only, decoded asynchronously at the shown size; not `St.TextureCache` (keeps a file monitor per file) |
| GNOME 51+ changes its break engine (`Main.breakManager`, its signals, its state numbers) | Break tab wrong or empty | All access in `shell/breakEngine.js`; `metadata.json` declares only `"50"`; a unit test runs GNOME's installed class and checks the state numbers and constants |
| `_breakLastEnd` renamed | Only the next break is listed; delays, skips and taken breaks are not told apart | Fallback mode (unit-tested) |
| The Wellbeing panel's id (`gnome-wellbeing-panel`) renamed | GNOME's break notifications are no longer hidden: reminded twice | The status reads "GNOME's notifications"; the switch's schema is looked up first |
| Froonty removed or failing to load while GNOME's Wellbeing notifications are off | They stay off (GNOME Settings has no switch for them) | `break-gnome-saved` records what was changed; the manual `gsettings reset` line is in Settings → Break and [features/break.md](features/break.md) |

## 8. Lifecycle and resource budget

| Resource | Count | Released in |
|---|---|---|
| Actors | 1 strip (+ children), added as chrome | `Island.destroy()` |
| GObject signal connections | layoutManager ×2, panelBox ×1 (+1 allocation watch), ThemeContext ×1, dateMenu container ×2 + one allocation watch per ancestor (3), the clock's unread indicator ×2 (`notify::visible`, `destroy`), settings ×7, the top bar's WallClock ×2, desktop interface settings ×1 | `disconnectObject()` in each owner's teardown |
| GNOME's date menu (JS signals) | 1 (`open-state-changed`), while the island exists | `CalendarMenu.destroy()` from `Island.destroy()` |
| The pill's `captured-event` | 1, while the island exists: a press, key or scroll in the open island may be deliberate input (the Notifications tab's "seen"; never a modifier alone or a key repeat, and after a hover-open a key only once the focus is inside, a scroll only over the tab's content) | With the pill, in `Island.destroy()` |
| GNOME's notifications | Notifications tab, **only while it is on screen**: `Main.messageTray` ×2 (`source-added`, `source-removed`); per source ×4 (`notification-added`, `notification-removed`, `notify::title`, `notify::icon`); per notification ×3 (`notify`, `action-added`, `action-removed`); one `org.gnome.desktop.notifications` `Gio.Settings` with 2 handlers (kept, without handlers, until the tab is turned off); one handler on the clock service. Hidden: none. No copy is kept | `NotificationsService.setActive(false)` (`NotificationStore.unwatch()`); `stop()` |
| Message tray | `bannerBlocked` set only while the island is expanded (and banners are centered) | collapse; `CalendarMenu.destroy()` |
| Keybinding | 1, for the whole time the extension is enabled | `disable()` |
| Top bar icon | 1, only while the island is hidden | `_syncIsland()` / `disable()` |
| Mixer connections | Per panic button: 2 on the Shell's mixer + 1 on its current stream | `PanicBar.destroy()` |
| GNOME privacy settings | Block-camera panic button only: one `org.gnome.desktop.privacy` `Gio.Settings` per button, with 2 handlers (`changed::disable-camera`, `writable-changed::disable-camera`) | `PanicBar.destroy()` (`CameraAccess.destroy()`) |
| Ctrl+Alt+Tab group | 1 | `Island.destroy()` |
| Resize grip | Its actors and handlers live in the pill (destroyed with it); a stage grab only during a drag; GSettings writes only on release, an arrow key or a double-click | `ResizeGrip.destroy()` from `Island.destroy()` (cancels a drag: no write) |
| Timers / GLib sources | **No periodic timer while the island is closed.** One-shot only: the hover-open delay while the pointer rests on the collapsed pill (`HoverOpen`); a 10 s give-up timeout while a requested settings window has not appeared (`SettingsWindow.destroy()`); Notes' 0.8 s autosave while there are unsaved edits (`NotesService.stop()` flushes and removes it); the Clipboard tab's hidden password expiry (`clipboard-password-minutes`), only while one is listed (`ClipboardRecorder.destroy()`); the Writing tab's per-request timeouts while a request runs (Claude Code 90 s plus 8-15 ms per character, `claude auth status` 10 s, Ollama 180 s plus 60 ms per character overall) and, when it starts Froonty's own Ollama, a chain of 500 ms one-shots for at most 15 s until it answers (all removed when the request ends or `WritingService.stop()` cancels it). **Two periodic timers**, each only while its tab is on screen: the Btop tab's, every `sysmon-interval` seconds (1-10, default 2), and the Kill Process tab's, every `killprocess-interval` seconds (1-10, default 3), both `timeout_add_seconds` so GLib can batch their wakeups (`SysmonService.setActive(false)`, `KillProcessService.setActive(false)`); plus a 5 s give-up timeout per `nvidia-smi` or `kill` run, and the Kill Process tab's one-shot early reading (0.5 s after it comes on screen or a signal is sent, then each second while a killed process is still listed). At most one pending `BEFORE_REDRAW` later (cover recompute), removed in `PanelClock.restore()`; and at most one in the Kill Process list, which fills its rows after a scroll or a new height (never queued while the tab is hidden; removed when it is hidden or its view destroyed). While a Kill Process reading is in flight, at most one idle (`PRIORITY_DEFAULT_IDLE`) at a time between its batches of reads, removed when the reading is cancelled (`KillProcessService.setActive(false)`); the interval's readings are spaced at least ten times as long as the previous one took. The clock ticks come from the top bar's own WallClock, so Froonty owns none | `ClockService.stop()` |
| File watching | Notes: one inotify folder monitor (`Gio.FileMonitor`), only while the Notes tab has been opened. Claude: one monitor on Claude Code's config file while the Claude tab is on screen, and one more while the island is open with the Claude session panic button. Attention bar: one folder monitor (`WATCH_MOVES`) on `$XDG_RUNTIME_DIR/froonty/claude-attention`, while the island exists and the bar is on; per state file event one read of at most 4 KiB; per recorded session one `/proc/<pid>/stat` read on arrival, on each move of the focus to another window while an entry with a known app shows, and on each collapse | `NotesService.stop()`; `ClaudeService.setActive(false)`; `AttentionService.stop()` |
| Attention bar | Signals: message tray `notify::visible`, overview `showing` / `hidden` (adapter, for its life); `org.gnome.desktop.notifications` `changed::show-banners`; 3 settings; tray `source-added` / `source-removed` plus 4 per followed source (the Claude app, browsers) and 3 per followed notification, while those are followed (the Notifications tab's store, with a `filter`; other sources get none); `global.display` `notify::focus-window` only while a shown entry has a known app. One Ctrl+Alt+Tab group, listed only while the bar is mapped. No timer, no process. Disk: the `0700` folder and at most one `0600` file of 4 KiB per waiting session, on tmpfs; kept through a screen lock (what waits survives it), removed by any other disable and when the island or the bar is turned off | `Island.destroy()` (`_stopAttention()`, which also removes the folder unless the screen is locking); turning the bar off also removes the folder |
| Notes: All notes button | 1 `St.Button` in the hub header (with the Notes view; shown only on the Notes tab); its tooltip handler | `NotesView.destroy()`, then `HubHeader.removeActions()` |
| Notes: label menu | Only while open: 1 modal grab (POPUP action mode), 1 `uiGroup` child, 1 focus group, 1 `Main.sessionMode` `updated` handler, 1 `system-modal-opened` handler, 1 `labels-changed` and 1 `changed` handler on the Notes service. Label writes only on user action, rename or create | Destroyed on close, tab switch, collapse, `NotesView.destroy()` (disable, lock, Notes off), `Island.destroy()` (backstop), or its tab going away |
| Settings window (separate process), All notes page | While the page is shown: one folder monitor, up to 8 reads in flight; while its editor has unsaved text, one 0.8 s one-shot timer. The process exits 2 s after its window closes | Page `hidden` and the window's `close-request` |
| Clipboard | Clipboard tab enabled (off by default): one `owner-changed` connection on `global.display.get_selection()`, one settings connection, and one read per copy (`St.Clipboard`); history and images under `~/.local/share/froonty/clipboard` (0700/0600) | `releaseRecorder()` (extension `disable()`, tab turned off) |
| Network monitor | Claude: three connections on the shared `Gio.NetworkMonitor` (`network-changed`, `notify::connectivity`, `notify::network-available`) per active reader: the tab while on screen, the panic button while the island is open. Writing (local builds): the same three while its tab is on screen | `ClaudeService.setActive(false)`; `WritingService.setActive(false)` and `stop()` |
| Calendar tab | Nothing at module load or enable but a one-time probe (GIRepository's typelib list). The service, when the tab is first selected: 4 settings handlers (2 Froonty keys, 2 `org.gnome.desktop.calendar`). Once the tab has been shown: 1 `ESourceRegistry` for the life of the Shell process (neither disposing it, which stops the process's other registries from seeing new calendars, nor letting the garbage collector finalize it, whose dispose then runs the main context and makes GJS drop the JS timeouts due, is safe; no Froonty handler on it while disabled); until disable: 1 `SourceRegistryWatcher` (3 handlers), 1 registry handler, 1 `ECal.Client` per visible calendar (1 handler each). From the first time the tab shows a month until another month or zone (or disable): 1 EDS view per visible calendar (4 handlers each), kept and paused while the tab is not on screen, so opening and closing the island makes **no** EDS call. Each view's `start()` is a **synchronous D-Bus call** to evolution-calendar-factory (libecal offers no other; about 0.3 ms with local calendars), once per calendar and month shown; the months a fast wheel passes through (within 250 ms) get none. Views are never `stop()`ped (also synchronous): they are let go, and libecal disposes of them asynchronously once collected. One asynchronous `get_objects_for_uid` per repeating event (its moved occurrences, which views do not deliver), one `get_timezone` per calendar and unknown zone. Timers: none periodic; one idle to coalesce redraws, one idle shared by every view's expansion (3 ms of work per turn; a series is expanded in slices from a moved start, features/calendar.md §B.6), only while on screen and there is work; a one-shot 250 ms quiet period after a month change; while a calendar loads, redraws at most every 200 ms (a one-shot timeout in place of the idle). libecal, libedataserver, libical(-glib) and libcamel stay mapped once loaded | `CalendarService.stop()` (views let go, in-flight answers cancelled, late views let go, idles and timer removed); `setActive(false)` pauses |
| Network requests | Claude tab, livenerf row: one `Soup.Session`, made on the first fetch; two GETs (about 28 kB) per visit while online, at most once an hour. Writing tab (local builds): one session per engine, made on first use; one LanguageTool POST per click (20 s timeout, at most 10 a minute), Ollama on 127.0.0.1 (a 2 s probe when the tab is shown, a 120 s per-read cap, and an overall cap of 180 s plus 60 ms per character per request). Media: none by default; with its options on, one `Soup.Session` (made on the first such request) for web covers (while shown) and lrclib.net (while the lyrics are open) | `LivenerfService.stop()` (aborts the session); `WritingService.stop()` (cancels the request in flight, aborts the sessions); Media `Fetcher.destroy()` from `MediaService.stop()` |
| File reads | Btop tab, per interval while on screen: `/proc/stat`, `/proc/cpuinfo`, `/proc/meminfo`, `/proc/net/dev`, `/proc/self/mounts`, the CPU's package temperature, a few sysfs files per GPU, and one temperature per core only while the threads are unfolded. Sections that are off are not read. Kill Process tab, per interval while on screen: one listing of `/proc` (with owners), `/proc/stat`, and `/proc/<pid>/stat` for each of the user's processes (256 on the development machine; it also gives the thread count), 32 at a time with a pause between batches so frames are drawn in between; `/proc/<pid>/cmdline` once per process; a handful of small reads (the process, and GNOME Shell's parents) right before each signal | `SysmonService.setActive(false)`, `KillProcessService.setActive(false)` cancel a reading in flight |
| Subprocesses / D-Bus proxies | Btop tab: one `nvidia-smi` per interval while the tab is on screen and an NVIDIA card is awake (about 40 ms). Kill Process tab: one `/usr/bin/kill` per confirmed kill or "Force quit" click, never otherwise. Writing tab (local builds): one `claude -p` per action click (a time limit of 90 s, plus 8 ms per character with Haiku or 15 ms with Sonnet; never started once the click is cancelled), `claude auth status` before the first one each time the tab is shown (10 s), and `systemctl --user start froonty-ollama.service` when Froonty's own Ollama is needed and stopped. Otherwise 0 of Froonty's own. Outside the Shell, after the user's Set up, Claude Code runs Froonty's GJS hook (about 38 ms, 33 MB) per qualifying Notification, Stop and StopFailure, and `sh` (about 1.2 ms) per prompt, model step and session end. The Claude tab reads GIO's process-wide `Gio.NetworkMonitor`, whose NetworkManager backend keeps GIO's own proxy for the life of the Shell | — |
| Media service | One per Shell while held: by the pill (`media-enabled` and `media-show-in-pill` or `media-track-notice`; by default whenever the island exists), the Media tab while on screen, the "Pause all media" button while the island is open. It holds one `NameOwnerChanged` subscription, at most 16 players × 2 proxies (`g-properties-changed` ×2, `g-signal` ×1), one coalescing idle at most, and one-shots: discovery deadline 1 s, gap 1.5 s, chosen-player grace 5 s, cover grace 1.5 s, new-song debounce 0.5 s, pill notice 3 s, seek hold 1 s, stuck-position check 3 s, Up next check 1.5 s, the next lyric line. **Periodic:** the display tick, at most once a second, only while the tab is on screen and the song plays with a length and a position. Position reads only for the shown song while the tab is on screen. One decoded cover kept (plus up to 8 web covers). Volume row: 2 mixer and 2 stream connections while the tab is on screen. Bars: Clutter eases only while playing, shown, and animations are on | `releaseMedia()` → `MediaService.stop()` → `MprisWatcher.stop()`; the tab's `setActive(false)` |
| Memory kept across `disable()` | `ctx.memory.media`: `{chosen, followed, latestPlayed}` (strings) | Shell exit |
| Break tab (off by default) | While `break-enabled` is on, one shared service (`features/break/shared.js`): 6 signal connections on `Main.breakManager`; one `changed` connection on each of GNOME's 5 settings objects it reads (break reminders, eyes, movement, Wellbeing notifications, screen-time limits) and 20 `changed::` on Froonty's; +1 handler on the top bar's WallClock; one Mutter idle watch (10 s) and, while idle, one active watch; at most one one-shot timer (§2, principle 2); two files under `~/.local/share/froonty/break` (0700/0600), written after events, never periodically. The notification takeover (extension-wide): one `changed::selected-breaks` and 3 `changed::` on Froonty's settings. The pill's cue: one connection per cue source | `releaseBreakService()` (extension `disable()`, tab turned off; `BreakService.stop()`); `NotificationTakeover.destroy()` |

## 9. Testing

Two test layers:

- **`make unit`** runs plain-gjs unit tests for Shell-free logic (with a
  private `CLAUDE_CONFIG_DIR`, so the real `~/.claude` is out of reach):
  the Claude attention bar's hook script, run as Claude Code runs it, its
  `settings.json` set-up and its model; the
  Notifications tab's store and service (over GObject fakes of GNOME's
  tray, sources and notifications; a destroyed one throws on any access),
  Notes names, Markdown edits, metadata, labels, search, file store, note
  writer, service and the All notes window's library, the All notes page
  itself (GTK 4 and libadwaita driven through its widgets, `*.gtk.test.js`,
  on a private Broadway display that `tools/unit/run.sh` starts), the panic
  catalog and
  the camera switch (on in-memory GSettings backends or a fake, never the
  real settings), the Claude usage parser and service, the Btop tab's
  parsers, sampler (over a fake `/proc` and `/sys`) and polling lifecycle,
  the Kill Process tab's parsers, safety rules and kill steps over a
  fake `/proc` whose `kill` only records its arguments, and the Calendar
  tab's date math, provider links, colours, event model and service
  over a fake EDS (plus static checks that it never writes to a
  calendar and makes no synchronous call but one `ClientView.start()`),
  its expansion scheduler, and its EDS views over the real libecal with
  a fake calendar (when `gir1.2-ecal-2.0` is installed).
  The Writing tab (local builds) is tested against fakes only: a fake
  `claude`, a local `Soup.Server` for LanguageTool, Ollama and GitHub, a
  fake `systemctl`, and tiny archives (hostile ones too) for Ollama's
  set-up and removal. Then `tools/pack-public/test_pack_public.py` checks
  the public build's leak guard.
  Each run gets a private `TMPDIR` and XDG data, config, cache and runtime
  folders, so trashed test files never reach the real Trash and no test
  touches the real `~/.config/systemd/user` or Froonty's own folders.
- **`make test`** (`tools/headless-test/run.sh`) starts a **fully isolated
  headless GNOME Shell 46**, once in the default session mode and once in
  Ubuntu's (with the Yaru theme, Ubuntu Dock, DING, AppIndicators and Tiling
  Assistant loaded). Layout bugs can depend on the theme, and several showed
  only under Yaru. Isolation:
  - private session bus
  - private *empty* system bus, so no real logind, GDM or lock signals are
    touched
  - private XDG dirs and keyfile GSettings backend
  - two virtual monitors
  - a private PipeWire with a virtual speaker and microphone.
    WirePlumber's ALSA, Bluetooth and camera monitors are disabled, and a
    guard skips every mute check unless all visible audio devices are test
    devices.

The checks are loaded via `org.gnome.Shell.Eval`, which a test-only helper
extension enables inside that session. They drive real pointer and keyboard
input through Clutter virtual devices and cover:

- **Island:** placement, top bar clock coverage, expand/collapse by click,
  keyboard, shortcut and hover, the modal grab, and a real primary-monitor
  switch.
- **Hub:** the tab column and its tooltips; lazy feature creation and
  activation, tested with a fake feature, including its header button
  (between 📅 and ⚙️, only while its tab is active, named in the tooltip,
  destroyed with the view).
- **Panic buttons:** real mute and unmute, following changes made elsewhere,
  and the settings rules. Block camera: click and keyboard toggle GNOME's
  `disable-camera` in the private keyfile backend (checked to be private
  first), changes made elsewhere, and no handler left after removal.
- **Notes:**
  - create, type, autosave, formatting, rename, Trash, colours, tabs (and
    no colour dot in them);
  - long-note scrolling and line wrap;
  - pixel checks that text is really visible, not just scrolled to;
  - labels: right-click, Menu and Shift+F10 open a GNOME menu under the
    tab, which neither selects nor renames it; typing and Enter add a label
    to `.froonty-labels.json`, a click removes it, the menu stays open
    through folder events, Escape gives the grab and the focus back;
    disabling with the menu open leaves no menu, grab or handler;
  - the "All notes" button: only on the Notes tab, between 📅 and ⚙️, Tab
    order, its tint following the note's colour (read from the theme node)
    and deepening on hover and focus, the island growing so the panic bar
    stays clear with four panic buttons at the narrowest width;
  - the All notes window end to end: opened on that page (and raised, and
    sent back to the settings by ⚙️), typing saved and seen by the island,
    an edit elsewhere during typing kept as "e2e (conflict)" and shown in
    the island's tab row, the window following the island's note when
    raised from another one, a note made by another program getting its
    tab at once, the view key back to `settings` when it closes, reset on
    enable without a window, kept through a lock with one, and reset when
    no window comes;
  - without panic buttons, an expand reports its size at most once and
    settles within the animation.
- **Unit tests** cover labels, search (accents only, folded strings
  kept, excerpts on demand), the note writer (etag checks, conflict copies
  and their labels, a touched file, stop, failed writes, read-only notes),
  the service's labels, races, failed saves, read-only notes, an
  unreadable `.froonty.json` and notes appearing elsewhere, the window's
  library (reads only changed notes, never writes `.froonty.json`, renames
  during a listing, folder changes) and the All notes page (search, chips,
  All/Any, Clear, the Labels menu, Enter, failed saves, folder changes,
  following the island, read-only notes).
- **Claude:** rows and wording from a private `CLAUDE_CONFIG_DIR`, live
  updates while shown, "Unknown" offline, nothing watched while collapsed,
  a fresh read on reopening.
- **Notifications:** GNOME's notifications from the test's own sources
  (and three sent over `org.freedesktop.Notifications`): order, rows,
  markup, nothing watched while hidden, live arrivals and updates,
  "seen" only on a deliberate act (hover-open marks nothing), the dot on
  the tab, a row click, actions, ×, the keyboard, the two-step Clear
  all, Do Not Disturb, `ActionInvoked` / `NotificationClosed` over D-Bus,
  five rounds that remove nothing, and no handler left after disable;
  and the accidents (`testNotificationSafeguards`): keys, modifiers and
  scrolls after a hover-open, a double click on ×, a held Delete, a
  double Enter on Clear all, an update over D-Bus while "Clear N?" waits,
  GNOME's rule for a click without a default action, and the dot while
  banners are held
  ([features/notifications.md](features/notifications.md) §8).
- **Claude attention bar:** Froonty's real hook script run as Claude Code
  runs it, and the clear command; the bar's place and wording, order, ×,
  Delete, Escape and Ctrl+Alt+Tab; hidden while the island is open, under
  a banner, under Do Not Disturb and in the overview; a session's window
  found from its processes, raised by a click, and clearing it when
  focused; a test app with three windows standing for a terminal (which
  window is known for sure, what shows while another of its windows has
  the focus, what a focus change clears, a crashed Claude Code found on
  a focus change and on a collapse); a collapse cut short by a geometry
  change; real notifications posing as the Claude app and a browser;
  turning it off and on; a screen lock keeping what waits, and Froonty or
  the island turned off removing it
  ([features/claude-attention.md](features/claude-attention.md) §10).
- **Media:** fake MPRIS players as processes on the private session bus
  (`tools/headless-test/fake-mpris.js`), with test-only `.desktop` files
  for a music player and a browser: the tab, cover pixels and tint,
  transport by pointer and keyboard, slider seeks, the tick, `Seeked`,
  failures, a restarted player, the source list and the automatic choice,
  gaps, extras sizes, the pill's music, notice, swipes and bars, web
  covers off and on (a local fake server), Up next, lyrics (lrclib against
  a local fake), the volume row, "Pause all media", and 25 cycles with
  music playing. `make unit` runs the MPRIS client against fakes on a
  private dbus-daemon.
- **Writing** (local builds; [features/writing.md](features/writing.md) §8):
  off by default; the empty state and its "Open Settings → Writing"
  (the window opens on that page); a Claude Code rewrite through a fake
  `claude` with the exact argv, the private folder, no API key and the
  text on stdin; hostile text; errors; an API-billing sign-in refused;
  Cancel and a disable stopping a hanging run; From clipboard and the
  hidden password; LanguageTool and Ollama against a `Soup.Server` inside
  the Shell under test; engines switched off leaving the tab. Every
  address and command it could reach is a fake or refused. After its
  review (`testWritingFixes`): back online while shown, Ollama's
  not-ready reasons, the caret after a long Ctrl+V paste, a result's
  selection kept while typing, the hidden password pasted into a sentence
  refused, and no engine switch mid-run.
- **Break:** GNOME's real break engine in the test Shell (its settings in
  the private keyfile, checked first): the offer, a due cue with no grab,
  Take/Delay/Skip, escalation, a real 12 s away counted, GNOME's
  notifications off and given back (lock rule simulated by replacing
  `_isSessionLocked()`), the sit/stand switch and panic button, the state
  file's modes, a pixel check of a mirrored exercise picture. Unit tests run
  GNOME's own `BreakManager`, extracted from the installed Shell, on a fake
  timeline ([features/break.md](features/break.md)).
- **Kill Process:** protected rows (GNOME Shell, its parent, D-Bus);
  a `sleep` the test started killed through the two-step UI (SIGTERM),
  one that ignores SIGTERM ended by "Force quit" (SIGKILL); a reused
  process id refused; a process whose main thread exited still listed;
  readings in batches that leave room for frames; the keyboard never
  acting on a row out of sight and a click never holding the list (over
  a fake service that only records); no reading, and no row filled, while
  hidden. Only processes the test spawned are ever clicked.
  process id refused; no reading while hidden. Only processes the test
  spawned are ever clicked.
- **Calendar tab** (over the test session's own, private Evolution Data
  Server, checked private first): the hint without the bindings; test
  calendars and events written by the test (a daily series with an
  excluded and a moved occurrence, a cancelled event in an Exchange-style
  zone, all-day, now, next); colours, Now/Next, the series as EDS expands
  it; live addition, rename and removal; calendars added, hidden in
  Froonty and unticked in GNOME; navigation and keyboard; links (nothing
  launched); the EDS views kept and paused while collapsed, and let go
  without `stop()` on another month; EDS's files unchanged by Froonty; a
  large calendar (50 series begun years ago, minutely and hourly ones,
  120 events in an unknown zone) with every expansion turn under a
  frame; disable while loading
  ([features/calendar.md](features/calendar.md) §B.8).
- **Settings window:** open, raise instead of duplicating, focus; its All
  notes page (above).
- **GNOME's calendar and notification menu:** 📅 by pointer and keyboard,
  Super+V over the open island, one modal grab at a time, the menu above
  the island and taking clicks, the unread dot from a test notification
  source (seen, Do Not Disturb, removed), banners held while expanded, and
  the date menu's handlers across disable/enable
  ([features/calendar.md](features/calendar.md) §A.6).
- **Startup:** with `start-at-login` off, a simulated login waits behind the
  top bar icon, a lock/unlock keeps the state, and the icon or the shortcut
  starts Froonty.
- **Lifecycle:** 25 enable/disable cycles, some mid-animation (with the
  Notifications tab on screen), with a before/after "Shell footprint". It
  covers actors, chrome, Ctrl+Alt+Tab, keybindings, the modal count, top
  bar entries, and handler counts on every signal source (including the
  Shell's mixer and the message tray). The checks prove these counts are
  sensitive.

`run.sh` exits non-zero on any failed check, missing results, or Froonty
error in the Shell log. Screenshots are kept with `--keep`.

Release candidate 0.2.0-rc1: **139/139** in both session modes, plus 39
unit tests.

Release candidate 0.2.0-rc2 (GNOME Shell 50.1; start at login, Claude tab,
its cloud session credits and panic button): **176/176** in both session
modes, plus 59 unit tests.

Release candidate 0.2.1-rc1 (the Claude tab's livenerf row and chart):
**178/178** in both session modes, plus 73 unit tests.

Release candidate 0.3.0-rc0 (the Btop tab, one tab column, fresh Claude
usage, Notes size settings): **201/201** in both session modes, plus 136
unit tests.

Release candidate 0.3.0-rc1 (no Shexli findings: the clock follows the top
bar's WallClock, helpers are widget subclasses): **202/202** in both
session modes, plus 136 unit tests.

Release candidate 0.4.0-rc0 (the Clipboard tab with hidden passwords and
paste as plain text, larger tab icons, the Btop scroll fix): **213/213**
in both session modes, plus 159 unit tests.

The Ubuntu run found a **GNOME Shell 46 race** in `ui/extensionSystem.js`:

- `enable/disableExtension()` write two keys, and each write starts an async
  `_onEnabledExtensionsChanged()`.
- Each run awaits the disable/re-enable ("rebasing") of every extension
  loaded after the toggled one. It only then assigns `_enabledExtensions`.
- A toggle issued before all of that finishes can be silently dropped.

This is not a Froonty defect, and normal users are very unlikely to toggle
that fast. The harness therefore waits until the extension manager has been
quiet for 500 ms after every toggle.

Also noted: when Froonty loads before other extensions, toggling Froonty
disables and re-enables all of them. This is standard Shell 46 behavior, and
it makes a leak-free `disable()` matter even more.

**Not yet verified**:

- a real (non-headless) Wayland session
- a real X11 session (this machine's current session is X11)
- real suspend/resume. This relies on WallClock's `TFD_TIMER_CANCEL_ON_SET`
  behavior, which is what GNOME's own clock uses.
- physical monitor hotplug
- HiDPI or fractional scaling

## 10. Later phases: facilities to reuse (verified present in 46)

| Phase | Reuse |
|---|---|
| 3 Notifications | **Done:** `Main.panel.toggleCalendar()` (📅), the clock's unread dot, `MessageTray.bannerBlocked` (public setter) while expanded (§5); the Notifications tab over `Main.messageTray` `getSources()` / `source-added` / `source-removed`, observe only, never destroying on its own ([features/notifications.md](features/notifications.md)). Not needed: `Source` `notification-request-banner` (GNOME's own banner logic) |
| 4 MPRIS | **Done** as the Media tab ([features/media.md](features/media.md)): own async `Gio.DBusProxy`s on unique names with `NameOwnerChanged` (not `ui/mpris.js` `MprisPlayer`, which has no teardown) |
| 5 Battery | UPower DisplayDevice (`/org/freedesktop/UPower/devices/DisplayDevice`), as `ui/status/system.js` does; `UPowerGlib` is already loaded by the Shell |
| 5 Volume/OSD | `ui/status/volume.js` `getMixerControl()` (shared Gvc mixer; already used by the panic buttons); `Main.osdWindowManager` |
| 6 Weather | `misc/weather.js` `WeatherClient`; off by default |
| 7 Metrics | No GNOME equivalent. Done as the Btop tab ([features/sysmon.md](features/sysmon.md)): async `/proc` and `/sys` reads only while visible, with a configurable interval |
