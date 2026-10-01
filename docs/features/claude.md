# Feature: Claude

Status: **implemented (v1)**, 2026-09-29.

## 1. Goal

A hub tab with the Claude plan's usage limits, as Claude shows them under
Settings → Usage: how much of each allowance is used, and when each one
resets.

```
┌────┬──────────────────────────────────────┐
│ 🕒 │         [🎤][🔊]                 ⚙️   │
│ 📝 │ Session                          13% │
│ ✳  │ ███░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│    │ Resets in 4 h 2 min                  │
│    │ Weekly                           33% │
│    │ ███████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│    │ Resets Fri 22:56                     │
│    │ Weekly Fable                     18% │
│    │ ████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│    │ Resets Fri 22:56                     │
│    │ Cloud session credits  $181.09 left  │
│    │ ███████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│    │ Resets Thu 5 Nov 08:59               │
│    │                    Updated 2 min ago │
│    │ Opus 5.5 vs launch week 54.5% correct│
│    │ 80%┆░░░░░░░░                          │
│    │ 60%┆░•─•─•╮░ 54.5%  Collecting the    │
│    │ 40%┆░░░░░░╰•         baseline: day 7…  │
│    │     Sep 24   Oct 01   Oct 08   Oct 22 │
│    │ Baseline day 7 of 10 · livenerf, up… │
└────┴──────────────────────────────────────┘
```

The last row redraws livenerf's own chart (its README's hero image): the
daily score with its 95% interval, the baseline days shaded, the latest
score printed by its point, and once the baseline is complete its mean as
a dashed line. Once livenerf publishes a 10-day result, the line under the
chart reads `Δ −2.1 ± 1.4, days 11–20 (…): no change · livenerf, updated
Wed 21:44`.

The idea comes from vorssaint-utils' AI agents section, which shows plan
limits and their resets. No code was taken; its data source (a history file
the macOS Claude app keeps) has no reset times and no per-model week, so
Froonty reads a different one.

## 2. Decisions (agreed 2026-09-29)

- **Rows:** Session (5 hours), Weekly (all models), and one Weekly row per
  model the server lists separately (today: **Fable**; its name comes from
  the server). Anything else in the answer (per-product rows such as
  Cowork, extra usage, spend) is left out.
- **Cloud session credits** (added 2026-09-30, user request): last row,
  "$181.09 left" (the dollars remaining, as claude.ai shows them), a bar
  for the share used, and the monthly renewal. Shown only when the account
  has a credit limit; red when the server gives a `locked_reason`.
- **Resets:** under a day away it reads "Resets in 4 h 2 min" (rounded up,
  so never "in 0 min"); further away, "Resets Fri 22:56", and from six
  days away with the date, "Resets Thu 5 Nov 08:59"; in the clock's
  12/24-hour format.
- **Refresh on every visit, never poll** (user request). The file is read
  each time the tab comes on screen. While it stays on screen, a file
  monitor picks up new readings as Claude Code writes them. With the tab
  hidden or the island collapsed, nothing is watched or read.
