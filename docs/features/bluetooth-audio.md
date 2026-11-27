# Feature: Bluetooth in the Sound Output menu

Status: **implemented** (2026-11-27, user request: connect paired
headphones or speakers from the Sound Output menu in one step, instead of
the Bluetooth menu, then the output list, then the volume). On by default:
Settings → Media → Quick Settings → **Bluetooth in the Sound Output menu**
(`sound-bluetooth-menu`). It is not part of the Media tab and works with
the tab off.

## The menu

The > on GNOME's volume slider opens Sound Output. Under GNOME's outputs,
and above its Sound Settings, Froonty adds:

- **Bluetooth**, a heading (a labelled separator, as GNOME's app menus
  use).
- A row for each paired (or trusted) device that plays sound and can be
  connected, with its icon and name, and **Connect** or **Disconnect**.
  Connected ones come first, then by name, as in GNOME's Bluetooth menu.
- **Pair New Device…**, which opens Settings → Bluetooth, where new
  devices are found and paired (PIN, confirmation).

The whole section hides while Bluetooth is off, blocked (airplane mode) or
absent; GNOME's menu is then as it was. With the section showing, the
slider keeps its >: GNOME shows it only with more than one output
(`menuEnabled`, `ui/status/volume.js`), so a laptop with only its speakers
would otherwise have no way into the menu. Froonty sets it back whenever
GNOME clears it, and gives GNOME's rule back when the section hides or
goes.

## Which devices

`devices.js` (Shell-free, unit-tested): a device plays sound by its kind
(GnomeBluetooth's headset, headphones, other audio, speakers), or, with no
kind known, by offering A2DP (`AudioSink` among its uuids). Phones,
computers and keyboards are left out even with A2DP. On the owner's
laptop that lists Crusher ANC 2 (headset) and HUAWEI Sound Joy
(speakers), and leaves out MX Keys and a device with no kind that cannot
connect.

## A click

A row's click does not close the menu (a GNOME menu item's activation
closes the whole menu, `PopupMenuBase.itemActivated`), so the spinner and
then the check mark moving in GNOME's list stay in view.

- **Connect:** `GnomeBluetooth.Client.connect_service(path, true)`, as
  GNOME's Bluetooth menu does. Meanwhile Froonty waits, up to 20 s, for
  the device's sound output (a sink) to appear in GNOME's mixer, and makes
  it the output the way a click in GNOME's list does
  (`lookup_device_from_stream` + `change_output`; `set_default_sink` when
  GNOME has no output entry for it yet). The volume slider then sets that
  device's volume. The sink is the device's by its address: PipeWire names
  it `bluez_output.AA_BB_CC_DD_EE_FF.1` (seen on the owner's laptop in
  WirePlumber's saved state), PulseAudio `bluez_sink.AA_BB_…`. If another
  output is chosen while it waits (GNOME's list, Sound Settings), that
  choice stays. If the connection fails, it stops waiting; the failure is
  logged.
- **Disconnect:** `connect_service(path, false)`; the sound server falls
  back to its previous output.

Why not leave it to WirePlumber: it restores the last output *chosen* when
it is available, and on the owner's laptop that is HDMI, so a Bluetooth
device that connects does not become the output on its own.

## Code

- `features/bluetoothAudio/devices.js`: which devices, their order, which
  sink is a device's.
- `features/bluetoothAudio/menu.js`: `BluetoothOutputs`, a part
  (`features/registry.js` `PARTS`) made while Froonty runs. Its own
  `GnomeBluetooth.Client` (D-Bus to BlueZ; GNOME's Bluetooth indicator
  keeps its client private) exists only while the setting is on. Device
  changes are gathered into one update per idle. The mixer is the Shell's
  shared one (`shell/mixer.js`).
- GNOME's slider: `Main.panel.statusArea.quickSettings._volumeOutput`
  (private, [DESIGN.md §6.3](../DESIGN.md)), found with
  `shell/quickSettings.js` `gnomeItem()`.

## Tests

- `tools/unit/bluetooth-audio.test.js`: the type flags against
  GnomeBluetooth's typelib, which devices play sound and are listed, the
  order, and sink names (PipeWire's, PulseAudio's, another device's, the
  device's microphone).
- `testBluetoothOutputs` (`make test`): the test session has no BlueZ, so
  the section is in its place and hidden, and the > follows GNOME's rule.
  With a fake adapter and devices: the rows, the heading and Pair New
  Device…, the > kept through GNOME's own sync, a click that connects and
  keeps the menu open, a failed connection that stops waiting, the
  spinner while connecting, and turning the setting off and on (GNOME's
  menu and > as they were, no mixer handler left).
- Not testable in `make test` or `make devkit`: a real connection. Both
  run their own PipeWire without Bluetooth, and their system bus has no
  BlueZ (`tools/devkit.sh`). Try it in the real session after
  `make install` and logging out and in.

## Limits

- No pairing in the menu: that needs a scan and a pairing agent (PIN or
  confirmation dialogs), which Settings → Bluetooth already has.
- A headset can connect in its call profile (HFP, lower quality) if the
  sound server picks that one; Froonty uses whichever output appears and
  does not change the card's profile.
