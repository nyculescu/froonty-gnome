# Feature: Fan (cooling pad)

Status: **first iteration, implemented.** Working tree only (not in `make pack` output).

The llano V12 Ultra laptop cooling pad, driven from the island, and the
temperatures it is there for. The pad is reached through
[llano-v12-linux](../../../llano-v12-linux)'s `llano.py`, run with
`/usr/bin/python3` (GJS has no ioctl, and the pad speaks HID feature
reports). Access without a password needs that project's udev rule
(`contrib/70-llano.rules`).

## Look

Size 460 × 620 px by default (`fan-width`, `fan-height`; drag the open
island's corner to change it).

- **Cooling pad:** the speed in big type; under it the control (software,
  the pad's roller, or released), the lights and the raw status report,
  and **Last change**: who drove the pad last, what they did and when
  (llano.py's `control.log`), or the pad's roller when its status says so.
  A slider 0–100 %, then **Off**, **50 %**, **100 %**, **Lock off** /
  **Unlock** and **Release**.
- **Recommended:** the speed `fan_lut.json` gives for the current CPU and
  GPU temperatures, which device leads, and **Apply**. Without the table,
  how to build it.
- **Locked:** who locked it and when; every speed control is held.
- **Notices:** the pad missing, no access (the udev rule), `llano.py` not
  found, or `llano-guard` / `llanod` running (they set the speed by
  themselves and would undo the slider), with **Stop it**.
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
- **Release:** the pad keeps its speed, and its status byte stays `0x80`
  (software) until the roller is next turned, so the tab says "released"
  until then.
- **Recommendation:** `fan_lut.json` has rows of [°C, fan %] per device,
  from a load × fan sweep (`research/lut_sweep.py`, `research/build_lut.py`
  in llano-v12-linux). The speed is interpolated between rows and clamped
  at the ends; the machine's is the higher of the CPU's and the GPU's.
  The table is read again on each visit.

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

## Settings (Settings → Fan)

`fan-enabled`, `fan-interval` (1–10 s), `fan-llano-path`, `fan-lut-path`.

## Tests

- `tools/unit/fan.test.js`: llano.py's output, failures, units, physical
  cores, the table and the recommendation.
- `FROONTY_TEST_ONLY=testFan tools/headless-test/run.sh`: the tab in a
  headless GNOME Shell with a fake `llano.py` (run.sh); with
  `FROONTY_TEST_LLANO=/path/to/llano.py` the same checks drive the real pad.
