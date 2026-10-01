# Changelog

## 0.2.0-rc3 (2026-09-30)

Third release candidate, for GNOME Shell 50 on Ubuntu 26.04 (Wayland).

### Added
- **Claude tab: "Opus 5.5 vs launch week".** A last row shows what the
  independent [livenerf](https://github.com/ninjahawk/livenerf) benchmark
  reports about Claude Opus 5.5 against its own launch week.
  - The value is the latest day's score ("54.5% correct"), as livenerf's
    chart prints it.
  - Below it is a small redraw of livenerf's chart: the daily score with
    its 95% interval, the baseline days shaded, and the baseline mean as a
    dashed line once the baseline is complete.
  - Under the chart: the baseline's progress ("Baseline day 7 of 10"). Once
    livenerf publishes a 10-day result, the line shows the change against
    launch week (Δ ± SE) and livenerf's pre-registered decision instead.
  - Offline, the row reads "Unknown", like the rest of the tab.

### Changed
- **One network request.** To fill that row, Froonty fetches livenerf's
  README and chart SVG from GitHub when the Claude tab opens, at most once
  an hour. No sign-in, no token. Until now Froonty made no network access
  at all.
- The Claude tab is 380×465 (was 380×320).
- livenerf is a git submodule in `third_party/livenerf`. The unit tests
  check Froonty's readers against its files. It is never installed or
  packed, because livenerf has no license yet.

### Quality
- Headless GNOME Shell 50 suite: 178/178 in both session modes.
- 73 plain-gjs unit tests.

### Known limitations
- livenerf publishes no machine-readable results, so Froonty reads its
  README (prose) and its chart (an SVG drawn by `livenerf/plot.py`). If
  livenerf changes either, the row shows "could not be read" or loses its
  chart rather than a wrong number.
- The Δ format is not yet known: no 10-day result exists (the first is
  expected after day 20, around 2026-10-14). Froonty expects
  `−2.1 ± 1.4`-style values.
- livenerf measures Opus 5.5 as served through Claude Code on a Max plan,
  on its own 78-question panel; what it can and cannot detect is described
  in its README.

## 0.2.0-rc2 (2026-09-30)

Second release candidate. It targets GNOME Shell 50 on Ubuntu 26.04
(Wayland only) and no longer supports GNOME Shell 46.

### Added
- **Claude tab.** It shows your Claude plan's usage limits (Session,
  Weekly, and a weekly row per model such as Fable) and when each resets.
  - Froonty reads what Claude Code last cached in `~/.claude.json`. It does
    this each time the tab opens, and follows new readings while the tab
    stays open. It never contacts Claude and never polls.
  - Without an internet connection every value reads "Unknown", with a
    line saying why.
  - A **Cloud session credits** row shows the dollars left and when the
    credits renew. Claude Code's cache stores them under a codename
    (`iguana_necktie`), matched by hand against claude.ai.
  - The tab's icon is Claude's Spark. Settings → Claude turns the tab off.
  - The numbers are as fresh as Claude Code's last check, which happens
    only while it runs. The cache is Claude Code's private, undocumented
    format (as of 2.1.280), so a future version may break the tab.
- **Panic button "Claude session usage"** (Settings → Panic buttons).
  It shows the session's usage (0–100), large, in Claude's orange over a
  faint grey Spark, or "?" when unknown. A click opens the Claude tab.
- **Start at login** (Settings → General → Startup, on by default). When
  off, Froonty waits after login with only a top bar icon; clicking it or
  pressing the shortcut starts it. A screen unlock keeps the current state.

### Changed
- **Targets GNOME Shell 50** (Ubuntu 26.04) instead of 46. GNOME Shell 50
  marked the 46-only extension "out of date" and did not load it, so the
  island did not appear. See docs/DESIGN.md, section 1.1.

### Fixed
- The pill could be placed mid-screen at login: it measured the top bar
  clock while GNOME Shell's startup animation still had the screen scaled.
- Buttons inside the open island (feature tabs, ⚙️, panic buttons) ignored
  clicks on GNOME Shell 50; middle-click on a note tab trashes it again.
- `make install` copies the extension instead of linking it. With a link
  into a drive mounted after login, GNOME Shell found a broken link at login
  and silently skipped Froonty.

### Quality
- Headless GNOME Shell 50 suite: 176/176 in both session modes.
- 59 plain-gjs unit tests.

### Known limitations
- Verified only in the isolated headless GNOME Shell 50, not yet in a real
  GNOME 50 session, with real suspend/resume, or on HiDPI/fractional
  scaling.
- Rendered Markdown and Calendar are still planned (see 0.2.0-rc1).

## 0.2.0-rc1 (2026-09-28)

First release candidate. It targets GNOME Shell 46 on Ubuntu 24.04.

### Island
- A pill at the top center replaces the top bar clock visually. It always
  covers the clock button completely, and GNOME's calendar menu keeps
  working underneath.
- **Opening:**
  - click, `Super+Alt+I`, or Ctrl+Alt+Tab;
  - hovering for 350 ms (configurable, 0 = off).
- **Closing:** Escape or a click outside. Clicking inside never closes it.
- It follows the primary monitor and hides over fullscreen windows.
- With "Show island" off, a puzzle-piece icon in the top bar (and the
  shortcut) opens the settings.

### Hub
- Feature tabs sit in a vertical column on the left, each named in a
  tooltip.
- A panic bar is centered at the top, and ⚙️ opens the settings window. A
  second click on ⚙️ raises the open window instead of failing.

### Panic buttons (new)
- Up to 5 quick actions, chosen and ordered in Settings → Panic buttons.
- **Mute microphone** and **Mute sound** use GNOME's shared audio mixer.
  They follow mute changes made elsewhere and show red while muted.

### Notes (new)
- Plain Markdown files, one per note, in a configurable folder.
- Autosave 0.8 s after typing, and immediately on close.
- Pick-up of changes made in other programs.
- **Tabs:**
  - Names in `dd.mm.yy hh.mm` form; tabs keep creation order.
  - Tabs fit their names. Names over 14 characters are shortened and shown
    in full on hover.
  - The tab row scrolls.
  - Double-click renames a note; middle-click or × twice moves it to the
    Trash.
- **Formatting:**
  - The formatting bar's toggles show their state at the cursor.
  - The tools row can be folded away.
  - A wrap toggle, with horizontal scrolling when wrapping is off.
- **Colours:** per-note colours in the style of Sticky Notes.

### Settings
- Tabs: General, Appearance, Panic buttons, Notes.

### Quality
- Isolated headless GNOME Shell 46 test suite covering the default and
  Ubuntu session modes. It has its own buses, XDG dirs and a private PipeWire
  with no host hardware. It checks real input, pixels, and a leak footprint
  over 25 enable/disable cycles: 139/139 in both modes.
- 39 plain-gjs unit tests.

### Known limitations
- Rendered Markdown (formatting shown in the text) is planned; the
  formatting bar inserts Markdown syntax.
- Not yet verified on a real Wayland session, with real suspend/resume, or
  on HiDPI/fractional scaling. The development machine runs X11 at scale 2.
- Calendar is designed (see `docs/features/calendar.md`) but not built. It
  needs `gir1.2-ecal-2.0`.
