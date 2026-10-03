# Feature: Kill Process

Status: **second iteration, implemented**, 2026-10-02: every process
instead of the busiest 30, a thread count, and sorting by threads (user
request); after its review, the keyboard and the pointer kept apart, a
row out of sight never acted on, readings in batches, and processes
whose main thread exited listed. Public (in `make pack` output). **Off
by default.**

All of your own processes, sorted by CPU load, memory or threads, with a
button to kill each. It is for the moment an app hangs or something eats
the CPU or the memory, without opening a terminal or System Monitor. It is
not a process manager: no tree, no priorities, no other users.

## Look

```
[ ⌕ Filter by name, command or PID   ] [CPU] [Memory] [Threads]
Your 256 processes
firefox           4242    12%   1.4 GiB    87   ⊘
Isolated Web Co   4318   3.1%   402 MiB    25   ⊘
gnome-shell       2000   1.9%   1.0 GiB    31   🔒
sleep             5150   [Kill “sleep”?] ✕
```

- **Size:** 520 × 440 px by default (480 before the Threads column; the
  name keeps about 170 px), set in Settings → Kill Process → Size
  (`killprocess-width` 360-960, `killprocess-height` 200-720), live like
  Notes'.
- **Rows:** the process's name, its process id (dim), its CPU share, its
  memory, its number of threads, and what can be done with it. The
  column the list is sorted by is brighter than the other two. Hovering
  the name shows the whole command line (up to six lines), the process id
  and thread count, and, for a protected process, why. While a kill waits
  for its confirmation (or "Force quit" is offered), the numbers make
  room for the buttons.
- **Name:** argv[0]'s file name when the kernel's name (comm, cut to 15
  characters) is that name ("gnome-session-binary", not
  "gnome-session-b"); otherwise comm, which a process may set itself
  ("Isolated Web Co", a Firefox tab).
- **Every process is listed**, however many: the line over the list says
  "Your 256 processes", or, with a filter, "12 of your 256 processes
  match". The filter matches the process id, the name and the command
  line, ignoring case. The tab takes the key focus when shown, so typing
  filters at once. The filter is cleared, and the list scrolled back to
  the top, when the tab is hidden.
- **Sorting:** three toggles, **CPU** (the default), **Memory** and
  **Threads**, most first; the choice is kept in `killprocess-sort`.
  Ties go to the busier process (CPU, then memory), then to the lower
  process id, so equal readings keep their order. Choosing another sort
  scrolls back to the top.
- **CPU** is the process's share of the whole computer since the
  previous reading (100% = every CPU busy), as GNOME System Monitor shows
  it by default (`org.gnome.gnome-system-monitor solaris-mode`, default
  true, checked 2026-10-02). It needs two readings, so it shows "—" for
  the first 0.5 s of a visit; meanwhile the CPU sort orders by memory.
- **Memory** is the resident size (RSS, what `top` calls RES), shared
  pages included. "—" for a process whose main thread has exited while
  its other threads run: the kernel reports no memory for it (see the
  safety rules).
- **Threads** is the process's number of threads (`num_threads`, field
  20 of `/proc/<pid>/stat`, the file read for CPU and memory anyway: no
  extra read).
- **The overlay scroll bar** has 14 px of room on the right of the
  list, as in the Btop and Clipboard tabs, so it covers no number and no
  button.

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
later. The keyboard works too (Tab, Enter or Space); after ⊘ pressed
from the keyboard the focus moves to the confirmation, and after ✕ back
to ⊘. A click leaves the focus where it was (in the filter, usually),
unless it was on that row's button that the click hides.

**What is under the pointer stays put.** While the pointer is on the list,
a kill waits for its confirmation, or the keyboard has put the focus on a
row's button, each row keeps its process. The numbers still update, and a
process that ends stays as "Ended". The list is re-sorted only when the
pointer leaves (or, for the keyboard, at the next reading after the focus
left the list). Without this, a list that re-sorts every few seconds could
move another process under the button just as it is clicked. The line
over the list still counts today's processes ("12 of your 256 processes
match"), not the rows held. Scrolling still moves the rows, as the user
asks. For the same reason the latest kill's result takes the place of the
count over the list instead of a line of its own: a line that appeared
would push the rows down (the first headless run caught exactly that).

