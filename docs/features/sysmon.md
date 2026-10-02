# Feature: Btop (system monitor)

Status: **second iteration, implemented.** Public (in `make pack` output).

A compact, live view of this computer: CPU, graphics cards, memory, disks
and network. It is Phase 7 ("Metrics") of [DESIGN.md](../DESIGN.md) §10.

The tab is named **Btop**, with btop's "B" as its icon (user's choice,
2026-10-01). It does not run or embed btop. It is a native reader of
`/proc` and `/sys`, because btop is a terminal program with no structured
output and no library to embed (see "Why not btop" below). Code and
settings keys keep the `sysmon` id.

## Look

- **Size:** 460 × 480 px by default (user request, 2026-10-01), set in
  Settings → Btop → Size (`sysmon-width` 280-960, `sysmon-height`
  200-720), live like Notes'. Long names end in "…"; what does not fit
  the height scrolls.
- **Threads:** below 460 px wide, each thread in the fold-out has a row of
  its own; from 460, two share a row.
- **Rows:** each row is a name, then its value (a percentage or used /
  total), then a **level** of five cells, one per 20%:

  ```
  0% _____   20% ▂____   40% ▂▄___   60% ▂▄▆__   80% ▂▄▆▇_   100% ▂▄▆▇█
  ```

- **Level colours:** green, lime, yellow, orange, red; empty cells are
  grey.
- **Where levels appear:** the CPU and each thread, each GPU, RAM, root,
  swap and EFI. A value that is unknown has no level. Network rows have
  none, because a speed has no 100%.
- **Cells are separate labels:** each cell is its own label coloured by
  CSS (`froonty-sysmon-cell-1` to `-5`, `-empty`). A single label with
  Pango markup left its first character in the label's own colour.

## Polling: only while the tab is on screen

The tab is Froonty's one periodic timer (DESIGN.md §2). No event tells
when a CPU's load or a GPU's temperature changes, and the readings are
only worth anything live.

- It samples once when the tab comes on screen, again 0.5 s later (load
  and speed need two samples), then every `sysmon-interval` seconds (1-10,
  default 2). The interval uses `GLib.timeout_add_seconds`, so GLib can
  batch the Shell's wakeups.
- It stops when the island collapses, another tab is selected, the screen
  locks, or the extension is disabled (`SysmonService.setActive(false)`).
  A sample in flight is cancelled and dropped.
- A visit starts fresh. Hardware is found again (a GPU may have been
  plugged in), and load and speed start over, so they show "—" for the
  first 0.5 s.
- A slow sample never piles up: a tick that finds the previous one still
  running is skipped.
- Sections switched off in Settings are not read. With all of them off
  there is no timer.
- All reads are asynchronous (Gio); nothing blocks the compositor.

## What it shows, and where it comes from

### CPU

| Shown | Source |
|---|---|
| Model | `/proc/cpuinfo` "model name" (Arm: "Model"/"Hardware"), without "(R)", "(TM)" and the nominal clock |
| Load % | `/proc/stat`, busy over total jiffies since the previous sample (idle = idle + iowait) |
| Clock (GHz) | Average of `/proc/cpuinfo` "cpu MHz" over all threads; without those lines (non-x86), `cpufreq/scaling_cur_freq` |
| Temperature | The hwmon chip `coretemp` ("Package id 0"), `k10temp` ("Tctl"/"Tdie"), `zenpower`, or `cpu_thermal` |
| Threads (fold-out) | Each logical CPU's load from `/proc/stat`, and its core's temperature: coretemp's "Core N" matched to `cpuN/topology/core_id`. Per-core temperatures are read only while the fold-out is open; AMD (`k10temp`) has none, so it shows "—" |

The fold-out's state is kept in `sysmon-cores-expanded`.

### Graphics cards

