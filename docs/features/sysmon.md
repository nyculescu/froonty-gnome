# Feature: Btop (system monitor)

Status: **second iteration, implemented.**

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

The tab uses a periodic timer while it is on screen. No event tells
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
- Hardware is looked for only by a sample that reads it: the CPU's
  sensors for the CPU section, the graphics cards for the GPU section.
  The same holds for every sampler built on this one (panic buttons,
  Readouts, the System card, Settings → Fan), so one that reads only
  the CPU or RAM never lists the cards or reads `pci.ids`. A source
  switched to the GPU later finds them at its next sample.
- A slow sample never piles up: a tick that finds the previous one still
  running is skipped.
- Sections switched off in Settings are not read. With all of them off
  there is no timer.
- All reads are asynchronous (Gio); nothing blocks the compositor.

The optional CPU/GPU/RAM load and thermometer panic buttons share a sampler
while the island is open, at the configured refresh interval. They
stop sampling when the island collapses. The load button reads only the
selected source; RAM usage is used as a percentage. The thermometer can show
the mean of the physical cores' temperatures (a core's threads count once),
the hottest available CPU core, or the hottest reported GPU. When set to
follow the load button, it shows average CPU temperature for CPU or RAM
load (RAM has no general-purpose sensor) and GPU temperature for GPU load,
always in °C. CPU package temperature is used when no per-core reading is
available. Settings → Btop → Panic buttons chooses these sources.

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