**The keyboard and the pointer do not mix.** Focus that a click left on a
row does not hold the list: before 2026-10-02 a mouse user who cancelled
a kill (✕ moved the focus to ⊘) found the list frozen, unsorted and
missing new processes, until the focus happened to move. Tab walks the
rows, and the list scrolls to show the row it reaches, even with the
pointer resting on the list: the rows just beyond the visible part exist
(see "Many processes") and Tab reaches them, so without this, two Enter
presses could kill a process out of sight (the review reproduced it
before the fix). A click never scrolls the list.

**Only what is on screen acts.** ⊘, the confirmation and "Force quit"
act only while some of their row is in the visible part of the list. A
key pressed on a row out of sight only scrolls it into view; asked by
anything else (an accessibility tool, say), nothing happens.

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
  and processes that have already ended (zombies) are left out. A zombie
  main thread whose other threads still run is not an ended process: a
  program may end its main thread alone (`pthread_exit()`), and the
  kernel then shows that thread as a zombie (state `Z`) with the others
  counted in `num_threads`. Such a process is listed and can be killed (a
  signal to its id reaches its threads); it has ended only once it has
  one thread left (checked on real processes, 2026-10-02: a Python
  program whose main thread called `pthread_exit()` read `Z`, 2 threads,
  resident size 0 and an empty command line; zombies waiting to be reaped,
  with one thread or four before they exited, read 1).
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
  running is skipped. The interval's ticks also wait for ten times as long
  as the previous reading took (`PACE`), so a reading of very many
  processes, or on a busy machine, comes less often than the interval says
  rather than take more of the Shell's time. The early readings (after a
  kill, the visit's second) are not held back.
- All reads are asynchronous (Gio), but each costs the Shell's main
  thread some tens of microseconds in GJS (starting it, then its
  completion), and the completions come at the default priority, ahead of
  Clutter's redraws. Read all at once, a thousand processes held frames
  off for 70-160 ms in the headless Shell. So the files are read 32 at a
  time (`BATCH`), each batch parsed as it comes, with a pause between
  batches (`io.pause()`: an idle at `PRIORITY_DEFAULT_IDLE`, after due
  frames, cancelled with the reading); the view's refresh (sorting,
  filling the rows) gets a turn of the main loop of its own after the
  last batch. What a command line tells (the name shown, the command, a
  protected name) is worked out once per process, not at every reading.

Each reading:

