# Froonty design notes

Target: GNOME Shell 46 on Ubuntu 24.04, Wayland first. This document records
what was inspected, what was decided and why, and every GNOME Shell API
Froonty depends on.

## 1. Verified environment

| Component | Version on the development machine |
|---|---|
| Ubuntu | 24.04.5 LTS |
| GNOME Shell | 46.0 (Ubuntu build, includes Ubuntu patches) |
| Mutter | 46.2 |
| GJS | 1.80.2 |
| libadwaita (prefs) | 1.5.0 |

All GNOME Shell source references below are to the JavaScript **extracted from
the installed binary** (`/usr/lib/gnome-shell/libshell-14.so` gresource), not
to upstream `main`, so they match exactly what runs on Ubuntu 24.04.

To re-extract:

```sh
for r in $(/usr/bin/gresource list /usr/lib/gnome-shell/libshell-14.so); do
    mkdir -p "gs46$(dirname "$r")"
    /usr/bin/gresource extract /usr/lib/gnome-shell/libshell-14.so "$r" > "gs46$r"
done
```

## 2. Principles

1. Reuse GNOME Shell facilities; never duplicate a store, a daemon or a
   calendar that GNOME already has.
2. Event-driven. No polling loop exists. A timer may only be
   added with a written justification and a configurable interval.
3. No subprocesses, no network access, no background process.
4. Every private Shell API is listed in section 6 and isolated in `shell/`.
5. `disable()` undoes everything `enable()` did. GNOME Shell 46 calls
   `disable()` on every screen lock (default `session-modes` is `["user"]`,
   `ui/extensionSystem.js:440`), so this path runs many times a day.

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
| Notifications | `source-added` + `notification-added`; hides `Main.messageTray._bannerBin` (never re-shown in 46); **calls `notification.destroy()` after N s**, which deletes it from GNOME's history | Signals exist; behavior harmful | `Source` `notification-request-banner`, `MessageTray.bannerBlocked`, object-param `Notification` (46 already uses `new Notification({source, title, body})`) | **Rewrite** in Phase 3: observe only, never destroy, respect urgency and policy |
| MPRIS | Own synchronous proxies with name watching | Works, but blocks the compositor thread at startup | `ui/mpris.js` exports `MprisPlayer` | **Rewrite** in Phase 4 with async proxies or `MprisPlayer` |
| Calendar | Own month grid; CalendarServer D-Bus; Google Tasks over REST with OAuth | Heavy; duplicates GNOME | `DateMenuButton` (the whole menu), `Calendar.Calendar`, `DBusEventSource` | **Discard.** Open GNOME's own menu (§5) |
| Weather | Soup + wttr.in, always on, every 30 min | Works | `misc/weather.js` `WeatherClient` (GWeather; same locations as GNOME Weather) | **Discard** the fetcher and reuse `WeatherClient` in Phase 6, off by default |
| Quick actions | `loginctl`/`systemctl` subprocesses; polls `pactl`, `fuser`, `upower` every 15 s | Spawns processes | `misc/systemActions.js` `getDefault()`; `ui/status/*` | **Discard** the polling; use SystemActions if needed |
| System metrics | Synchronous `/proc` reads every 1 s while visible, 3 s otherwise, never stopped | Works | Nothing equivalent | Phase 7 only: async reads, only while visible, configurable interval |

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
strip  St.Widget, full monitor width, reactive only while expanded
 └ pill  St.Button (click + Enter/Space + a11y), clip_to_allocation
    └ content  BinLayout: CollapsedView | Hub (cross-faded)
```

The hub (`ui/hub.js`) is the expanded content:

```
hub     BinLayout, reactive (stops clicks from reaching the pill)
 ├ main     [tab column (GridLayout, TAB_COLUMNS = 1)] [header ⚙️ / content]
 ├ panic    panic bar, centered across the island (click-through layer)
 └ overlay  tooltips (click-through, fixed positions)
