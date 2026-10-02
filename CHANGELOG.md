# Changelog

## Unreleased

### Added
- **Clipboard tab** (off by default). It keeps a history of what you copy
  or cut: text, images, and file and folder locations (cut or copied in
  Files). Click an entry to put it back on the clipboard, then paste as
  usual.
  - The history is kept on this computer only, in
    `~/.local/share/froonty/clipboard`, readable by you only.
  - Passwords are never saved. A copy is a password when a password
    manager marks it secret, when a password app has the focus, or when the
    text looks like one (browsers mark nothing). The latest one is listed as
    •••••••• and can be copied again for 5 minutes (adjustable; 0 = never
    listed), until the clipboard is cleared or something else is copied,
    whichever comes first.
  - Settings → Clipboard: entries to keep (default 50), the apps never
    recorded, and the tab's size. The extension's description now declares
    clipboard access, as the review guidelines require.

### Changed
- Feature tab icons are 25% larger (20 px).

### Fixed
- Btop: a list scrolled to its end no longer jumps up every couple of
  seconds. A GPU row lost its detail line while the GPU idled, and got it
  back when busy (an iGPU, which draws the desktop, does both constantly);
  GPU rows now keep that line's room.

## 0.3.0-rc1 (2026-10-01)

Second release candidate of 0.3.0, the one submitted to
extensions.gnome.org. It builds on 0.3.0-rc0 with no new features.

### Fixed
- The packed extension passes the Shexli static analyzer with no
  findings. The clock now follows the top bar clock's own WallClock
  instead of owning one, so nothing needs `run_dispose()`. The Claude
  tab's bar and chart, and the Btop tab's rows and levels, are widget
  subclasses (as GNOME's own bars are), so no helper keeps an actor or a
  signal of its own.

## 0.3.0-rc0 (2026-10-01)

First release candidate of 0.3.0, for GNOME Shell 50 on Ubuntu 26.04
(Wayland). It builds on 0.2.1-rc1. The Btop tab (a system monitor) is
new work, so it opens 0.3.0. The ZeroTier tab stays out of the packed
extension.

### Added
- **Btop tab** (a system monitor, with btop's "B" as its icon). CPU
  model, clock, temperature and load, with each thread's load and
  temperature in a fold-out; each graphics card's load, temperature, power
  and memory (NVIDIA through `nvidia-smi`; a sleeping card shows "Asleep"
  and is never woken up); RAM used and cache; root, swap and EFI usage;
  download and upload speed and totals. Loads and used space show their
  value and a five-cell level from green to red (`_____` at 0%, `▂▄▆▇█`
  at 100%). It reads the computer only while the tab is on screen, every
  2 s by default (Settings → Btop: 1-10 s, and which sections to show;
  sections that are off are not read). Its size, 460 × 480 by default, is
  set in Settings → Btop → Size, as for Notes.
- The feature tabs stay in one column: the expanded island grows taller
  than "Expanded height" when the tabs need it.
- **Fresh Claude usage.** The Claude tab no longer waits for you to open
  Account & Usage in Claude Code. Two ways in, both under Settings →
  Claude → Fresh usage:
  - **"Ask Claude Code for fresh usage"** (on by default). When the island
    opens, Froonty runs your Claude Code's `/usage` (at most once a
    minute, 2-3 s in the background). It makes no model request and uses
    no plan usage; Froonty never touches your sign-in.
  - **Claude Code status line.** "Set up" adds Froonty's status line to
    Claude Code's settings (never over one of your own). It then saves
    Session and Weekly after each Claude Code reply, with no extra
    requests. It shows "Fable · Session 13% · Weekly 33%" in Claude Code.
    Needs `python3`.
  - **Low power.** Power Saver mode, or the battery under 20% while on
    battery, switches "Ask Claude Code" off by itself; it comes back on
    when that ends. Switching it back on in the meantime is kept. The tab's
    footer says when only the status line brings new numbers.
- Rows over an hour old are dimmed and say when they were checked.
- Notes: the island's width and height can be set under Settings → Notes →
  Size, with a **Default size** button (428×319).
- **ZeroTier tab** (working-tree installs; not in the published package
  yet). It shows whether ZeroTier is installed, running, set to start with
  the computer and online, and each joined network's addresses and
  problems (not authorized, no IP address, …). Start/Stop stays in the
  tab; networks are joined and left in ZeroTier itself. Settings →
  ZeroTier → Allow lets Froonty read ZeroTier's status. On the first start,
  the tab is turned off when ZeroTier is not installed.

### Fixed
- Feature icons are no longer created when the extension loads, before
  `enable()` (extensions.gnome.org review guidelines).
- Notes: the mouse wheel scrolls the tab strip with the pointer on the
  selected tab too. Before, the selected tab pulled itself back into view.
- Notes: renaming a tab (double-click) once the tab row is full no longer
  shrinks the tab to a sliver; the name field keeps its width and stays in
  view.

### Changed
- Froonty can now make Claude Code contact Anthropic (one usage check per
  run of `/usage`). Turn "Ask Claude Code for fresh usage" off to stop it.

## 0.2.1-rc1 (2026-09-30)

First release candidate of 0.2.1, for GNOME Shell 50 on Ubuntu 26.04
(Wayland). It builds on 0.2.0-rc2.

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