`pci.ids` is 1.6 MB, and decoded whole it made a 3 MB string, which every
sampler used to keep. Now it is read only for a GPU model
(`vendor:device`) not named yet, and only its vendor's line and its
device's line are decoded from the file's bytes. The names are kept in
the sampler module for every sampler (`features/sysmon/sampler.js`), and
modules stay loaded through screen locks. So the file is read about once
per GNOME Shell process, and an updated `pci.ids` shows after the Shell
restarts. The names are the same as from the whole text: checked on
2026-11-27 for all 20,482 devices in this machine's `pci.ids`.

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
in `/sys`, so Froonty reads them with `nvidia-smi`. That happens only
while a GPU reading is on screen (this tab, a GPU panic button or
readout, the System card's GPU readings, Settings → Fan) and an NVIDIA
card is awake. How depends on whether the card can sleep at all:

- **A card that cannot sleep anyway** is read from one `nvidia-smi` that
  keeps running (`features/sysmon/nvidiaLoop.js`). A card counts as unable
  to sleep when its `device/power/control` is `on` (runtime power
  management off), its `power/runtime_status` is `unsupported`, or one of
  its outputs (`/sys/class/drm/cardN-*`) reads `connected` in `status`
  and `enabled` in `enabled`, so it lights a display. This laptop's RTX
  4080 lights its panel and the external monitor, so it is read this way.

  ```
  nvidia-smi --query-gpu=<the fields below> --format=csv,noheader,nounits
             -i <those cards' PCI addresses> -lms <shortest interval, ms>
  ```

  - It writes a line per card each interval, and a sample takes the
    latest. A line more than two intervals old counts as no reading.
  - The first sample after a start waits for its first lines, at most
    5 s, so the first reading of a visit has the GPU too.
  - One process serves every reader in the Shell. It runs at the
    shortest interval among them, and starts anew when that interval or
    the cards change: for example 1 s while Btop is open beside a GPU
    panic button at 2 s, then 2 s once Btop is left. Settings → Fan runs
    in the settings window's process, so it has its own, stopped when the
    page is left or the window closes (no disable reaches that process).
  - A process that writes nothing for three intervals, or 5 s if longer
    (a wedged driver, say), is killed and started again, as a single run
    used to be given up after 5 s.
  - A card found able to sleep again (its display unplugged, say) is
    dropped by every reader at once, so the process does not keep it
    awake until the slowest reader's next sample.
  - If it ends by itself, it starts again after 1 s, then twice as long
    each time, up to a minute. A reading resets the wait.
  - It is killed when the last reader stops reading GPUs, goes off screen
    or stops. That covers every screen lock and disable, so it never
    outlives them. Should GNOME Shell end without a disable (a crash), it
    ends at its next line: `nvidia-smi` exits once nothing reads its
    output (checked 2026-11-27).
  - Readings may be up to one interval old, where a run gave them fresh
    at each sample.
  - Measured on this laptop in the CPU and RAM audit of 2026-11-27: about
    0.09 ms of CPU per reading, against about 19 ms per run, plus a fork
    of GNOME Shell for each run. The running process takes about 22 MB.
- **Any other awake card** (an idle laptop dGPU that lights nothing) gets
  one run per sample, as before:

  ```
  nvidia-smi --query-gpu=pci.bus_id,name,utilization.gpu,temperature.gpu,power.draw,memory.used,memory.total
             --format=csv,noheader,nounits -i <awake cards' PCI addresses>
  ```

  A running `nvidia-smi` is an NVML client, and that keeps a card from
  runtime-suspending. Between runs it still can.
- **The check** runs on every sample, so a display that is switched off
  or unplugged lets the card sleep again: the shared process stops at the
  next sample. It reads only files that report what the kernel already
  knows, and only for a card that already reads awake. On 2026-11-27,
  reading the suspended Intel card's outputs and `power/control` left it
  suspended. The NVIDIA card here never sleeps, so the same reads could
  not be tried on it; its outputs' files come from the same DRM core.
  Outputs that appear after the cards were found count from the next
  visit.
- It is found in fixed system locations only (`/usr/bin`, `/bin`), never
  through `$PATH`.
- No shell is involved, and stderr is discarded.
- A run is killed after 5 s.
- Measured at about 40 ms per run on an RTX 4080 Laptop GPU with driver
  580 (2026-10-01).
- Without it, the card's row says that nvidia-smi is needed.

### Memory

From `/proc/meminfo`:

- **Used** is `MemTotal − MemAvailable`, the same as `free`'s "used".
- **Cache** is `Buffers + Cached + SReclaimable`, `free`'s "buff/cache".

### Disks

Every mounted drive, with used / total (user request, 2026-11-13), each
read with `g_file_query_filesystem_info`:

- **The list** is every file system in `/proc/self/mounts` whose source
  is a `/dev/` device. Each device appears once, at its shortest mount
  point, because a btrfs subvolume or a bind mount isn't another drive.
  Pseudo file systems (proc, tmpfs, overlay, FUSE such as gvfs) and
  automount points (`autofs`, whose size read would mount them) are left
  out. Network shares are left out too, because a stalled server would
  hold a reader.
- **Names:** **Root** for `/`. **EFI** for the first of `/boot/efi`,
  `/efi` or `/boot` mounted as FAT. A desktop mount
  (`/run/media/USER/NAME`, `/media/USER/NAME`) uses its volume name. Any
  other drive uses its mount point. Root comes first, then EFI, then the
  rest by name, with virtual drives last.
- **The line under each** gives what the drive is, its file system type
  and its mount point. "What it is" is the disk's model from
  `/sys/class/block/DISK/device/model`, plus "USB" when it sits on a USB
  bus. For a partition, DISK is the folder that holds it.
- **Virtual drives** carry a "Virtual" tag:
  - A drive that a debug probe or bootloader emulates over USB for
    drag-and-drop flashing, recognised by its SCSI vendor: `SEGGER`
    (J-Link), `MBED` (ST-LINK and DAPLink boards) or `RPI` (the RP2
    bootloader).
  - A disk image on a loop device, named by its backing file
    (`/sys/class/block/loopN/loop/backing_file`).
  - **Snap packages:** the read-only squashfs images under `/snap/`, one
    per installed revision, in one row with their count and total size.
    Their sizes are read once per mount.
- What a device is gets read once per mount (source and mount point), so
  a different drive that gets the same `/dev/sdX` is read again.
- **Swap** is `SwapTotal`/`SwapFree` from `/proc/meminfo`, all swap files
  and partitions together. It shows "None" without swap.
- The disk readout on the pill still shows Root's share.

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
| `sysmon-panic-load-source` | `'cpu'` | What the load panic button shows: `cpu`, `gpu` or `memory` |
| `sysmon-panic-temp-source` | `'load-source'` | What the thermometer panic button shows: `average-cpu`, `max-cpu`, `gpu`, or `load-source` (follows the load button) |

## Code

| File | |
|---|---|
| `features/sysmon/parse.js` | Pure parsers of `/proc`, `/sys`, `pci.ids` (text or bytes) and `nvidia-smi` text |
| `features/sysmon/io.js` | Async Gio file reads (text or bytes), listings, links, file-system usage, the subprocess with its timeout, and a running process's lines |
| `features/sysmon/sampler.js` | Hardware discovery and one snapshot per call, over an `io` object (faked in tests); the GPU names for every sampler |
| `features/sysmon/nvidiaLoop.js` | The shared `nvidia-smi -lms` for cards that cannot sleep: held by samplers, killed by the last release |
| `features/sysmon/service.js` | The timer, tied to the tab being on screen, and the settings |
| `features/sysmon/panicMetrics.js` | The load and thermometer panic buttons' shared sampler and their values |
| `features/sysmon/level.js` | The five-cell level: glyphs and CSS classes for a share |
| `features/sysmon/view.js` | St view: actors made once, text updated per sample |
| `features/sysmon/icon.js`, `icons/` | btop's "B" as a symbolic icon (the tab and the settings page), and the CPU, GPU, memory and thermometer icons of the panic buttons |
| `features/sysmon/prefs.js` | Settings page |

Tests: `tools/unit/sysmon.test.js` covers the parsers (`pci.ids` from its
bytes giving the same names), the levels, the sampler over a fake `/proc`
and `/sys` (Intel, NVIDIA and AMD cards, an asleep card, no `nvidia-smi`,
hardware found only for the sections read, `pci.ids` read once per io),
the shared `nvidia-smi` (a lit panel or runtime power management off, one
process for several samplers at the shortest interval, a display switched
off, stale lines, starting again after an exit or a failed start, a
cancelled sample, a Btop sample under way when the GPU section is turned
off, the release by Btop, the panic buttons and the Readouts, and reading
on after the line handler fails, with a real `/bin/sh`), and the service's
polling lifecycle (including the 0.5 s follow-up). The headless run
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
  extension directory).

The data it shows comes from the same `/proc` and `/sys` files read here.