| Read | How often |
|---|---|
| `/proc` listed once, with each entry's owner (`unix::uid`) | Every reading |
| `/proc/stat` (the whole computer's CPU time) | Every reading |
| `/proc/<pid>/stat` for each of your processes (CPU time, memory, threads, start time) | Every reading |
| `/proc/<pid>/cmdline` | Once per process (kept by process id and start time, dropped when it ends or the tab is hidden) |
| `/proc/self/stat`, `/proc/self/status` (the page size, for memory) | Once per Shell session |
| `/proc/<pid>/stat`, `status`, `cmdline`, and `stat` up GNOME Shell's parents | Right before each signal |

Measured on the development machine (2026-10-02), from plain `gjs` with
the same Gio calls, not inside the Shell: 733 processes, 256 of them the
user's; listing `/proc` took 6-12 ms, reading 256 `stat` files 17-51 ms,
and 256 command lines 12-27 ms of wall time. Most of that wall time is
the main thread's own, not GIO's worker threads' (an earlier version of
this note said otherwise): reading 1620 `stat` files with
`load_contents_async` took 50-150 ms of the main thread's CPU time
(starting the reads alone 17-55 ms), against 12-37 ms for the same files
read synchronously, which the extension guidelines rule out. With the
batches, a reading in plain `gjs` (the real `ProcessSampler`, 10 readings
each, load average about 11) held the main loop for at most 2-9 ms at a
time with 332 processes (19-52 ms of main-thread CPU per reading), and
3-6 ms with 1324 (the user's served four times; 59-128 ms of CPU);
without the pauses, 21-136 ms for the same CPU. The spread between runs
is large (this machine mixes fast and slow cores). Inside the headless
Shell, see "Many processes" below. Treat these as one machine's figures,
not a guarantee.

## Many processes: only the rows on screen exist

Every process is listed, a few hundred on a desktop (about 260 on the
development machine), possibly more than a thousand elsewhere, and the
list refreshes every 3 s while it is on screen. A row is a dozen St
actors, so one row per process would cost the Shell more than the
reading itself:

- **Only the rows on screen exist**, and four beyond each edge so a
  scroll shows rows that are ready: 23 row actors at the default size,
  whether the list holds 300 processes or 1000. Two spacers stand in for
  the others, so the scroll bar is right. Every row is as tall as the
  others (the theme's 26 px `min-height`), so a process's place is its
  index times a row's height; the height is measured once the list is
  laid out.
- **A row keeps its process** while that process is among the rows that
  exist: a re-sort moves row actors instead of rewriting their texts, and
  a scroll by one row moves one actor. Rows are made once and never
  destroyed before the view.
- **A row sets only what changed**: a refresh in the same order sets the
  numbers that moved; the texts that name a process (and its accessible
  names) only when the row takes another process.
- **Texts are translated once per view.** The Shell's `gettext` for
  extensions (`extensions/sharedInternals.js`, GNOME Shell 50) finds the
  calling extension from a stack trace on every call; at four or five
  calls per row that took another process, it was about two thirds of
  that row's update (0.24 ms; 0.08 ms without it, measured in the
  headless Shell).
- A scroll or a new height (both may come in the middle of a layout
  pass) fills the rows in a `BEFORE_REDRAW` later, at most one pending,
  removed when the tab is hidden. While the tab is hidden none is queued,
  and nothing is sorted or filled: a collapsing island still lays the
  list out at each step of its animation (8 fills after the tab was
  hidden, before this was fixed), and a settings change still reaches the
  view. `setActive(true)` fills it again.

Measured in the headless GNOME Shell 50 of `tools/headless-test` (software
rendering, on the development machine, 2026-10-02). "JS" is the
main-thread time of the refresh itself (`_sync` with a new reading:
sorting, filling the rows); layout is the stage update that follows
(before-update to prepare-frame), against 0.9-2.2 ms for an idle frame.
The left column is the first iteration's pooled rows with the 30-row cap
removed, measured once; the right one is four runs of the whole suite
(both session modes). Figures vary about twofold between runs; other
work on the machine and garbage collection are the likely causes. In a
run of the Kill Process checks alone, a full reorder of the real list
took 2.7-3.0 ms, of which `_sync` itself 1.5 ms (1.2 ms filling 23
rows). Treat these as one machine's figures, not a guarantee.

| Refresh | One row per process | Rows on screen only |
|---|---|---|
| Real list (257-308 processes), new numbers and order | 95-243 ms JS, layout 15-43 ms | 5.5-13.6 ms JS, layout 1.7-4.2 ms |
| 1000 made-up processes, first show | 1153 ms JS, layout 103 ms | 15-42 ms JS, layout 3.0-9.5 ms |
| 1000, new numbers, same order | 497 ms JS, layout 55 ms | 1.1-2.8 ms JS, layout 0.4-1.2 ms |
| 1000, new numbers and order | 703 ms JS, layout 125 ms | 2.7-9.1 ms JS, layout 1.1-3.9 ms |
| 1000, jump to the middle | 1.2 ms JS, layout 6.5 ms (all rows exist) | 2.6-7.6 ms JS, layout 1.3-3.7 ms |
| 1000, scroll by one row | (not measured) | 0.6-1.0 ms JS, layout 0.4-0.8 ms |

"New numbers and order" gives every process a new CPU share at random, so
nearly every row takes another process: the worst case. A refresh in
which few processes change places (memory or threads sort, an idle
desktop) costs about what "same order" does.

The made-up processes run in a second view over a fake service (it
signals nothing), in the tab's place. The headless check fails if more
than 40 row actors exist, if a refresh makes new ones, or if the median
of three reordered refreshes of 1000 takes 100 ms of JS or more. That
bound only catches one row per process again (497-703 ms): the figures
themselves vary with the machine's load (medians of 11.8-24.1 ms, single
refreshes up to 49 ms, with 24 CPU-bound processes running beside the
test), so they are notes, not a limit. An earlier 10 ms limit failed on
a busy machine with nothing wrong.

