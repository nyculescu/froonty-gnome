# Feature: Fan settings

Status: **implemented.**

Fan controls and telemetry live on **Froonty → Settings → Fan**; there is no
Fan button in the island's left rail. The fan icon beside the Quick Settings
pad slider opens that page. It exposes the llano V12 Ultra cooling pad and,
on supported ASUS ROG/TUF laptops, the laptop fan profiles and custom-curve
switch.

## Cooling pad

The pad is controlled through
[llano-v12-linux](../../third_party/llano-v12-linux)'s `llano.py`, run with
`/usr/bin/python3` (GJS has no ioctl; the pad uses HID feature reports).
Access without a password needs that project's udev rule
(`contrib/70-llano.rules`).

- **Fan speed** is a 300–2800 rpm slider in the pad's 50 rpm steps, with
  **Off**, **300 rpm**, **1550 rpm** and **2800 rpm** shortcuts. At
  300 rpm, the pad and its lights stay on and the fan turns at its slowest
  speed; **Off** stops the fan and lights. The pad itself takes a percent:
  `llano.py rpm` sends the highest one at or under the rpm, and the page
  shows the pad's percent as rpm through llano-v12-linux's `noise.py`
  table (300 rpm at 0–1 %, then 25 rpm a percent).
- **Lock off** turns the pad off and blocks writes through llano.py until
  **Unlock** is used. The pad's physical roller still works.
- **Release** hands speed control back to the pad's roller without changing
  the current speed.
- **Recommended** shows the current fan speed from `fan_lut.json` and the
  CPU or GPU temperature that leads. **Apply** sets that speed. Without a
  readable table or temperature, Apply is unavailable.
- When `llano-guard` or `llanod` is setting the speed, the page identifies
  the unit and offers **Stop it**.
- The page reports connection, permissions, lock, command and estimated
  noise status. It also provides settings for the llano.py path, LUT path,
  refresh interval and the separate pad noise slider in Quick Settings.

The buttons stay clickable while a command or a refresh runs; a click
then waits for the running command, and only the newest waiting one is
sent.

### Off at log-out, shutdown, restart and sleep

The laptop keeps USB powered after it shuts down, so the pad would keep
running. `make pad-power` (asks for sudo) installs three units, with the
repository's paths filled in (`LLANO=/path/to/llano.py` for another copy):

- `tools/llano-session.service`, in the user's systemd: stopped with the
  GNOME session, so at log-out and before a shutdown or restart from
  GNOME's menu.
- `tools/llano-off.service`, in the system's, as root: stopped at every
  shutdown and restart, after the user sessions, so it catches one started
  another way (`systemctl poweroff` in a terminal).

Both run `tools/llano-power.sh`: when the pad is on, it notes that in
`~/.local/state/llano/on-at-exit` and runs `llano.py off`. A pad already
off (or locked off) is left alone, since `llano.py off` would flash it on
first. At the next log-in, the session unit switches the pad back on at
300 rpm (`llano.py rpm 300`) if the note is there, and removes the note;
a pad that was off stays off. A pad not plugged in at that log-in is not
switched on later.

A third unit, `tools/llano-sleep.service` (system, as root), switches the
pad off while the computer sleeps (suspend or hibernate): before sleep it
keeps the pad's speed and control in `/run/llano/sleep-state`, and on
waking it sets that speed again, handing control back to the roller if
the roller had it. It waits up to 5 s for the pad to answer after waking.
A pad that was off stays off.

To remove them: `systemctl --user disable --now llano-session.service`,
`sudo systemctl disable --now llano-off.service`,
`sudo systemctl disable llano-sleep.service`, then delete
`~/.config/systemd/user/llano-session.service`,
`/etc/systemd/system/llano-off.service` and
`/etc/systemd/system/llano-sleep.service`.

The recommendation comes from `fan_lut.json`: per device, rows of
[°C, fan %], interpolated between rows and clamped at the ends, and shown
and applied in rpm. The CPU is
read at its package temperature and the GPU at the hottest card's; the
device whose row gives the higher speed leads.

## Fan lock panic button

The **Fan lock** panic button (`fan-lock`, panic/fanLock.js) does the same
as **Lock off** from the panic bar: `llano.py lock` turns the pad off and
refuses every write through llano.py, and a second click runs
`llano.py unlock`, back to the speed the pad had. It is checked, with a
crossed-out fan, while locked. It follows llano.py's lock file
(`$XDG_STATE_HOME/llano/lock`) with a file monitor, so a lock from the
command line or this page shows too. Without a monitor (no inotify
instance free, say), it shows the state it finds when built and after
each click. The pad's roller still works.

## Laptop fans

On supported ASUS ROG/TUF laptops, speeds are read from the `asus` hwmon
device. The profile and curve controls use asusd 6.x on the system bus:
`PlatformProfile`, `PlatformProfileChoices`, `FanCurveData`, and
`SetFanCurvesEnabled`. Only profiles also listed by the firmware are
offered. Selecting one switches the laptop's platform profile; the switch
turns all stored custom fan curves for the active profile on or off.
Without asusd, the page shows the available telemetry and an explanation.

## Sampling and implementation

While Settings → Fan is visible, `FanService` refreshes pad status,
CPU/GPU temperatures and laptop fan status at the configured interval
(default 2 seconds). Sampling pauses on other settings pages and when the
window closes. The same service drives the controls and calculates the
current LUT recommendation.

llano-v12-linux is a submodule at upstream's commit; this PC's changes
(panic lock and control log, the LUT sweep and `fan_lut.json`, and the
RPM/noise model) are patches in `third_party/patches/llano-v12-linux/`,
applied on a `froonty` branch by `make third-party`. Defaults point into
`third_party/llano-v12-linux`. To change llano, commit in that branch, then
add the new commits as the next numbered patch files:

```sh
git -C third_party/llano-v12-linux format-patch -q --no-signature -N \
  --start-number N -o ../patches/llano-v12-linux \
  <last-patched-commit>..froonty
```