Every `/sys/class/drm/cardN` with a PCI vendor, so several cards in a
workstation each get a row. simpledrm's boot framebuffer has no PCI
vendor and is left out. Names come from `pci.ids`
(`/usr/share/hwdata` or `/usr/share/misc`), with the bracketed marketing
name preferred ("AD104M [GeForce RTX 4080 Max-Q / Mobile]" → "NVIDIA
GeForce RTX 4080 Max-Q / Mobile"). For NVIDIA, `nvidia-smi`'s own name
replaces it once read.

| Driver | Load | Temperature | Power | Memory |
|---|---|---|---|---|
| `nvidia` (proprietary) | `nvidia-smi` | `nvidia-smi` | `nvidia-smi` | `nvidia-smi` |
| `amdgpu` | `gpu_busy_percent` | hwmon `temp1_input` | hwmon `power1_average` (or `power1_input`) | `mem_info_vram_used` / `_total` |
| `i915`, `xe` | not exposed (shows "—") | hwmon, discrete cards only | hwmon, if present | shared with RAM |
| others (`nouveau`, …) | — | hwmon, if present | hwmon, if present | — |

Intel cards report no load. Their row shows the current clock in MHz
instead (`gt_act_freq_mhz`, or `xe`'s `tile0/gt0/freq0/act_freq`), and
"Idle" when that is 0 MHz (power-gated).

GPU rows always keep room for their detail line, even when it is empty
(asleep or idle). An iGPU draws the desktop, so it goes between idle and
busy constantly; a row that grew and shrank with it made a list scrolled
to its end jump up every sample.

**Asleep cards are not woken up.** When a card's
`device/power/runtime_status` is `suspended` (an idle laptop dGPU), its
row is only its name and "Asleep": no level and no detail. Nothing else
is read from it. `nvidia-smi` and the drivers'
sysfs files can wake a runtime-suspended GPU, which costs battery.

**`nvidia-smi`.** NVIDIA's proprietary driver puts these readings nowhere
in `/sys`, so Froonty runs `nvidia-smi` once per interval while the tab
is on screen and an NVIDIA card is awake:

```
nvidia-smi --query-gpu=pci.bus_id,name,utilization.gpu,temperature.gpu,power.draw,memory.used,memory.total
           --format=csv,noheader,nounits -i <awake cards' PCI addresses>
```

- It is found in fixed system locations only (`/usr/bin`, `/bin`), never
  through `$PATH`.
- No shell is involved, and stderr is discarded.
- It is killed after 5 s.
- Measured at about 40 ms per run on an RTX 4080 Laptop GPU with driver
  580 (2026-10-01).
- Without it, the card's row says that nvidia-smi is needed.

### Memory

From `/proc/meminfo`:

- **Used** is `MemTotal − MemAvailable`, the same as `free`'s "used".
- **Cache** is `Buffers + Cached + SReclaimable`, `free`'s "buff/cache".

### Disks

- **Root** is the file system holding `/` (`g_file_query_filesystem_info`:
  size and used).
- **Swap** is `SwapTotal`/`SwapFree` from `/proc/meminfo`, all swap files
  and partitions together. It shows "None" without swap.
- **EFI** is the first of `/boot/efi`, `/efi` or `/boot` that
  `/proc/self/mounts` lists as a mounted FAT file system. An automount
  point (`autofs`) is skipped, because reading its size would mount it.
  Without one, it shows "Not mounted".

### Network

Download and upload speed are the change in `/proc/net/dev`'s byte
counters since the previous sample. The totals are the counters
themselves, normally since boot (they restart if a driver is reloaded).

Only **physical** interfaces count, meaning those with
`/sys/class/net/<if>/device`. Traffic through a VPN, ZeroTier or a
container bridge also crosses a physical interface, so counting it too
would double it. `lo` is not counted.

## Settings (Settings → Btop)

| Key | Default | |
|---|---|---|
| `sysmon-enabled` | true | Show the tab |
| `sysmon-interval` | 2 | Seconds between samples, 1-10 |
| `sysmon-show-cpu`, `-gpu`, `-memory`, `-disks`, `-network` | true | Sections; one that is off is not read |
| `sysmon-cores-expanded` | false | The threads fold-out is open |
| `sysmon-width`, `sysmon-height` | 460, 480 | The island's size while the tab is shown ("Default size" resets both) |

## Code

| File | |
|---|---|
| `features/sysmon/parse.js` | Pure parsers of `/proc`, `/sys`, `pci.ids` and `nvidia-smi` text |
| `features/sysmon/io.js` | Async Gio file reads, listings, links, file-system usage, and the subprocess with its timeout |
| `features/sysmon/sampler.js` | Hardware discovery and one snapshot per call, over an `io` object (faked in tests) |
| `features/sysmon/service.js` | The timer, tied to the tab being on screen, and the settings |
| `features/sysmon/level.js` | The five-cell level: glyphs and CSS classes for a share |
| `features/sysmon/view.js` | St view: actors made once, text updated per sample |
| `features/sysmon/icon.js`, `icons/` | btop's "B" as a symbolic icon (the tab and the settings page) |
| `features/sysmon/prefs.js` | Settings page |

Tests: `tools/unit/sysmon.test.js` covers the parsers, the levels, the
sampler over a fake `/proc` and `/sys` (Intel, NVIDIA and AMD cards, an
asleep card, no `nvidia-smi`), and the service's polling lifecycle
(including the 0.5 s follow-up). The headless run
checks the tab's size, that it polls only while on screen, that a sample
reaches it, and the threads fold-out.

## Limits of this iteration

- One CPU package. A second socket's temperature is not read.
- Intel GPU load is not shown. The kernel exposes it only through perf
  counters, which `intel_gpu_top` reads as root.
- Disk activity (read/write speed) is not shown, only usage.
- This computer only. Showing other machines needs an agent on each of
  them; it is not designed yet.
- Temperatures are in °C only.

## Why not btop

btop++ was considered as a source of data (a submodule under
`third_party/`). It was not used, for these reasons:

- It is a terminal program whose collectors draw straight to the
  terminal. It has no structured output to read.
- Embedding it would mean a terminal widget inside GNOME Shell's Clutter
  scene.
- A submodule would not be installed (`make install` copies only the
  extension directory) or packed.

The data it shows comes from the same `/proc` and `/sys` files read here.
