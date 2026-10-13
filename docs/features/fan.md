# Feature: Fan settings

Status: **implemented for local builds; not included in `make pack`.**

The fan icon in Froonty's left rail opens **Settings → Fan**. Fan controls
and telemetry live on that preferences page; the island no longer has a Fan
tab. The page exposes the llano V12 Ultra cooling pad and, on supported ASUS
ROG/TUF laptops, the laptop fan profiles and custom-curve switch.

## Cooling pad

The pad is controlled through
[llano-v12-linux](../../third_party/llano-v12-linux)'s `llano.py`, run with
`/usr/bin/python3` (GJS has no ioctl; the pad uses HID feature reports).
Access without a password needs that project's udev rule
(`contrib/70-llano.rules`).

- **Fan speed** is a 0–100% slider, with **Off**, **0%**, **50%** and
  **100%** shortcuts. At 0%, the pad and its lights stay on and the fan
  turns at its slowest speed (300 rpm); **Off** stops the fan and lights.
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

The current recommendation remains the existing `fan_lut.json` algorithm:
per-device rows of [°C, fan %], interpolated between rows and clamped at
the ends; the higher CPU/GPU recommendation leads. CPU temperature
calculation and fan recommendation logic are intentionally unchanged here.

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
current LUT recommendation; the settings page does not duplicate its
control or recommendation logic.

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
