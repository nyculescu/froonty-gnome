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

Added 2026-09-29 (user request), off by default:

| Id | What it shows | A click |
|---|---|---|
| `claude-session` | The session's usage (0–100, no "%") in Claude's orange (#d97757), as large as the button allows, over a faint grey Spark; "?" when unknown | Opens the Claude tab |

It is an indicator, not an action. Its name, which is also its tooltip,
spells the value out: "Claude session usage: 13%", or "…: unknown (no
internet connection)". It follows the Claude tab's rules
([claude.md](claude.md)). It reads Claude Code's cache each time the
island opens, follows it while the island stays open, and does nothing while
the island is collapsed. The bar tells its buttons when the hub is shown
(`setActive`, optional on a button).

## 4. Block camera for apps that ask GNOME

Added 2026-10-02 (user request: "camera on/off"), off by default:

| Id | Action | Shown checked (red) when |
|---|---|---|
| `block-camera` | Turns GNOME's **Camera Access** switch off, or back on | Camera access is off |

It is the switch in GNOME Settings → Privacy & Security → Cameras
("Camera Access: Allow permitted apps to use cameras"), the key
`org.gnome.desktop.privacy disable-camera`. Froonty writes that key and
listens to it, so:

- **Follows changes made elsewhere:** GNOME Settings or `gsettings`, at
  once (`changed::disable-camera`), with no polling.
- **Locked:** the button is insensitive when an administrator has locked
  the key (`writable-changed::disable-camera`), or on a system whose
  schemas lack it.
- **Icons:** `camera-web-symbolic` while allowed, `camera-disabled-symbolic`
  while blocked. Both are in Adwaita and Yaru.

### 4.1 What it blocks, and what it does not

Verified on the development machine on 2026-10-02 (Ubuntu 26.04: GNOME
Shell 50.1, xdg-desktop-portal 1.21.1, xdg-desktop-portal-gnome 50.0,
PipeWire 1.6.2, WirePlumber 0.5.13). The real setting was only read, never
changed.

- **Who reads the key.** Of the installed programs, only
  `xdg-desktop-portal`, `xdg-desktop-portal-gnome`,
  `xdg-desktop-portal-gtk` and GNOME Settings contain `disable-camera`.
  GNOME Shell's JavaScript (extracted from `libshell-18.so`), PipeWire,
  WirePlumber and gnome-settings-daemon do not.
- **How it is enforced.** xdg-desktop-portal-gnome binds the key to the
  `disable-camera` property of its `org.freedesktop.impl.portal.Lockdown`
  backend (`g_settings_bind` in `lockdown.c`, tag 50.0). On the session
  bus that property matched the key. xdg-desktop-portal's camera portal
  (`camera.c`, tag 1.21.1) then answers both `AccessCamera` and
  `OpenPipeWireRemote` with the error "Camera access disabled".
- **So it blocks** apps that ask GNOME for the camera through its camera
  portal. Sandboxed Flatpak apps without device access have no other way.
  Some unsandboxed apps may use the portal too (for example browsers with
  PipeWire camera support), depending on the app and its settings. That
  was not verified here.
- **It does not block:**
  - **Apps that open `/dev/video*` themselves.** Here the webcam's device
    node has a logind `uaccess` ACL that gives the logged-in user
    read-write access. Its udev tags also give the Firefox, VLC and Teams
    snaps direct access (snapd's camera interface). GNOME Settings' own
    Cameras page says it: "Apps that are not sandboxed can use cameras
    without asking for permission." Flatpak apps given `--device=all`
    can open the device as well.
  - **Apps that use PipeWire without the portal.** WirePlumber's
    `access-portal.lua` restricts only portal-managed clients, from the
    permission store's `devices/camera` table, not from this key.
  - **A camera already in use.** Neither the portal nor WirePlumber takes
    back access granted earlier.
- **Nothing to reuse in GNOME Shell 50.** It has no camera privacy toggle.
  Its only camera facility is the camera-in-use indicator
  (`ui/status/camera.js`, `Shell.CameraMonitor`, PipeWire only). The
  button therefore uses GNOME's setting, and no Shell API.

### 4.2 Not done: a hardware or kernel cut-off

- **rfkill** has no camera type. This machine lists only Bluetooth and
  Wi-Fi.
- **Unloading `uvcvideo`**, unbinding the USB device, or writing its
  `authorized` file in sysfs all need root. They would cut every webcam,
  fail or misbehave while the camera is in use, and depend on device
  paths, so no fixed `pkexec` argv fits them.
- **Vendor privacy switches** (some laptops' sysfs `camera_power`, hardware
  shutters, camera keys) depend on the model. This machine's webcam is a
  plain USB UVC camera with none.

A physical shutter, or unplugging a USB webcam, remains the only real
cut-off.

### 4.3 Decisions

- **Not in the defaults.** It changes a system-wide GNOME privacy setting,
  which a user should choose knowingly, and its protection is partial. The
  defaults stay Mute microphone, then Mute sound.
- **The name says whom it stops.** The title is also the tooltip and the
  accessible name: "Block camera for apps that ask GNOME". Settings shows
  the full description under it. Catalog entries may carry an optional
  `description` for this.
- **Insensitive when locked, not when no camera is plugged in.** The
  setting also covers a camera plugged in later. Knowing whether one is
  present would need the portal's `IsCameraPresent` over D-Bus.

## 5. Structure

```
panic/catalog.js    pure: ids, icons, titles, descriptions, MAX 5,
                    sanitize(); shared by the Shell and the settings
                    window (unit-tested)
panic/registry.js   Shell side: id → button factory
panic/audioMute.js  the two mute buttons (input/output)
panic/claudeSession.js  Claude session usage (reuses features/claude)
panic/cameraAccess.js   GNOME's Camera Access switch, Gio only
                    (unit-tested)
panic/camera.js     the "Block camera" button
panic/prefs.js      the "Panic buttons" settings tab
ui/panicBar.js      renders the configured buttons (setting: panic-buttons)
shell/mixer.js      adapter for the Shell's shared Gvc mixer
core/tooltip.js     hover bubble, shared by the hub tabs and Notes tabs
```

**Adding a panic button:** add an entry in `catalog.js` and a factory in
`registry.js`. It then appears under "Available" in Settings.

## 6. Tests

- **Unit:** `tools/unit/panic.test.js` covers `sanitize` (unknown ids,
  duplicates, the cap of 5). `tools/unit/panic-camera.test.js` covers the
  camera entry and `CameraAccess`: toggling, following a change made
  elsewhere, a locked switch, a missing key, and no handler left after
  `destroy()`. Every write goes to a Gio.Settings on its own memory
  backend (asserted) or to a fake, never to the real settings.
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
- **Headless, Block camera** (`testPanicCamera`, needs no sound server).
  It writes GNOME's privacy settings, so it first checks that they are the
  harness's private keyfile copy (`$WORK/config`) and stops otherwise.
  Then:
  - the button's name, tooltip, icon and unchecked state;
  - a click turns `disable-camera` on and checks the button;
  - Tab reaches it, and Space turns camera access back on;
  - a change made elsewhere checks and unchecks it;
  - removed from the bar, it leaves no handler on its settings object.