- **Fresh usage** (added 2026-09-30, user request: "I want both
  implementations, A and B"). Claude Code rewrites its cache only when it
  checks usage, so the numbers went stale until the user opened Account &
  Usage in VS Code. Two ways in, see 3.2:
  - **A, "Ask Claude Code for fresh usage"** (`claude-ask-claude-code`, on
    by default): when the tab or the panic button comes on screen,
    Froonty runs the user's Claude Code `/usage`, at most once a minute.
  - **B, the status line**: Froonty's Claude Code status line saves
    Session and Weekly after each Claude Code reply. Set up from Settings
    → Claude, never over a status line of the user's own.
  - **Low power turns A off** (user request): as Power Saver mode or a
    battery below 20% (while on battery) begins, the setting switches off
    by itself; as it ends, back on, if Froonty switched it off. Switching
    it back on meanwhile is the user's choice and stays until the next
    low-power stretch. While off for low power, the footer ends "· Power
    Saver: status line only" or "· Low battery: status line only".
  - **Stale rows:** a row over an hour old (Claude Code's own limit for
    its cache) is dimmed, its line ending "· checked 3 h ago". With B
    alone, that is the per-model and credits rows.
- **No internet: "Unknown"** (user request). Offline, every value and
  every reset reads "Unknown", and a line says "No internet connection:
  Claude cannot be asked for these details." Offline means anything short
  of full connectivity from `Gio.NetworkMonitor` (NetworkManager's own
  connectivity check): no network, a local network only, limited, or a
  captive portal.
- **A window that renewed since the reading** shows "Unknown" and
  "Renewed at 15:49; not checked since": what was used after the renewal
  is not known.
- **Bars** are in Claude's clay (#d97757), and red when a limit is used up
  or the server flags it (any `severity` but `normal`).
- **The tab icon** is Claude's Spark, as the user supplied it, recoloured as
  a symbolic icon so it matches the other tabs. The Spark is Anthropic's
  logo; check their trademark terms before publishing Froonty with it.
- **On by default** (`claude-enabled`). Without Claude Code the tab shows a
  hint instead of rows.
- **livenerf row** (added 2026-09-30, user request): "Opus 5.5 vs launch
  week", from [livenerf](https://github.com/ninjahawk/livenerf), an
  independent benchmark that runs Opus 5.5 daily through headless Claude
  Code against its launch-week baseline. See section 3.1.
  - **The value is the latest day's score**, "54.5% correct", exactly as
    livenerf's chart prints it (user request: "I cannot see any current
    %"). Before the chart has been read, "Day 7 of 30" from the README.
  - **The chart** (user request, after livenerf's hero image): redrawn
    with Cairo from livenerf's own SVG, not shown as an image (at 300 px
    its 960-px text would be unreadable). Scores 40–80% (the SVG's own
    grid), dates along the bottom, the series in livenerf's blue. A
    pointer on it does nothing.
  - **The line under it:** until a result is published (baseline to about
    2026-10-04, first 10-day result after day 20) "Baseline day 7 of 10";
    then "Δ <Δ ± SE>, <window>: <decision>", copied from livenerf's
    Results table. Then "livenerf, updated Wed 21:44", when livenerf last
    redrew its chart, in local time. The line wraps.
  - **Fetched live** (user choice, over reading the submodule's pinned
    copy): the README and the chart from `raw.githubusercontent.com`,
    when the tab comes on screen while online, at most once an hour after
    a good reading (livenerf updates daily). These are the tab's only
    network requests.
  - Offline: "Unknown", like the other rows. A file that fails keeps its
    last good reading and is retried on the next visit. With nothing
    read, "livenerf's results could not be read." Without the chart, the
    day count shows as a bar instead.
  - Always the last row, below the usage footer, and shown even without
    Claude Code (it does not depend on it). Not on the panic button.
- **Size:** 380×465: room for the usage rows, the chart and a two-line
  Δ under it without scrolling (320 before the livenerf row, 260 before
  the credits row).
- **Panic button** `claude-session` (added the same day, user request):
  the session's usage in orange, as large as the button allows, over a
  faint grey Spark, number only;
  "?" when unknown; a click opens this tab. Add it in Settings → Panic
  buttons. It has its own `ClaudeService`, active while the island is open.
  See [panic-buttons.md](panic-buttons.md).

## 3. Where the numbers come from

For the usage rows, Froonty never asks Claude itself: no sign-in, no
token. It reads Claude Code's cache, merged with its status line's file,
and may run Claude Code's own `/usage` (3.2). (The livenerf row's one
request is to GitHub; see 3.1.)
Claude Code checks the account's limits itself (its `/api/oauth/usage` endpoint)
and caches the answer in its config file, `~/.claude.json`, under
`cachedUsageUtilization`:

```json
"oauthAccount": {"accountUuid": "…"},
"cachedUsageUtilization": {
  "fetchedAtMs": 1790707452799,
  "accountUuid": "…",
  "utilization": {
    "five_hour": {"utilization": 13, "resets_at": "2026-09-29T22:49:59.714213+00:00"},
    "seven_day": {"utilization": 33, "resets_at": "2026-10-03T05:59:59.714235+00:00"},
    "limits": [
      {"kind": "session", "group": "session", "percent": 13, "severity": "normal",
       "resets_at": "2026-09-29T22:49:59.714213+00:00", "scope": null},
      {"kind": "weekly_all", "group": "weekly", "percent": 33, "severity": "normal",
       "resets_at": "2026-10-03T05:59:59.714235+00:00", "scope": null},
      {"kind": "weekly_scoped", "group": "weekly", "percent": 18, "severity": "normal",
       "resets_at": "2026-10-03T05:59:59.714390+00:00",
       "scope": {"model": {"id": null, "display_name": "Fable"}, "surface": null}}
    ]
  }
}
```

What is known about this cache, from Claude Code 2.1.280 (the version
bundled with the Claude app on 2026-09-29) and the file it wrote:

