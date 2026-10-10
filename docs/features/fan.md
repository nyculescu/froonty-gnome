# Feature: Fan (cooling pad)

Status: **first iteration, implemented.** Working tree only (not in `make pack` output).

The llano V12 Ultra laptop cooling pad, driven from the island, and the
temperatures it is there for. The pad is reached through
[llano-v12-linux](../../third_party/llano-v12-linux)'s `llano.py`, run with
`/usr/bin/python3` (GJS has no ioctl, and the pad speaks HID feature
reports). Access without a password needs that project's udev rule
(`contrib/70-llano.rules`).

llano-v12-linux is a submodule at upstream's commit; this PC's changes
(the panic lock and control log, the LUT sweep and `fan_lut.json`, the
noise limits) are patches in `third_party/patches/llano-v12-linux/`,
applied on a `froonty` branch by `make third-party`. The settings'
defaults point into `third_party/llano-v12-linux`. To change llano, commit
in that branch, then add the new commits as the next patch files (N is
the next number, the existing files stay as they are):
`git -C third_party/llano-v12-linux format-patch -q --no-signature -N --start-number N -o ../patches/llano-v12-linux <last patched commit>..froonty`.

## Look

Size 460 × 620 px by default (`fan-width`, `fan-height`; drag the open
island's corner to change it).

- **Cooling pad:** the speed in big type ("Off" when the pad is off); under it the control (software,
  the pad's roller, or released), the lights and the raw status report,
  and **Last change**: who drove the pad last, what they did and when
  (llano.py's `control.log`), or the pad's roller when its status says so;
  then the speed's estimated **rpm and dB at the ears**, coloured by noise
  band (llano-v12-linux's NOISE.md: quiet, night level, audible, loud,
  very loud).
- **Noise limit:** the cap in force ("Quiet hours until 07:00: capped at
  600 rpm (12%)", or the daytime 2000 rpm) and **Loud until 07:00** /
  **Back to limits**. A slider position past the cap reads "40% → 12%";
  the recommendation is capped too ("Recommended 12% (table: 60%, capped)").
  A slider 0–100 %, then **Off**, **0 %**, **50 %**, **100 %**, **Lock
  off** / **Unlock** and **Release**. The slider and **0 %** keep the pad
  and its lights on (at 0 % the fan turns at its slowest, 300 rpm); **Off**
  switches the whole pad off, lights included.
- **Recommended:** the speed `fan_lut.json` gives for the current CPU and
  GPU temperatures, which device leads, and **Apply**. Without the table,
  how to build it.
- **Locked:** who locked it and when; every speed control is held.
- **Notices:** the pad missing, no access (the udev rule), `llano.py` not
  found, or `llano-guard` / `llanod` running (they set the speed by
  themselves and would undo the slider), with **Stop it**.
- **Laptop** (an ASUS ROG / TUF laptop; hidden elsewhere): the model,
  each laptop fan's speed (CPU, GPU, mid) in the colour of what it cools,
  the platform profile as buttons (**Quiet**, **Balanced**,
  **Performance**: the ones both asusd and the firmware list), whether
  the active profile runs its custom fan curves (**Use custom curves** /
  **Firmware curves**), and those curves drawn: fan % over °C, solid while
  in use, dashed while the firmware's own run; thin lines mark the CPU's
  and the hottest GPU's temperature now. Without asusd, only the speeds
  and a notice.
- **Temperatures:** a legend (CPU, each GPU by vendor, fan) with live
  values; a chart of the last five minutes (°C left, fan % right, dashed);
  and each physical core as a bar, green to red, P-cores and E-cores
  labelled on a hybrid Intel CPU.

## Behaviour

- **Polling only while the tab is on screen**, every `fan-interval` s
  (default 2), like Btop, with Btop's Sampler (a sleeping NVIDIA GPU is
  not woken). The history outlives a visit; lines break over the gap.
- **One pad command at a time.** A new speed replaces one still waiting,
  so dragging sends only the latest; a status poll never replaces a
  command. After a move, the slider is not moved back for 1.5 s, so a
  poll already under way cannot undo it.
- **Off is the pad off, lights included; 0 % is not.** At 0 % with the pad
  on, its fan still turns at its slowest (300 rpm, like 1 %), lights on.
  **Off** runs `llano.py off` (as `lock` does), which sets the on_off byte:
  the fan stops and the lights go out with it, as the pad has no
  fan-off-lights-on. Off sent to a pad already off would start its fan with
  the lights dark, so llano.py then switches it on at 0 % first (a
  half-second flash). Any speed, Release and Unlock switch it back on; the
  tab does not resend a speed the pad already has.
- **Release:** the pad keeps its speed, and its status byte stays `0x80`
  (software) until the roller is next turned, so the tab says "released"
  until then.
- **Recommendation:** `fan_lut.json` has rows of [°C, fan %] per device,
  from a load × fan sweep (`research/lut_sweep.py`, `research/build_lut.py`
  in llano-v12-linux). The speed is interpolated between rows and clamped
  at the ends; the machine's is the higher of the CPU's and the GPU's.
  The table is read again on each visit.

## Laptop fans (asusd)

The speeds come from the `asus` hwmon device (asus-nb-wmi), readable by
anyone. The profile and curves go through asusd, asusctl's daemon
([third_party/asusctl](../../third_party/asusctl), pinned to 6.3.6, the
version running here): `xyz.ljones.Platform` (`PlatformProfile`,
`PlatformProfileChoices`) and `xyz.ljones.FanCurves` (`FanCurveData`,
`SetFanCurvesEnabled`) at `/xyz/ljones` on the system bus. asusd's D-Bus
policy lets the users, sudo, adm and wheel groups call it, so no password
is asked. asusctl 5.x (`org.asuslinux.Daemon`) is not supported.

- **Cheap polls.** A tick reads the fans' `fanN_input` files and
  `/sys/firmware/acpi/platform_profile`, nothing else: asusd is not woken.
  The hwmon device, fan names, model, profile choices and whether asusd is
  there are read once per visit (an absent asusd is retried on the next
  visit), and the curves when the profile changes or after a change from
  the tab; a curve edited elsewhere (`asusctl fan-curve`) shows on the next
  visit. The laptop is read with the temperatures, so a tick ends in one
  redraw, and the curve chart is redrawn only when the curves change or a
  temperature moves by a degree.
- The profile comes from `platform_profile`, not asusd's change signal,
  which misses a switch made in GNOME's power menu (power-profiles-daemon
  writes the same file). asusd follows such a switch itself and applies
  that profile's curves.
- asusd 6.3.6 lists Low power where the firmware (`platform_profile_choices`)
  has only quiet, balanced and performance; only profiles both list are
  offered.
- **Use custom curves** turns on every fan's stored curve for the active
  profile; until they are edited (`asusctl fan-curve`, or
  rog-control-center) those hold the firmware's defaults, read by asusd.
  The curves are not edited here.
- The panic lock is the pad's only: the laptop's fans are never stopped.
- **Trying it in `make devkit`:** the devkit's system bus is private, so
  asusd is not there ("asusd is not running"). `make devkit SYSTEM_BUS=1`
  (`tools/devkit.sh --system-bus`) puts `xdg-dbus-proxy` in its place:
  the real system bus, but only asusd can be seen and called
  (`SYSTEM_BUS_NAMES` to widen it), so the nested Shell still finds no
  logind or GDM. A profile switched there is switched on this computer.

## Lock and the Fan lock panic button

`llano.py lock` turns the fan off and writes `$XDG_STATE_HOME/llano/lock`;
while it is there llano.py refuses every speed and release, so nothing
that drives the pad through it (the CLI, llanod, cpu_guard, the research
scripts, this tab) can start the fan. `unlock` restores the speed and
control from before. The **Fan lock** panic button (panic/fanLock.js)
toggles it and follows the lock file with a file monitor, so a lock from
the command line shows at once; the tab's **Lock off** does the same.

What it cannot do: stop a program that opens `/dev/hidraw*` itself, since
the udev rule gives every program of the user access. A lock that no user
program can lift needs root (a helper that de-authorizes the USB device,
unlocked with the password through polkit); see llano-v12-linux's README.
The pad's roller always works.

## Noise limits

llano.py caps every speed to the limit in force (NOISE.md): 600 rpm in
quiet hours (weekdays 22:00–07:00), 2000 rpm by day, unless `llano.py
loud` lifted it; a user timer (`llano-enforce`) lowers a software-set speed
above it every 5 minutes, and the roller is left alone. The tab reads it
all from llano.py's `noise {json}` line after each command and poll.

## Settings (Settings → Fan)

`fan-enabled`, `fan-interval` (1–10 s), `fan-llano-path`, `fan-lut-path`.

## Tests

- `tools/unit/fan.test.js`: llano.py's output, failures, units, physical
  cores, the table and the recommendation; asus.js's profiles, curves,
  hwmon fans, and AsusFans against a fake asusd and /sys.
- `FROONTY_TEST_ONLY=testFan tools/headless-test/run.sh`: the tab in a
  headless GNOME Shell with a fake `llano.py` (run.sh); with
  `FROONTY_TEST_LLANO=/path/to/llano.py` the same checks drive the real pad.
  The test's system bus is private, so the real asusd is never reached
  (the Laptop section shows the speeds and "asusd is not running"); there
  are no headless checks of the laptop section yet.