```

- `Main.layoutManager.addChrome(strip, {affectsInputRegion: false, trackFullscreen: true})`
  places the strip above the panel and below popup menus. It is hidden over
  fullscreen windows, exactly like the panel.
- `Main.layoutManager.trackChrome(pill, {affectsInputRegion: true})` means only
  the pill takes input on X11. On Wayland the strip is click-through while
  collapsed because it is non-reactive.
- The strip's `BinLayout` keeps the pill centered while its width is eased,
  so no JavaScript runs per frame.
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
- Phase 3 plan: an island action calls `Main.panel.toggleCalendar()` *after*
  releasing Froonty's own grab. GNOME's menu then opens with its arrow
  pointing at top center, below the island. It needs no re-anchoring and no
  private menu internals. GNOME keeps full ownership of notification storage,
  actions, DND, the calendar, world clocks and weather.
- A popup menu is raised to the top of `uiGroup` on open
  (`popupMenu.js:982`), so the menu draws above the island.

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
| `Gio.File` async I/O, `Gio.FileMonitor` | Notes: Markdown files, folder watching |
| `Meta.KeyBindingFlags`, `Shell.ActionMode` | Keybinding |
| `Adw` 1.5, `Gtk` 4 | Preferences |

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
| `global.focus_manager.navigate_from_event` (Tab navigation under a grab, as `PanelMenu.Button` does) | `ui/panelMenu.js` |
| `Main.panel.addToStatusArea`, `PanelMenu.Button` (top bar icon while the island is hidden) | `ui/panel.js:935`, `ui/panelMenu.js` |
| `getMixerControl()`: the shared Gvc mixer behind Quick Settings' volume sliders (through `shell/mixer.js`) | `ui/status/volume.js:24` |
| `org.gnome.Shell.Extensions.OpenExtensionPrefs` (public D-Bus API of the prefs service); `global.display` `window-created`, `Meta.Window` `shown` / `get_wm_class()`; `Main.activateWindow` | `Shell/Extensions/js/extensionsService.js`, `ui/main.js:878` |

### 6.3 Private / internal (isolated in `shell/`)

| API | Why it is needed | Where |
|---|---|---|
| `Main.panel.statusArea.dateMenu.container.opacity` | Visually replace the top bar clock while keeping its menu usable; read its on-screen bounds (`notify::allocation` on it and its ancestors up to `panelBox`) so the pill covers it | `shell/dateMenu.js` |
| (Phase 3) `Main.panel.toggleCalendar()` | Open GNOME's own calendar/notification menu | will live in `shell/dateMenu.js` |

`statusArea.dateMenu` is a role name set by `PANEL_ITEM_IMPLEMENTATIONS`
(`panel.js:633`). It is widely relied on, but it is not an API contract.

### 6.4 Settings window (⚙️)

The expanded island has a ⚙️ button in its top-right corner. It opens the
settings window, a separate window in GNOME Shell's preferences process
with tabs (General, Appearance, Panic buttons, Notes). `shell/settingsWindow.js`
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
| `statusArea.dateMenu` renamed or restructured | Clock not hidden; Phase 3 menu entry breaks | All access is in one adapter; optional chaining; no-op if absent |
| Another extension moves or hides the clock | Opacity fight; or `toggleCalendar()` refuses to open while the clock is unmapped | `hide-panel-clock` can be turned off; documented |
| GrabHelper semantics change (Clutter grab model changed in 42) | Escape or outside-click stop working | The headless tests cover it and fail loudly |
| Shell 47+ API changes (Clutter.Color removal, St accent colors, `--nested` → `--devkit`) | Porting needed | `metadata.json` declares only `"46"` |
| Panel hidden (e.g. by a hide-top-bar extension) | Island still sits at the top of the monitor | Acceptable; the offset falls back to 0 |
| HiDPI / fractional scaling | Wrong sizes | Scale-factor aware; **not yet verified on real HiDPI hardware** |
| Ubuntu session mode | Ubuntu patches Shell 46 | The tests run the Ubuntu build; `FROONTY_TEST_MODE=ubuntu` runs the Ubuntu session mode |

## 8. Lifecycle and resource budget

| Resource | Count | Released in |
|---|---|---|
| Actors | 1 strip (+ children), added as chrome | `Island.destroy()` |
| GObject signal connections | layoutManager ×2, panelBox ×1 (+1 allocation watch), ThemeContext ×1, dateMenu container ×2 + one allocation watch per ancestor (3), settings ×7, WallClock ×2, desktop interface settings ×1 | `disconnectObject()` in each owner's teardown |
| Keybinding | 1, for the whole time the extension is enabled | `disable()` |
| Top bar icon | 1, only while the island is hidden | `_syncIsland()` / `disable()` |
| Mixer connections | Per panic button: 2 on the Shell's mixer + 1 on its current stream | `PanicBar.destroy()` |
| Ctrl+Alt+Tab group | 1 | `Island.destroy()` |
| Timers / GLib sources | **No periodic timers.** One-shot only: the hover-open delay while the pointer rests on the collapsed pill (`HoverOpen`); a 10 s give-up timeout while a requested settings window has not appeared (`SettingsWindow.destroy()`); Notes' 0.8 s autosave while there are unsaved edits (`NotesService.stop()` flushes and removes it). At most one pending `BEFORE_REDRAW` later (cover recompute), removed in `PanelClock.restore()`. WallClock's internal timerfd is removed with `run_dispose()` | `ClockService.stop()` |
| File watching | Notes: one inotify folder monitor (`Gio.FileMonitor`), only while the Notes tab has been opened | `NotesService.stop()` |
| Subprocesses / network / D-Bus proxies | 0 | — |

## 9. Testing

Two test layers:

- **`make unit`** runs plain-gjs unit tests for Shell-free logic: Notes names,
  Markdown edits, metadata, file store and service, and the panic catalog.
  Each run gets a private `TMPDIR` and `XDG_DATA_HOME`, so trashed test files
  never reach the real Trash.
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
  activation, tested with a fake feature.
- **Panic buttons:** real mute and unmute, following changes made elsewhere,
  and the settings rules.
- **Notes:**
  - create, type, autosave, formatting, rename, Trash, colours, tabs;
  - long-note scrolling and line wrap;
  - pixel checks that text is really visible, not just scrolled to.
- **Settings window:** open, raise instead of duplicating, focus.
- **Lifecycle:** 25 enable/disable cycles, some mid-animation, with a
  before/after "Shell footprint". It covers actors, chrome, Ctrl+Alt+Tab,
  keybindings, the modal count, top bar entries, and handler counts on every
  signal source (including the Shell's mixer). The checks prove these counts
  are sensitive.

`run.sh` exits non-zero on any failed check, missing results, or Froonty
error in the Shell log. Screenshots are kept with `--keep`.

Release candidate 0.2.0-rc1: **139/139** in both session modes, plus 39
unit tests.

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
| 3 Notifications | `Main.messageTray` `source-added`; `Source` `notification-request-banner` (the signal GNOME's own banner logic uses); `MessageTray.bannerBlocked` (public setter); `Main.panel.toggleCalendar()` |
| 4 MPRIS | `ui/mpris.js` `MprisPlayer`, or async `Gio.DBusProxy` with `NameOwnerChanged` |
| 5 Battery | UPower DisplayDevice (`/org/freedesktop/UPower/devices/DisplayDevice`), as `ui/status/system.js` does; `UPowerGlib` is already loaded by the Shell |
| 5 Volume/OSD | `ui/status/volume.js` `getMixerControl()` (shared Gvc mixer; already used by the panic buttons); `Main.osdWindowManager` |
| 6 Weather | `misc/weather.js` `WeatherClient`; off by default |
| 7 Metrics | No GNOME equivalent. Async `/proc` reads only while visible, with a configurable interval |
