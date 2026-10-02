# Feature: Kill Process

Status: **first iteration, implemented**, 2026-10-02. Public (in `make
pack` output). **Off by default.**

A list of your own processes, busiest first, with a button to kill each.
It is for the moment an app hangs or something eats the CPU or the
memory, without opening a terminal or System Monitor. It is not a process
manager: no tree, no priorities, no other users.

## Look

```
[ ⌕ Filter by name, command or PID        ] [CPU] [Memory]
Top 30 of your 256 processes
firefox           4242    12%   1.4 GiB   ⊘
Isolated Web Co   4318   3.1%   402 MiB   ⊘
gnome-shell       2000   1.9%   1.0 GiB   🔒
sleep             5150   0.0%   1.0 MiB   [Kill “sleep”?] ✕
```

- **Size:** 480 × 440 px by default, set in Settings → Kill Process →
  Size (`killprocess-width` 360-960, `killprocess-height` 200-720), live
  like Notes'.
- **Rows:** the process's name, its process id (dim), its CPU share, its
  memory, and what can be done with it. Hovering the name shows the whole
  command line (up to six lines) and, for a protected process, why.
- **Name:** argv[0]'s file name when the kernel's name (comm, cut to 15
  characters) is that name ("gnome-session-binary", not
  "gnome-session-b"); otherwise comm, which a process may set itself
  ("Isolated Web Co", a Firefox tab).
- **At most 30 rows** (`ROW_LIMIT`), the busiest by CPU or by memory
  (the two toggles; the choice is kept in `killprocess-sort`). The filter
  finds any other process: it matches the process id, the name and the
  command line, ignoring case. The tab takes the key focus when shown,
  so typing filters at once. The filter is cleared when the tab is hidden.
- **CPU** is the process's share of the whole computer since the
  previous reading (100% = every CPU busy), as GNOME System Monitor shows
  it by default (`org.gnome.gnome-system-monitor solaris-mode`, default
  true, checked 2026-10-02). It needs two readings, so it shows "—" for
  the first 0.5 s of a visit; meanwhile the list is sorted by memory.
- **Memory** is the resident size (RSS, what `top` calls RES), shared
  pages included.

## Killing: two clicks, SIGTERM first

1. **⊘** on the row. Nothing is sent yet: the row shows **"Kill
   “name”?"** (red) and **✕** (cancel).
2. **"Kill “name”?"** sends **SIGTERM**: the process is asked to quit and
   may save its work first. The row shows "Asked to quit…"; when the
   process is gone, the line over the list says "“name” (pid) has
   ended." in blue, until the filter changes.
3. Still running **3 s** later (`FORCE_AFTER_S`)? The row offers
   **"Force quit"**, which sends **SIGKILL**: the process ends at once and
   unsaved work is lost. It is never offered before SIGTERM was tried,
   and the service refuses SIGKILL for a process that is not in that
   state, whatever the view asks.

✕ sits exactly where ⊘ was, so a double click on ⊘ cancels instead of
confirming. "Force quit" takes the same place, but only appears seconds
later. The keyboard works too (Tab, Enter or Space); after ⊘ the focus
moves to the confirmation.

**What is under the pointer stays put.** While the pointer is on the list,
or a kill waits for its confirmation, each row keeps its process. The
numbers still update, and a process that ends stays as "Ended". The list is
re-sorted only when the pointer leaves. Without this, a list that re-sorts
every few seconds could move another process under the button just as it
is clicked. For the same reason the latest kill's result takes the place
of the count over the list instead of a line of its own: a line that
appeared would push the rows down (the first headless run caught exactly
that).

## Safety rules (why each)

Froonty runs inside GNOME Shell, so a wrong kill can end the whole
session. These rules are in `rules.js` and `sampler.js`, and are checked
again right before every signal (`ProcessSampler.verify()`):

