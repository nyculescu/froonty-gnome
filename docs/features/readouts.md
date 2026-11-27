# Feature: Readouts

Status: **implemented, not yet hand-tested**, 2026-11-02.

## 1. Goal

Up to **8 values printed on the collapsed pill**, around the date and time
and the player's wings. They have the structure of the panic buttons (a
catalog, a capped ordered choice in Settings, two groups around the time),
but they only show: nothing to press, so anything that acts, such as "Keep
Froonty on top", stays a panic button.

```
( [cpu] 37%  [ram] 62%  [art] 14:05 [▁▃▂]  [°] 76°C  [↓] 1.2M )
```

- **Split by width**, not count (`balancedSplit`): in the order chosen, at
  the point where the two sides come closest in width, the right side having
  more on a tie. A readout crosses the time only when that gains more than
  12 px, so a digit changing does not move it.
- **Both groups as wide as the wider one**, so the time stays centred. The
  narrower keeps its readouts together next to the time, unlike the panic
  bar's, which spreads apart. A lone readout's empty group still takes the
  room.
- **Outermost:** the player's cover and bars stay next to the time.
- **Nothing is reactive:** a click or hover on a readout is one on the pill,
  so it opens the island as usual.
- **Off by default:** `readouts` is empty, and then nothing is read and the
  pill keeps its usual width.

## 2. What can be shown

Settings → Readouts.

| Id | Prints | Unknown or special |
|---|---|---|
| `cpu-load` | CPU load, level colours | |
| `gpu-load` | Busiest graphics card | "–" with every card asleep |
| `ram-usage` | RAM used | |
| `cpu-temp` | Average over the CPU's cores, green to red | |
| `cpu-temp-max` | Hottest CPU core | |
| `gpu-temp` | Hottest graphics card | "–" with every card asleep |
| `net-down`, `net-up` | Physical interfaces' speed: 850K, 1.2M | |
| `disk-used` | Root file system used | |
| `claude-session`, `claude-weekly` | Claude usage, in Claude's clay | "?" by the Claude tab's rules: offline, or renewed since the reading |
| `timezone-1`, `timezone-2` | A favourite city's short name and its time: "Dub 18:47", "NY 13:47" (the accessible name has the whole name), in light blue (#99c1f1) so it is not taken for the local time. A small raised "+1" or "−1" follows when the city's date is a day after or before the local one, as on flight times (owner's request 2026-11-26) | Hidden without that favourite |

"?" is a value that cannot be read on this computer. Each value is preceded
by its icon, except the time zones, which name their city.

**Adding a readout:** an entry in `readouts/catalog.js` and its parts in
`readouts/registry.js`. It then appears under "Available" in Settings.

## 3. Cost

Unlike the panic buttons, these run while the island is collapsed, which is
most of the session. Everything stops while the island is open, over a
fullscreen window (the strip is unmapped), and when the extension is
disabled. With no readout chosen, nothing runs.

- **System values:** one sampler (`ReadoutMetricsService`, the same `Sampler`
  as the Btop tab), every `readouts-interval` seconds (1-60, default 5; Btop's
  interval is for a tab on screen). It reads only the sections the chosen ones
  need, and per-core temperatures only for a CPU temperature.
- **NVIDIA:** a sleeping card is not woken up, as in the Btop tab. A card
  that cannot sleep anyway (it lights a display, or its runtime power
  management is off) is read from one `nvidia-smi -lms` that keeps running
  while the pill shows a GPU readout, shared with Btop, the panic buttons
  and the System card (about 22 MB, about 0.09 ms of CPU per refresh). When
  the island opens it stops, unless another reader still needs it, and it
  stops on disable. Any other awake card is read with one `nvidia-smi` per
  refresh, which may keep it from going back to sleep. This was not
  measured. The GPU entries say so in Settings
  ([sysmon.md](sysmon.md#graphics-cards)).
- **Claude:** one `ClaudeService`, so a file monitor on Claude Code's config
  file and on the status line's file, the network monitor, and per write a
  stat of the file, which is read and parsed only when it changed since the
  last good read (the file was 85 kB here on 2026-11-02, 183 kB on
  2026-11-27). As with the panic button, coming on screen asks Claude Code's
  `/usage` (2-3 s, about 350 MB, at most once a minute), here on each
  collapse, and then again while the pill stays on screen (user request: the
  pill is on screen most of the session, so asking only on collapse left the
  number stale). The request was about once a minute; the cadence now
  follows Claude Code's own refresh, which gives the same freshness while
  the pill stays on screen. Each ask comes 2 min 6 s after Claude Code's
  last reading, or after the last ask if that brought none, so it is not
  repeated at once. Measured with Claude Code 2.1.332 on 2026-11-27: a
  `/usage` 61-94 s after its last reading fetched nothing, one 122 s or
  more after did. Asking every 61 s so brought a new reading only every
  other run, about every 2 min, for twice the runs (each about 1.6 s of
  CPU and 320 MB at its peak, the same day). The exception is a collapse
  or unlock 1-2 min after a reading: its `/usage` brings nothing, and the
  next ask waits 2 min 6 s from it, so the next reading comes up to about
  a minute later than with the minute cadence. One within a minute of a
  reading runs nothing and leaves the next ask timed from that reading.
  Claude Code's own writes and the status line still come in as they
  happen. With "Ask Claude Code for fresh usage" off, or in low power,
  nothing is run.
- **Time zones:** the shared clock's ticks; no timer.

The value's minimum width in the stylesheet keeps the pill still as digits
change; only a value wider than that, such as a long city name, makes it
ease to a new width.

## 4. Structure

```
readouts/catalog.js   pure: ids, icons, titles, MAX 8, sanitize()
readouts/values.js    pure: what each prints, what the sampler must read
readouts/registry.js  Shell side: id → the icon and value it shows
readouts/prefs.js     the "Readouts" settings tab (panic/prefs.js's
                      addChoiceGroups)
ui/readoutBar.js      the two groups and their sources; collapsedView.js
                      places them, island.js fits the pill to them
features/sysmon/panicMetrics.js
                      SystemSampling, the loop shared with the panic bar's
                      sampler, and ReadoutMetricsService
```

## 5. Tests

- **Unit:** `tools/unit/readouts.test.js` (catalog rules, what each prints,
  asleep cards, Claude's rules), `tools/unit/readouts-prefs.gtk.test.js` (the
  page: Add, 8 at most), and in `tools/unit/sysmon.test.js` the sampler.
- **Headless:** `testReadouts` in `tools/headless-test/checks.js`: off by
  default, values printed, the split, the time centred, equal groups, not
  reactive, the accessible name, the clock still covered, sampling stopped
  while open and back after, the cap, and the pill's width restored.
