# Feature: Software brightness

Status: **implemented**, 2026-10-06, from a contributed patch
(`Froonty_software_brightness.patch`, reworked before merging; §6).
**Off by default.**

A second brightness slider in Quick Settings, under GNOME's, for monitors
whose brightness GNOME cannot set: a monitor that `ddcutil` sees but that
reports DDC/CI as unsupported (some Samsung Smart Monitors), or one behind
an adapter that does not pass DDC/CI through. Froonty darkens those
monitors with a neutral dimming layer.

It is software dimming: the backlight stays as it is, so it saves no
power.

## 1. Use

Settings → Brightness → **Software brightness** on. The slider then sits
right under GNOME's brightness slider in Quick Settings (where GNOME has
one; on a desktop without a backlight GNOME shows none, and Froonty's
slider takes that place). Its icon is a monitor, not GNOME's sun, so it
does not look like the laptop screen's own slider above it: one monitor
for **External monitors**, a computer for **Built-in screen**, two
monitors for **All monitors**. The arrow at its right opens its menu,
as GNOME's sliders do: **Brightness** (the same level as the slider),
Night Light when GNOME shows no brightness slider of its own (§7), and
**Brightness Settings**, Froonty's page.

With a laptop open beside the monitors it dims, they join GNOME's
brightness slider instead and Froonty's slider hides (§8).

- **Monitors:** **External monitors** (the default): every monitor but a
  laptop's built-in screen, so on a desktop all of them. **Built-in
  screen**: only the laptop's own screen. **All monitors**.
- **Lowest brightness (%):** the slider's left end, 10 % by default
  (5-90 %), so a screen never goes black. It is a floor, not an extra
  dimming control: raising it only changes the picture if the current
  Quick Settings level is below the new floor.

The slider at its right end (100 %) puts no dimming layer on screen.

## 2. Warmth comes from Night Light

