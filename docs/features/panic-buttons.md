# Feature: Panic buttons

Status: **implemented (v1)**, 2026-09-28. More buttons will be designed from
the following week; the bar and the catalog are ready for them.

## 1. Goal

The hub has a bar of up to **5 quick-action buttons** at the top of the
expanded island, in the place the feature tabs used to occupy. The bar is
**centered across the whole island**, and each button shows its name in a
tooltip on hover. You choose and order the buttons in Settings → Panic
buttons.

The feature tabs (Clock, Notes, …) moved to a **vertical column on the
left**. Each tab shows its feature's name in a tooltip on hover.

```
┌────┬──────────────────────────────────────┐
│ 🕒 │         [🎤][🔊]                 ⚙️   │  panic bar (max 5), centered
│ 📝 │──────────────────────────────────────│
│    │         active feature               │
└────┴──────────────────────────────────────┘
```

## 2. Decisions (agreed 2026-09-28)

- **Unused slots are hidden**; only configured buttons appear.
- **The island keeps its total size.** The tab column (about 40 px) comes out
  of the feature's width.
- **Settings uses an add/remove list:**
  - "In the bar" shows up to 5, with up, down and remove buttons.
  - "Available" has an Add button per entry, disabled at 5.
- **Defaults:** Mute microphone, then Mute sound.
- **The tab column** is a `Clutter.GridLayout` filled column by column.
  `TAB_COLUMNS` in `ui/hub.js` is 1 for now; raising it is the planned way
  to fit more features (placeholder).

## 3. Buttons in v1

| Id | Action | Shown checked (red) when |
|---|---|---|
| `mute-microphone` | Toggles the mute of the default input | The microphone is muted |
| `mute-sound` | Toggles the mute of the default output (all system sound) | The sound is muted |

Both reuse GNOME Shell's shared mixer (`ui/status/volume.js`
`getMixerControl()`, through `shell/mixer.js`), the one behind Quick
Settings' volume and microphone sliders:

- **No second connection:** there is no extra sound-server connection.
- **Follows the device:** the button tracks the default device when it
  changes.
- **Follows mute changes made elsewhere:** keys, Quick Settings and other
  apps.
- **No device:** without a device, the button is insensitive.

## 4. Structure

```
panic/catalog.js    pure: ids, icons, titles, MAX 5, sanitize(); shared by
                    the Shell and the settings window (unit-tested)
panic/registry.js   Shell side: id → button factory
panic/audioMute.js  the two mute buttons (input/output)
panic/prefs.js      the "Panic buttons" settings tab
ui/panicBar.js      renders the configured buttons (setting: panic-buttons)
shell/mixer.js      adapter for the Shell's shared Gvc mixer
core/tooltip.js     hover bubble, shared by the hub tabs and Notes tabs
```

**Adding a panic button:** add an entry in `catalog.js` and a factory in
`registry.js`. It then appears under "Available" in Settings.

## 5. Tests

- **Unit:** `tools/unit/panic.test.js` covers `sanitize` (unknown ids,
  duplicates, the cap of 5).
- **Headless:** the isolated session now runs its **own PipeWire**, with a
  virtual speaker and microphone and no hardware (host audio untouched).
  WirePlumber's ALSA, Bluetooth and camera monitors are disabled there. An
  early version found the host sound card through ALSA, which could have
  reached the real mixer. A guard now fails the run, and skips every mute
  check, unless all visible audio devices are test devices. The test
  microphone uses `Audio/Source/Virtual`, so WirePlumber can make it the
  default. With that, the mute buttons are tested for real:
  - mute and unmute of the default output and input;
  - a mute made elsewhere updates the button;
  - the bar follows the setting, ignores unknown ids and duplicates, and
    shows nothing when the list is empty;
  - the vertical tab column and its tooltip;
  - the leak footprint also counts the mixer's signal handlers.