**The whole refresh.** The figures above are the view's part only. Every
few seconds the tab also reads `/proc`, and that costs the main thread
more than sorting and filling the rows. Measured in the same headless
Shell (2026-10-02, load average about 11, one run of the Kill Process
checks): the real service and view, over an `io` that serves each of the
user's processes once or four times under made-up ids (real Gio reads of
the real files; nothing can be killed), five readings after the first,
with a 1 ms timer at Clutter's redraw priority to find the longest time
no frame could have been drawn:

| Processes | Main-thread CPU per reading | Wall time | Longest hold of the main loop |
|---|---|---|---|
| 346 (the user's) | 20-55 ms | 28-62 ms | 2.2-9.9 ms, of which `_sync` 1.3-7.0 ms |
| 1384 (four times) | 71-180 ms | 85-193 ms | 4.2-12.5 ms, of which `_sync` 2.2-7.1 ms |
| 1384, the visit's first reading (command lines too) | 236 ms | 253 ms | 11.0 ms |

Before the batches, a reading of about 1250 processes held the loop for
the whole reading: no frame for 70-158 ms in each of 12 readings (the
review's measurement, same Shell and machine). The headless check fails
if a reading does not pause at least once per batch, or if the median
longest hold is half of the reading's own length or more (it was 0.05-0.10
here; a reading in one block would be about 1), never on a time in
milliseconds.

## Settings (Settings → Kill Process)

| Key | Default | |
|---|---|---|
| `killprocess-enabled` | false | Show the tab |
| `killprocess-interval` | 3 | Seconds between readings, 1-10 |
| `killprocess-sort` | `cpu` | `cpu`, `memory` or `threads`; chosen with the toggles in the tab |
| `killprocess-width`, `killprocess-height` | 520, 440 | The island's size while the tab is shown ("Default size" resets both) |

**Off by default**, because it is a destructive tool: one confirmed click
ends a program and loses its unsaved work. Like the Clipboard tab, it is
the user's choice to show it. The settings page also lists what is never
killed.

## Code

| File | |
|---|---|
| `features/killprocess/parse.js` | Pure parsers: `/proc/<pid>/stat` (thread count included), `status`, `cmdline`; the shown name; page size; CPU share |
| `features/killprocess/rules.js` | Pure rules: valid process ids, `PROTECTED_NAMES`, GNOME Shell's ancestors, sorting, filtering and the count line |
| `features/killprocess/kill.js` | Pure: where `kill` may be, and its argument list |
| `features/killprocess/io.js` | The Btop tab's `SYSTEM_IO` plus a `/proc` listing with owners and a pause between batches of reads; GNOME Shell's own process and user ids |
| `features/killprocess/sampler.js` | One reading of your processes (in batches), and `verify()` before a signal, over an `io` object (faked in tests) |
| `features/killprocess/service.js` | The timer, tied to the tab being on screen and paced by the readings' length; the kill steps |
| `features/killprocess/view.js` | St view: filter, sort toggles, the list with only its visible rows (reused), the two-step kill |
| `features/killprocess/prefs.js` | Settings page |

The `/proc/stat` parser is the Btop tab's (`features/sysmon/parse.js`).

## Tests

- `tools/unit/killprocess.test.js` (plain gjs, `make unit`): the parsers
  (including this test process's own `/proc/self/stat`, read only), valid
  process ids, `killArgv` refusing anything else (`-1`, `0`, `1`, text,
  other signals, other paths), the protected names and ancestors, the
  thread count (field 20, and this process's own against its
  `/proc/self/status`), a zombie main thread with other threads (live)
  or with one (ended), sorting by CPU, memory or threads with their
  tie-breaks, a thousand processes in and a thousand out (no limit),
  filtering and counting the matches, the count line ("Your 256
  processes", "12 of your 256 processes match", singulars), the sampler
  over a fake `/proc` (other users, zombies and kernel threads left out, a
  process whose main thread exited listed with memory unknown; CPU from
  the second reading; thread counts; command lines read once; reads
  `BATCH` at a time with a pause between, none after a cancel; the name
  and protection worked out again on a rename), `verify()` (reused id,
  another user, ended, protected, an ancestor that appeared since the last
  reading, a process whose main thread exited), the pause itself (after
  pending IO completions and redraw-priority work; cancelled, it ends at
  once and its idle never runs), and the service: SIGTERM then "ended",
  "Force quit" only once stuck, nothing sent for a reused id, a protected
  process, a forged `-1` or while hidden; a slow reading spacing the
  interval's next ones but not the early ones; the list passed on after a
  pause of its own; the sort setting takes `threads` and nothing unknown.
  The fake `run()` only records its arguments; **no unit test signals a
  real process**.
- `tools/headless-test/checks.js` (`testKillProcess`): off by default; the
  tab's size; only the user's processes; all of them (as many as a count
  of `/proc` made by the test, give or take 5 that start or end in
  between), with the count line saying so; only a few dozen row actors,
  all as tall as each other; scrolled to row 100 and to the end, each
  process in its place and the last at the bottom; the scroll bar left of
  the threads column and of ⊘, and the name at least 120 px wide; the
  Threads and Memory toggles sort (most first) and the sorted column
  stands out; a `sleep` counts 1 thread and a test Python with four extra
  threads counts 5, in its row too; a test Python whose main thread
  called `pthread_exit()` is listed with 2 threads and memory unknown, and
  `verify()` lets it be killed (only read, never signalled); GNOME Shell, its parent and
  `dbus-daemon` protected, with a lock and no ⊘; `verify()` refuses GNOME
  Shell; typing filters; a reused id is refused for real; a `sleep` the
  test started is killed through the UI (⊘, then "Kill “sleep”?") and ends
  with SIGTERM; "Ended", then gone once the pointer leaves; a `sleep` that
  ignores SIGTERM is not offered "Force quit" at 1 s, is at 3 s, and ends
  with SIGKILL; the refresh cost (see "Many processes" above), with 1000
  made-up processes in a second view over a fake service that signals
  nothing; a whole refresh (the real service and view, the user's
  processes served once and four times under made-up ids, real reads, no
  kill command) made in batches, its longest hold of the main loop under
  half the reading's length. Then, in a view over a fake service that
  only records what it is asked to kill, 300 made-up processes: Tab with
  the pointer resting on a list scrolled to row 100 shows the row it
  reaches, and Enter, Enter kills that row's process; a row out of sight
  is neither asked about nor killed; ⊘ then ✕ by pointer, the pointer
  gone, and a new process shows at the top; held rows with a count of
  today's processes; a row the keyboard focused holds the list until the
  focus leaves. Last, no reading, and no row filled, while another tab is
  shown or the island collapses. The test clicks only rows of processes
  it spawned (or the fake service's), checking the row's process id
  before each click, and ends any leftovers with
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
- Threads are counted, not listed one by one; a process's CPU share is
  all its threads'.
- The windowed list relies on every row being as tall as the others (the
  theme's 26 px `min-height`, taller than any row's content at the
  default text size). With very large text a confirmation row could be a
  pixel or two taller; rows stay in order, only the scroll range is that
  much off.
- Keyboard: Tab reaches the rows that exist (those on screen and four
  beyond each edge), and the list follows the focus, even under the
  pointer, so it walks the whole list; there are no Up/Down or Page keys
  in the list. The filter is the quickest way to a process.
- A process whose main thread exited while others run shows "—" for its
  memory, and, if Froonty first saw it after that, its kernel name for
  its command line (`[python3]`): the kernel reports neither for it.
  Reading them from one of its threads would cost a read per such
  process; they are rare.
- A reading costs the Shell's main thread in proportion to the number of
  processes (each file is a GJS asynchronous read), even though it no
  longer holds frames off: with about 1400 processes, 71-180 ms of
  main-thread CPU per reading in the headless Shell, spread in slices of
  a few milliseconds (see "Many processes"). At the default 3 s that is
  up to about 6% of the Shell's time while the tab is on screen; the
  pacing keeps it under about a tenth however many processes there are.
- Processes in other PID namespaces (Flatpak sandboxes) appear with their
  ids as seen from the host, which is what `kill` needs.