Software brightness only dims, with a neutral black layer: source-over
black attenuates every channel without lifting black levels. It had an
optional amber overlay ("Warm tint") until 2026-11-20, when it was
removed (owner: Night Light's warmth is all that's needed). An overlay
tints even dark colors; GNOME's Night Light changes the display's color
temperature instead
([GNOME help](https://help.gnome.org/gnome-help/display-night-light.html)).
Its switch and warmth are in the brightness menu (§7). A stored
`brightness-warmth` value from before is left in dconf and unused.

## 3. How it works

`features/brightness/overlay.js`, an extension part (made by
`extension.js` from `registry.js`'s `PARTS`): it lives while
Froonty runs and follows `brightness-enabled` itself.

- **The layers:** one `St.Widget` on `global.stage` (not `uiGroup`),
  holding the dimming layer: per monitor, black at an opacity of
  255 × (100 − level) / 100. The stage layer is raised whenever
  something is added, so it stays over the top bar, the island, menus
  and notifications.
- **The pointer:** the layer is not reactive and is hidden from picking
  (`Shell.util_set_hidden_from_pick`), so clicks and hover go through.
  GNOME's pointer is not a stage actor (on Wayland usually a hardware
  cursor plane), so it should stay undimmed (§4: not yet checked on
  screen). Nothing tracks the pointer or draws a
  copy of it, as some brightness extensions do.
- **Built-in or external:** Mutter says which monitor is a built-in panel
  (`Meta.Monitor.is_builtin()`, through
  `global.backend.get_monitor_manager().get_logical_monitors()`); a
  logical monitor's number is its index in `Main.layoutManager.monitors`.
  Not "the primary monitor": an external monitor is often the primary one.
- **The slider:** a `QuickSlider` placed by `shell/quickSettings.js`
  under GNOME's (`Main.panel.statusArea.quickSettings._brightness`,
  private; it waits up to 5 s for GNOME to make its items after login,
  then adds the slider at the end). It spans the minimum to 100 % and
  writes whole percents to `brightness-level`.
- **Monitors added or removed:** `Main.layoutManager` `monitors-changed`.
- **Screenshots:** `Shell.Screenshot` paints the stage again, layer and
  all. Its `screenshot`, `screenshot_area`, `screenshot_stage_to_content`
  (Print and the screenshot UI) and `pick_color` are wrapped
  (`InjectionManager`) to hide the layer until they finish, so a
  screenshot has the real colours. Print paints offscreen at once, so
  nothing changes on screen; the D-Bus API used by other screenshot tools
  waits for the next frame, which then shows undimmed. Window shots paint
  only the window and are not wrapped.

Pure logic (targets, opacities, the slider's scale) is in
`features/brightness/levels.js`, unit-tested in
`tools/unit/brightness.test.js`; Night Light's schedule steps and All day
in `schedule.js`, unit-tested in `tools/unit/brightness-schedule.test.js`.

## 4. Settings

| Key | Default | |
|---|---|---|
| `brightness-enabled` | `false` | The feature |
| `brightness-level` | 100 | The level, in percent (0-100; never applied below the minimum) |
| `brightness-min` | 10 | The slider's left end (5-90) |
| `brightness-monitors` | `external` | `external`, `built-in` or `all` |
| `brightness-night-light-menu` | `true` | Night Light in GNOME's brightness menu (§7) |
| `brightness-night-light-all-day` | `false` | All day in that menu (§7) |
| `brightness-night-light-schedule` | `(20.0, 6.0, false)` | The schedule All day put aside: From, To, sunset to sunrise |

## 5. Limits

- **The lock screen is not dimmed:** GNOME disables extensions while the
  screen is locked, so the layer goes with them and comes back on unlock.
- **Screen casts and screen sharing** show the dimmed picture: they record
  what reaches the screen. Screenshots do not (§3).
- **Keyboard brightness keys** reach the dimmed monitors only while they
  are part of GNOME's slider (§8); otherwise they drive GNOME's alone.
- **One level for every dimmed monitor.**
- **Not yet tried on real hardware:** the headless tests use virtual
  monitors (none built-in) and check the layer's geometry, opacity,
  picking and lifecycle, not what reaches the screen. Still to check by
  hand (`make devkit`, then a real session): the slider's look, that the
  pointer stays undimmed, and a fullscreen video or game (if Mutter scans
  a fullscreen window out directly, the layer might not show over it).

## 6. Changes from the contributed patch

The patch (written against 0.9.0-rc0, with a full snapshot of the
project, `Froonty_0.9.0_rc0_software_brightness.zip`, that differed from
0.9.0-rc0 only by the patch) was reworked:

- **Leak:** a `QuickSlider` always has a menu, which Quick Settings puts
  in an overlay of its own; destroying only the slider left that menu
  behind at every screen lock. Both go now (a headless check counts them).
- **Built-in** meant the primary monitor, and **External** every other
  one: wrong on a laptop whose external monitor is primary. Mutter's
  `is_builtin()` decides now.
- **Placement:** `insertItemBefore()` under GNOME's slider, instead of
  appending the item and then moving it inside the private grid.
- **The layer** is made only while the feature is on, not whenever
  Froonty runs.
- **The slider** spans the minimum to 100 %, instead of clamping a value
  dragged below the minimum (which left the knob where it was dropped).
- Levels in whole percent (`brightness-level`, `brightness-min`) instead
  of 0-1 doubles; the keys were never released, so nothing migrates.
- Unit tests and a headless check, which the patch had none of.

## 7. Night Light in the brightness menu

Added 2026-11-20 (user request: Night Light and its warmth in a small
menu from the brightness slider, like Sound Output, instead of a tile).
Settings → Brightness → **Night Light in the brightness menu**, on by
default (`brightness-night-light-menu`). It is independent of Software
brightness.

- **The menu:** GNOME's brightness slider has a menu of its own (a slider
  per monitor) but shows its arrow only with more than one monitor scale
  (`ui/status/brightness.js`). Froonty turns the arrow on and adds, under
  GNOME's sliders, a **Night Light** switch, a **Warmth** slider, the
  schedule (**All day**, **From**, **To**) and **Display Settings**. Where GNOME shows no brightness slider (no
  backlight: a desktop, or the devkit's nested Shell), Night Light's
  items go in Software brightness's menu instead, above its Brightness
  Settings, if Software brightness is on. The switch is `night-light-enabled` and the
  slider `night-light-temperature` in
  `org.gnome.settings-daemon.plugins.color`, so GNOME Settings and the
  menu always agree.
- **Warmth:** 6500 K at the left to 1700 K at the right, in 100 K steps
  (`levels.js`). GNOME Settings' Color Temperature runs the same way but
  stops at 4700 K; the owner asked for less warmth than that (2026-11-23),
  and 6500 K is neutral (no warming). The key takes any value; Settings
  shows one above 4700 K at its left end. As in Settings, it shows only while Night Light is on and
  inside its schedule; outside it, the slider stores the warmth for the
  next evening and changes nothing on screen. All day is the way to see
  it in daytime.
- **Switches** (Night Light, All day) flip in place: a GNOME menu item's
  activation closes the whole menu (`PopupMenuBase.itemActivated`), which
  closed it at every flip (reported 2026-11-23); `testNightLightSwitches`
  checks it with the section put in Software brightness's menu by hand.
- **From and To** (added 2026-11-23, user request: adjust the warmth in
  daytime, with the times in the menu): `night-light-schedule-from` and
  `-to`, hours from midnight (20.5 is 20:30). Each has hours and minutes
  between − and + buttons; hours step by 1 round midnight, minutes to
  the next multiple of 5 round the hour (`schedule.js`). With
  `night-light-schedule-automatic` on (sunset to sunrise, from GNOME
  Settings), the times are hidden and the menu says "Sunset to sunrise".
- **All day:** GNOME keeps Night Light on all day when From equals To
  (`gsd_night_light_frac_day_is_between` in gnome-settings-daemon).
  Turning All day on saves From, To and sunset to sunrise in
  `brightness-night-light-schedule`, turns sunset to sunrise off and sets
  To to From; the times then show dimmed (what comes back). Off restores
  the saved schedule. It stays on until turned off, across restarts. If
  the schedule is changed elsewhere (GNOME Settings), even while
  Froonty is off, All day ends and keeps the new schedule: the menu
  checks the schedule when Froonty starts and whenever it changes.
- **The tile:** GNOME's Night Light tile is hidden while the menu holds
  the switch. GNOME binds its visibility to Mutter's
  `night-light-supported`, so Froonty hides it again whenever it shows.
- **With neither slider** (no backlight and Software brightness off) or
  **without Night Light support**, nothing changes: the tile stays, and
  GNOME's arrow follows GNOME's own rule. Turning the setting or Froonty off
  restores the same.
- `features/brightness/nightLightMenu.js`, an extension part (`PARTS` in
  `registry.js`). GNOME's items come from Quick Settings' private
  `_brightness` and `_nightLight` indicators, read only in
  `shell/quickSettings.js` (`gnomeItem`, after `whenQuickSettings`). The
  separator above Night Light goes in the host menu, not in Night
  Light's section: GNOME shows a separator only with visible items on
  both sides of it in its own box. The headless test has neither a
  backlight nor Night Light, so it checks only that the tile and GNOME's
  menu are left alone; Night Light in a menu is checked by hand.

## 8. One slider with a laptop open beside monitors

Added 2026-11-26 (owner's request: with the lid open and the monitors
joined, GNOME's slider and Software brightness's should be one).

When GNOME shows its brightness slider (some screen has a backlight: the
laptop's panel, lid open) and none of the monitors Software brightness
dims has a backlight of its own, those monitors join GNOME's slider:

- **One slider:** GNOME's, with its sun; Software brightness's hides.
  GNOME's slider moves every screen and keeps their ratio, as it does for
  several backlit screens (`misc/brightnessManager.js`): it stands for the
  brightest screen, and halving it halves each.
- **A slider per screen in its menu:** the > opens GNOME's menu with the
  panel and the monitor, by name ("External monitors" for several, which
  share one level), then Night Light's items (§7). Moving one changes
  that screen alone.
- **The brightness keys** and GNOME's on-screen level reach the monitor
  too, and so does GNOME's idle dimming (Settings → Power → Dim Screen),
  which lowers it for a while without changing its level.
- **The level** stays `brightness-level`, in the same span (Lowest
  brightness to 100 %), written as it moves. Software brightness's own
  slider has it when it comes back: lid closed (the panel goes off, so
  GNOME shows no slider), monitors mirrored (one screen, the built-in
  one), or unplugged.
- **Two sliders** as before when a monitor it dims has a backlight:
  Monitors set to **Built-in screen** or **All monitors** with the laptop
  open, since GNOME already dims the panel.

`shell/brightnessManager.js` adds a scale of GNOME's own class
(`BrightnessScale`) for the monitors to `Main.brightnessManager`'s private
map of screens and has the manager recompute (its private `_sync()`), as
GNOME does for its own screens. It takes it out again when the Monitors
setting changes, when Software brightness or Froonty goes off, and at a
screen lock; when monitors change, GNOME rebuilds its map without it and
Froonty adds it back if the rule still holds. Which monitors join is
`mergedMonitors()` in `levels.js`. If the manager is not as expected (a
later GNOME), the two sliders stay.

The headless test has no backlight, so `testBrightnessMerge` fakes one
(monitor 0 a backlit panel, GNOME's slider shown with a global scale of
GNOME's class). On a real laptop it is checked by hand.