- **Only your own processes are listed and killed.** Killing another
  user's process needs root, and Froonty never asks for elevation (no
  `pkexec`). Listing them anyway would mean rows with no button, and more
  reading. A process is yours when its `/proc/<pid>` directory is
  (one listing of `/proc` with each entry's owner), and, before a signal,
  when the real user id in `/proc/<pid>/status` is yours. Kernel threads
  and processes that have already ended (zombies) are left out.
- **Never GNOME Shell itself** (its process id, from
  `Gio.Credentials.get_unix_pid()`), **nor whatever started it**: the
  chain of parents from GNOME Shell up to init (`systemd --user`, or
  gnome-session and gdm's session wrapper). Killing any of them ends the
  Shell, and with it Froonty and the session. The chain is read again
  before each signal, so a parent that changed since the last reading is
  still covered.
- **Never these session programs** (`PROTECTED_NAMES`), matched on the
  kernel's name (cut to 15 characters) or on argv[0]'s file name:

  | Program | Why |
  |---|---|
  | `gnome-shell` | The compositor; any instance |
  | `gnome-session*` | The session itself, and its helpers (`-binary`, `-service`, `-ctl`, `-init-worker`) |
  | `gdm-wayland-session`, `gdm-x-session` | The login's session wrapper: its end is a logout |
  | `systemd` (the user's manager), `(sd-pam)` | Every user service, GNOME Shell's included |
  | `Xwayland` | Every X11 window |
  | `dbus-daemon`, `dbus-broker`, `dbus-broker-launch` | The session and accessibility buses |
  | `pipewire`, `pipewire-pulse`, `wireplumber` | Sound, screen sharing, the panic mute buttons |
  | `gnome-keyring-daemon` | The session's passwords and keys |

  The list is short on purpose. Anything else (an app, a `gsd-*` daemon,
  ibus) is the user's call, even when killing it breaks something until
  the next login. Protected rows show a lock instead of ⊘. Settings → Kill Process lists the programs.
  A program that names itself like one of these only loses its kill
  button.
- **Only a valid process id** (`isValidPid`): a whole number from 2 to
  2²² (`PID_MAX_LIMIT`). 0 and negative ids mean process groups, and `-1`
  means every process the user has; 1 is init.
- **Never a reused process id.** A process is identified by its id *and*
  its start time (`/proc/<pid>/stat` field 22, in clock ticks since boot),
  which no other process has had since boot. Right before each signal the
  start time is read again; if it differs, the process has ended and the
  kernel has given its id to another one, and nothing is sent ("had
  already ended").

What remains: between that last check and `kill(1)` acting there are a
few milliseconds in which the process could end and its id be reused. The
kernel hands ids out in order up to `pid_max` (4194304 on this machine),
so reuse within milliseconds would need millions of new processes in
between. A pidfd would close that gap, but GJS cannot open one, and
procps' `kill` 4.0.4 has no way to be handed one.

## How the signal is sent

GJS cannot call `kill(2)`, and neither GLib, Gio nor GNOME Shell 50's
Shell library offers it (checked by introspection, 2026-10-02):
`Gio.Subprocess.send_signal()` reaches only the processes it started, and
`Meta.Window.kill()` only processes with a window.

So each confirmed step runs procps' **`kill`** once:

```
/usr/bin/kill -s TERM <pid>      (or -s KILL for "Force quit")
```

- Found at a fixed location (`/usr/bin/kill`, `/bin/kill`), never through
  `$PATH`, as the ZeroTier and nvidia-smi calls are.
- A fixed argument list built by `killArgv()`, which throws for anything
  but those paths, `TERM` or `KILL`, and a valid process id. No shell.
- Through the Btop tab's `run()` (`features/sysmon/io.js`): asynchronous,
  stderr discarded, killed after 5 s.
- Only on a click: nothing runs while the tab merely lists processes.
- If `kill` fails, the process is read once more: "had already ended" or
  "Could not kill". Without `/usr/bin/kill` the tab says it is missing.

## Reading: only while the tab is on screen

Like the Btop tab's, this is a periodic timer that runs only while its
tab is on screen (DESIGN.md §2 and §8). CPU use is only worth anything
live, and no event says when it changes.

- One reading when the tab comes on screen, another 0.5 s later (CPU
  needs two), then every `killprocess-interval` seconds (1-10, default 3),
  with `GLib.timeout_add_seconds` so GLib can batch the Shell's wakeups.
- While a kill is under way, an extra reading 0.5 s after each signal and
  then every second, until the process is gone, so "has ended" and
  "Force quit" show without waiting for the interval.
- It stops when the island collapses, another tab is selected, the screen
  locks, or the extension is disabled (`KillProcessService.setActive(false)`).
  A reading in flight is cancelled and dropped; kills in progress are
  forgotten (a signal already sent stays sent).
- A slow reading never piles up: a tick that finds the previous one still
  running is skipped.
- All reads are asynchronous (Gio); nothing blocks the compositor.

Each reading:

| Read | How often |
|---|---|
| `/proc` listed once, with each entry's owner (`unix::uid`) | Every reading |
| `/proc/stat` (the whole computer's CPU time) | Every reading |
| `/proc/<pid>/stat` for each of your processes | Every reading |
| `/proc/<pid>/cmdline` | Once per process (kept by process id and start time, dropped when it ends or the tab is hidden) |
| `/proc/self/stat`, `/proc/self/status` (the page size, for memory) | Once per Shell session |
| `/proc/<pid>/stat`, `status`, `cmdline`, and `stat` up GNOME Shell's parents | Right before each signal |

Measured on the development machine (2026-10-02), from plain `gjs` with
the same Gio calls, not inside the Shell: 733 processes, 256 of them the
user's; listing `/proc` took 6-12 ms, reading 256 `stat` files 17-51 ms,
and 256 command lines 12-27 ms of wall time. Most of that is in GIO's
worker threads, not on the main thread. Treat these as one machine's
figures, not a guarantee.

## Settings (Settings → Kill Process)

| Key | Default | |
|---|---|---|
| `killprocess-enabled` | false | Show the tab |
| `killprocess-interval` | 3 | Seconds between readings, 1-10 |
| `killprocess-sort` | `cpu` | `cpu` or `memory`; chosen with the toggles in the tab |
| `killprocess-width`, `killprocess-height` | 480, 440 | The island's size while the tab is shown ("Default size" resets both) |

**Off by default**, because it is a destructive tool: one confirmed click
ends a program and loses its unsaved work. Like the Clipboard tab, it is
the user's choice to show it. The settings page also lists what is never
killed.

## Code

| File | |
|---|---|
| `features/killprocess/parse.js` | Pure parsers: `/proc/<pid>/stat`, `status`, `cmdline`; the shown name; page size; CPU share |
| `features/killprocess/rules.js` | Pure rules: valid process ids, `PROTECTED_NAMES`, GNOME Shell's ancestors, sorting and filtering |
| `features/killprocess/kill.js` | Pure: where `kill` may be, and its argument list |
| `features/killprocess/io.js` | The Btop tab's `SYSTEM_IO` plus a `/proc` listing with owners; GNOME Shell's own process and user ids |
| `features/killprocess/sampler.js` | One reading of your processes, and `verify()` before a signal, over an `io` object (faked in tests) |
| `features/killprocess/service.js` | The timer, tied to the tab being on screen; the kill steps |
| `features/killprocess/view.js` | St view: filter, sort toggles, reused rows, the two-step kill |
| `features/killprocess/prefs.js` | Settings page |

The `/proc/stat` parser is the Btop tab's (`features/sysmon/parse.js`).

## Tests

- `tools/unit/killprocess.test.js` (plain gjs, `make unit`): the parsers
  (including this test process's own `/proc/self/stat`, read only), valid
  process ids, `killArgv` refusing anything else (`-1`, `0`, `1`, text,
  other signals, other paths), the protected names and ancestors, sorting
  and filtering, the sampler over a fake `/proc` (other users, zombies and
  kernel threads left out; CPU from the second reading; command lines read
  once), `verify()` (reused id, another user, ended, protected, an
  ancestor that appeared since the last reading), and the service: SIGTERM
  then "ended", "Force quit" only once stuck, nothing sent for a reused id,
  a protected process, a forged `-1` or while hidden. The fake `run()` only
  records its arguments; **no unit test signals a real process**.
- `tools/headless-test/checks.js` (`testKillProcess`): off by default; the
  tab's size; only the user's processes; GNOME Shell, its parent and
  `dbus-daemon` protected, with a lock and no ⊘; `verify()` refuses GNOME
  Shell; typing filters; a reused id is refused for real; a `sleep` the
  test started is killed through the UI (⊘, then "Kill “sleep”?") and ends
  with SIGTERM; "Ended", then gone once the pointer leaves; a `sleep` that
  ignores SIGTERM is not offered "Force quit" at 1 s, is at 3 s, and ends
  with SIGKILL; no reading while another tab is shown or the island is
  collapsed. The test clicks only rows of processes it spawned, checking
  the row's process id before each click, and ends any leftovers with
  `Gio.Subprocess.force_exit()` (its own children only).

## Limits of this iteration

- **Processes that made themselves non-dumpable** (`prctl(PR_SET_DUMPABLE,
  0)`) have a root-owned `/proc/<pid>` and are not listed. On the
  development machine none of the user's processes was (ssh-agent and
  gnome-keyring-daemon included, 2026-10-02); elsewhere one may be.
- A process stuck in the kernel (state D) does not end even with SIGKILL
  until the kernel lets it; its row stays "Force quitting…".
- No process tree: killing a parent does not kill its children, and the
  tab does not show which is which.
- Threads are not listed; a process's CPU share is all its threads'.
- Processes in other PID namespaces (Flatpak sandboxes) appear with their
  ids as seen from the host, which is what `kill` needs.