- **Undocumented.** This is Claude Code's private format and may change in
  any release. `usage.js` reads it defensively: an entry it does not know
  is left out, never guessed. The older top-level fields (`five_hour`,
  `seven_day`, `seven_day_opus`, `seven_day_sonnet`) fill in rows that
  `limits[]` lacks.
- **Cloud session credits** are under a codename, `iguana_necktie`:
  `{utilization, resets_at, limit_dollars, used_dollars, remaining_dollars,
  locked_reason}`, all dollar fields null without a grant. Nothing in the
  file names it; the user matched `remaining_dollars` against claude.ai's
  Settings → Usage on 2026-09-30. A rename in Claude Code hides the row.
- **Percentages are 0–100.** Above 100 is possible (use past a cap, e.g. at
  lower priority); the text keeps it, the bar is capped.
- **Account check.** Claude Code discards a cache whose `accountUuid` is not
  the signed-in `oauthAccount.accountUuid`. Froonty does the same.
- **Freshness.** Claude Code (2.1.285, read from its bundle 2026-09-30)
  writes the cache only after it asks for usage: its `/usage` command
  (interactive or `-p`), and VS Code's Account & Usage panel (on open and
  on Retry). Not at startup, not on a timer, not after replies: their
  rate-limit headers stay in memory (they feed the status line). It asks
  at most once a minute. The footer says how old the reading is.
- **Location**, as Claude Code finds it: a legacy `.config.json` in its
  config folder wins; otherwise `.claude.json` in `$CLAUDE_CONFIG_DIR`, or
  in the home folder. (GNOME Shell rarely has `CLAUDE_CONFIG_DIR` set; the
  tests use it to keep the real file out of reach.)

The file also holds Claude Code's settings and project list, and it is
rewritten often. Files over 16 MB are not parsed, to keep the Shell's main
thread free. A read that fails halfway through a write keeps the last good
reading. The write's own file event reads it again.

## 3.1 Where the livenerf row comes from

livenerf publishes no machine-readable results. Its `.eval` logs are
gitignored, and each daily run commits only redrawn SVG charts and a
README edit (checked 2026-09-30, commit `71d1639`). So two published files
are read (`livenerf.js`).

From the **README**:

- The **Progress** line under Status, hard-wrapped prose:
  `**Progress (2026-09-30):** 7 of 30 days collected (baseline 7 of 10)`.
- The **Results** table under `## Results`. Columns are found by their
  header (`window`, `Δ …`, `decision`), not their place. The last row
  whose Δ cell reads `<number> [pts] ± <number>` (Unicode minus accepted)
  is the result. Rows reading `baseline` or `-` are skipped.

From the **hero chart**, `media/livenerf-dark.svg`, as `livenerf/plot.py`
draws it:

- **Scale:** the right-aligned grid labels (`40%` … `80%`) and their y,
  4 px above the label's baseline. Two labels fix the linear scale. The
  grid lines' ends are the plot's left and right edges.
- **Days:** each `<circle>` is a day's score. The vertical line at its x
  (`opacity="0.5"`) is its 95% interval. Values are read back through the
  scale. plot.py rounds positions to 0.1 px, which is under 0.02 points
  at its usual 236 px for 40 points. These values are only drawn, never
  printed.
- **Printed values**, taken exactly as text: the latest score (the bold
  `54.5%` by the last point), `baseline 58.1%` (the mean, once known),
  `Collecting the baseline: day 7 of 10.`, the shaded baseline `<rect>`,
  the date labels, and `546 samples · updated 2026-09-30 19:44 UTC`.

Anything else, or a change of wording upstream, gives no row data rather
than a guess. The unit tests read the submodule's README and chart, and
check that the printed latest score matches the last point read back. So
updating the submodule (`git submodule update --remote third_party/livenerf`)
checks the readers against the current upstream format.

The **submodule** (`third_party/livenerf`) is there for that check and as
a reference. It sits outside `froonty@catalin/`, so `make install` and
`make pack` never ship it. livenerf's README says "License: Not yet
chosen", so its files are not redistributed.

What livenerf measures is its own claim, not Froonty's: Opus 5.5 as served
through Claude Code on a Max subscription, on a 78-question panel, with a
pre-registered decision rule. Its README lists its limits (for example,
a same-family model swap was not detectable in validation).

## 3.2 Fresh usage: A and B

**A: Claude Code's `/usage`** (`refresher.js`). Showing the tab or the
panic button runs, from the home folder:

