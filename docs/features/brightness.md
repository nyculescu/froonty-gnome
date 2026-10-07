# Feature: Software brightness

Status: **implemented**, 2026-10-06, from a contributed patch
(`Froonty_software_brightness.patch`, reworked before merging; §5).
Working-tree only (`make install`): not in `make pack` output yet.
**Off by default.**

A second brightness slider in Quick Settings, under GNOME's, for monitors
whose brightness GNOME cannot set: a monitor that `ddcutil` sees but that
reports DDC/CI as unsupported (some Samsung Smart Monitors), or one behind
an adapter that does not pass DDC/CI through. Froonty darkens those
monitors with a black layer.

It is software dimming: the backlight stays as it is, so it saves no
power, and black stays as black as the panel makes it. It is not a
night light (no colour change).

## 1. Use

Settings → Brightness → **Software brightness** on. The slider then sits
right under GNOME's brightness slider in Quick Settings (where GNOME has
one; on a desktop without a backlight GNOME shows none, and Froonty's
slider takes that place).

- **Monitors:** **External monitors** (the default): every monitor but a
  laptop's built-in screen, so on a desktop all of them. **Built-in
  screen**: only the laptop's own screen. **All monitors**.
- **Lowest brightness (%):** the slider's left end, 10 % by default
  (5-90 %), so a screen never goes black. Raising it brightens a darker
  level at once.

The slider at its right end (100 %) puts no layer at all.

## 2. How it works

`features/brightness/overlay.js`, an extension part (made by
`extension.js` from `localFeatures.js`'s `LOCAL_PARTS`): it lives while
Froonty runs and follows `brightness-enabled` itself.

- **The layer:** one `St.Widget` on `global.stage` (not `uiGroup`), with
  one black child per dimmed monitor at that monitor's geometry and an
  opacity of 255 × (100 − level) / 100. It is raised again whenever
  something is added to the stage, so it stays over the top bar, the
  island, menus and notifications.
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

Pure logic (targets, opacity, the slider's scale) is in
`features/brightness/levels.js`, unit-tested in
`tools/unit/brightness.test.js`.

## 3. Settings

| Key | Default | |
|---|---|---|
| `brightness-enabled` | `false` | The feature |
| `brightness-level` | 100 | The level, in percent (0-100; never applied below the minimum) |
| `brightness-min` | 10 | The slider's left end (5-90) |
| `brightness-monitors` | `external` | `external`, `built-in` or `all` |

## 4. Limits

- **The lock screen is not dimmed:** GNOME disables extensions while the
  screen is locked, so the layer goes with them and comes back on unlock.
- **Screenshots and screen casts** show the dimmed picture, since the
  layer is part of what the Shell draws.
- **No keyboard brightness keys:** they keep driving GNOME's own slider.
- **One level for every dimmed monitor.**
- **Not yet tried on real hardware:** the headless tests use virtual
  monitors (none built-in) and check the layer's geometry, opacity,
  picking and lifecycle, not what reaches the screen. Still to check by
  hand (`make devkit`, then a real session): the slider's look, that the
  pointer stays undimmed, and a fullscreen video or game (if Mutter scans
  a fullscreen window out directly, the layer might not show over it).

## 5. Changes from the contributed patch

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
- **Local build only**, as every feature until it is submitted to
  extensions.gnome.org, wired through `LOCAL_PARTS` and left out by
  `tools/pack-public` (keys, modules; `check_zip.py` fails on any trace).
- Levels in whole percent (`brightness-level`, `brightness-min`) instead
  of 0-1 doubles; the keys were never released, so nothing migrates.
- Unit tests and a headless check, which the patch had none of.
