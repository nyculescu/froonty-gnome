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
└────┴──────────────────────────────────────┘
```

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
- **Size:** 380×320 (260 before the credits row).
- **Panic button** `claude-session` (added the same day, user request):
  the session's usage in orange, as large as the button allows, over a
  faint grey Spark, number only;
  "?" when unknown; a click opens this tab. Add it in Settings → Panic
  buttons. It has its own `ClaudeService`, active while the island is open.
  See [panic-buttons.md](panic-buttons.md).

## 3. Where the numbers come from

Froonty never asks Claude: no network access, no sign-in, no token. Claude
Code checks the account's limits itself (its `/api/oauth/usage` endpoint)
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
- **Freshness.** Claude Code writes the cache at most once a minute, and
  only when it checks usage while it runs. When exactly it checks is Claude
  Code's choice. The footer says how old the reading is.
- **Location**, as Claude Code finds it: a legacy `.config.json` in its
  config folder wins; otherwise `.claude.json` in `$CLAUDE_CONFIG_DIR`, or
  in the home folder. (GNOME Shell rarely has `CLAUDE_CONFIG_DIR` set; the
  tests use it to keep the real file out of reach.)

The file also holds Claude Code's settings and project list, and it is
rewritten often. Files over 16 MB are not parsed, to keep the Shell's main
thread free. A read that fails halfway through a write keeps the last good
reading. The write's own file event reads it again.

## 4. Structure

```
features/claude/
├── index.js     descriptor: id, title, Spark icon, claude-enabled, 380×320
├── icon.js      the Spark as a Gio.FileIcon (tab and panic button)
├── usage.js     pure: parse the cache, reset arithmetic (unit-tested)
├── service.js   reads the file on show, file + network monitors while shown
├── view.js      rows (name, %, bar, reset), offline line, empty hint, footer
├── prefs.js     settings tab: show the tab
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
tab is hidden. No timers of its own. Hidden, none of this exists.

## 6. Tests

- `tools/unit/claude.test.js`: parsing (order, legacy fields, bad rows,
  another account, over 100 %, cloud session credits), reset wording, and the service against a
  temporary file and a fake network monitor. The service tests cover no
  read while hidden, a read on show, following writes while shown, a fresh
  read on the next show, folding a burst of reads, missing, half-written
  and unreadable files, and connectivity.
- `tools/headless-test/checks.js` `testClaude`: the real tab in the Shell
  with a private `CLAUDE_CONFIG_DIR`. It checks the rows and their wording
  (the credits row and its dated reset included),
  the hub size, a live update, offline and captive-portal states, nothing
  watched while collapsed, a fresh read on reopening, another account, a
  missing file, and turning the tab off.