```
<claude> -p --no-session-persistence /usage
```

- A local command: Claude Code asks Anthropic for the plan's usage and
  writes its cache. Checked 2026-09-30: 2.4-2.7 s, about 350 MB while it
  runs, the cache 70 s old before and 1 s after, Session usage unchanged
  (no model request), no transcript saved. Froonty never sees a
  credential; the unmodified Claude Code signs in as always.
- Not run when: the setting is off; one runs already; one ran within a
  minute; the cache is under a minute old (Claude Code would not ask
  again); offline. Closing the island lets a run finish; it is stopped
  (SIGTERM, so Claude Code ends cleanly) after 30 s or when Froonty is
  disabled. The tab and the panic button share one refresher, so opening
  the island runs it once.
- The binary: the newest `~/.vscode{,-insiders}/extensions/
  anthropic.claude-code-<version>-linux-<arch>/resources/native-binary/claude`,
  else `claude` on `PATH`, `~/.local/bin/claude` or `~/.claude/local/claude`.
  `FROONTY_CLAUDE_CODE` replaces the search (the headless tests' fake).
  None found: the footer says "Claude Code not found".
- Low power (`power.js`): power-profiles-daemon's `ActiveProfile` is
  `power-saver`, or UPower's display device is a battery, discharging
  (states 2, 3, 6) and under 20%. Charging or plugged in, a low battery
  is not low power. A state that cannot be read (neither service on the
  bus, or one that was there restarting) is not "low power ended": nothing
  changes until it can be read again. The extension holds the refresher
  while the Claude tab is enabled, so this works with the island collapsed
  and before the tab was ever opened. Two internal keys keep the user's
  choice:
  `claude-ask-paused-for-power` (Froonty switched it off, so it switches
  it back on) and `claude-low-power-handled` (this stretch was acted on,
  also across a Shell restart or lock).

**B: the status line** (`statusline.py`, `statusLineSetup.js`). Claude
Code runs its status line command after each reply, with the session's
details as JSON on stdin ([docs](https://code.claude.com/docs/en/statusline)).
Froonty's script keeps only `rate_limits` (Session and Weekly, for Claude
plans, after the session's first reply) in
`$XDG_CACHE_HOME/froonty/claude-status-line.json`, renamed into place,
and prints "Fable · Session 13% · Weekly 33%". No extra requests, so it
also runs in low power; no per-model rows, no credits.

```json
{"writtenAtMs": 1790819528707,
 "rate_limits": {"five_hour": {"used_percentage": 13, "resets_at": 1790819999},
                 "seven_day": {"used_percentage": 33, "resets_at": 1791100000}}}
```

Settings → Claude → "Claude Code status line" adds
`"statusLine": {"type": "command", "command": "python3 '<path>'", "padding": 0}`
to Claude Code's `settings.json` (`$CLAUDE_CONFIG_DIR` or `~/.claude`),
keeping everything else, and removes it again. It does nothing when the
file already has another status line, or cannot be parsed. Needs
`python3` (on Ubuntu by default).

**Merging** (`usage.js` `mergeStatusLine`, `isNewerReading`): for
Session and Weekly, the newer reading wins; each row keeps its own
reading time. "Newer" is not "saved later": Claude Code also re-runs an
idle session's status line with numbers from its last reply, maybe hours
old. So a later window (reset time) wins, an earlier one loses, and within
the same window the higher use wins, as use only grows until the reset;
only a tie falls back to the time. `statusline.py` applies the same rule
before it saves, and leaves the file alone when nothing is newer. The
status line alone (no cache) is enough for both rows.

## 4. Structure

```
features/claude/
├── index.js     descriptor: id, title, Spark icon, claude-enabled, 380×465
├── icon.js      the Spark as a Gio.FileIcon (tab and panic button)
├── usage.js     pure: parse the cache, reset arithmetic (unit-tested)
├── livenerf.js  pure: read livenerf's README and chart SVG (unit-tested)
├── livenerfService.js  fetches both (Soup), at most hourly
├── service.js   reads the cache and the status line's file on show, file +
│                network monitors while shown; asks the refresher for a
│                /usage run and the livenerf service to refresh
├── refresher.js A: runs Claude Code's /usage (shared, once a minute);
│                low power switches its setting off and back on
├── power.js     low power from UPower and power-profiles-daemon (D-Bus)
├── statusline.py  B: Claude Code status line, saves rate_limits
├── statusLineSetup.js  adds/removes it in Claude Code's settings.json
├── view.js      rows (name, %, bar, reset), offline line, empty hint, footer
├── prefs.js     settings tab: show the tab, fresh usage, status line
└── icons/hicolor/scalable/actions/froonty-claude-symbolic.svg
```

The icon folder is laid out as an icon theme: GTK 4.14 only recolours a
`-symbolic` icon found that way (as a loose file on the search path, it was
drawn in its raw grey). The Shell side loads the same file as a
`Gio.FileIcon`, and St recolours it by its name.

The hub accepts a `Gio.Icon` as a feature's `icon`, as well as an icon name.

## 5. Resources

While the tab (or, for the panic button, the island) is on screen: one
`Gio.FileMonitor` on the config file (Gio watches its folder, so a
replace-by-rename counts), three connections on
`Gio.NetworkMonitor.get_default()`, and one async read per
visit and per write. Reads that arrive during a read fold into one more
read. The network connections are `network-changed` plus
`notify::connectivity` and `notify::network-available`. GLib 2.80's
NetworkManager backend reports NetworkManager's state and connectivity check
only as property notifications, and `network-changed` comes only with route
changes. The minute re-render for "Resets in" and "Updated … ago" rides the
shared clock's tick (`GnomeDesktop.WallClock`), and is skipped while the
tab is hidden. No timers of its own. Hidden, none of this exists, except
the power monitor below.

Fresh usage: while shown, a second `Gio.FileMonitor`, on the status
line's file. Per visit, at most one `/usage` run a minute (2-3 s, about
350 MB, one request by Claude Code), with a 30 s timeout source while it
runs. The power monitor lives as long as the Claude tab is enabled (or its
panic button exists), so the setting follows the power state with the
island collapsed:
two `Gio.DBusProxy` on the system bus (UPower's display device,
power-profiles-daemon) and their property-change signals; no polling.
The status line script runs in Claude Code, not in the Shell.

livenerf: one `Soup.Session` (20 s timeout), made on the first fetch and
aborted when the tab is turned off, and two GETs (README about 22 kB,
chart about 6 kB) per visit, at most once an hour. The chart is a
`St.DrawingArea`, repainted only when St asks. `FROONTY_LIVENERF_DIR`, when
set, names a local folder laid out like the repository to read instead
(the headless tests; the Shell under test never goes online).

## 6. Tests

- `tools/unit/claude.test.js`: parsing (order, legacy fields, bad rows,
  another account, over 100 %, cloud session credits), reset wording, and the service against a
  temporary file and a fake network monitor. The service tests cover no
  read while hidden, a read on show, following writes while shown, a fresh
  read on the next show, folding a burst of reads, missing, half-written
  and unreadable files, and connectivity. Fresh usage: the status line
  file (parsing, merging newer or older, alone), `lowPowerReason`, picking
  the newest Claude Code, the refresher (once a minute, a fresh cache
  skipped, two views run it once, not found, the setting off), low power
  switching the setting off and back on, the user's choice kept within a
  stretch and across a new refresher, `settings.json` set-up (keeps the
  rest, never over the user's own, bad JSON left alone, quoting), and
  `statusline.py` run as Claude Code runs it.
- `tools/unit/livenerf.test.js`: the README reader (hard-wrapped progress,
  Δ rows, Unicode minus, columns by name, nothing guessed), the chart
  reader (scores and intervals through the grid, printed values, the
  collecting note, nothing without a grid or points), both against the
  submodule's real files when checked out, and the service with a fake
  fetch (not before start, hourly limit, failures, one file enough, each
  file's last good reading kept, fetched only when shown and online).
- `tools/headless-test/checks.js` `testClaude`: the real tab in the Shell
  with a private `CLAUDE_CONFIG_DIR`. It checks the rows and their wording
  (the credits row and its dated reset included),
  the hub size, the livenerf row (the latest score over the chart, then a
  published Δ and decision, "Unknown" offline) from a private README and
  chart in plot.py's format, a live
  update, offline and captive-portal states, nothing
  watched while collapsed, a fresh read on reopening, another account, a
  missing file, and turning the tab off. Fresh usage, with a fake Claude
  Code (`FROONTY_CLAUDE_CODE`, set by `run.sh` so the real one is never
  run): one shared refresher, its arguments, a run on opening that brings
  a new reading to the tab and the panic button, none again within a
  minute, Power Saver switching the setting off (footer, no run), a newer
  status line replacing Session and Weekly, and the setting back on when
  low power ends.
