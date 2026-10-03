# Changelog

## Unreleased

### Added
- **When Claude needs you** (Settings → Claude; the bar is on by
  default, the Claude Code part after a click on **Set up**). A slim bar
  under the collapsed pill while a Claude session waits for you: "Claude
  needs your permission", "needs your input", "is waiting for your input",
  "stopped with an error" or "finished", with the project and the app,
  e.g. "Froonty · Visual Studio Code"; "+2" when more wait.
  - A click brings that window to the front; × (or Delete) hides it.
    Ctrl+Alt+Tab reaches it.
  - Claude Code (terminal, VS Code, the Claude app's Code tab): **Set up**
    adds Froonty's hooks to Claude Code's `settings.json`, next to any of
    your own; **Remove** takes exactly those out again. Claude Code then
    runs a small GJS script shipped with Froonty that writes one file per
    waiting session under `$XDG_RUNTIME_DIR/froonty` (never what Claude
    said), and clears it with a one-line command on your next prompt or
    Claude's next step. Needs Claude Code 2.1.233 or later.
  - The Claude app's own notifications show on the bar too, and go when
    the app closes them (once you have seen the session). Browser
    notifications that mention claude.ai can be added (off by default).
  - Hidden while the island is open, while a GNOME banner shows, in the
    overview and under Do Not Disturb. Not shown while you are already
    looking at that window, except a terminal's permission or question:
    a terminal's tabs are invisible to Froonty, and Claude Code asks only
    once nobody has typed into it for a while. Focusing that window clears
    it; when Froonty cannot tell which of an app's windows it is (several
    terminal windows, tmux), going to any of that app's windows clears a
    permission or a question.
  - What waits survives a screen lock; turning Froonty or the island off
    removes it, and Claude Code's hooks then record nothing.
  - Nothing is polled and Froonty starts no process: one folder watch,
    and a few signals.
- **Calendar tab**, right after Clock: the events of every calendar GNOME
  knows, read-only and live. Google, Microsoft 365, Nextcloud and other
  accounts come from Settings → Online Accounts; iCloud and any CalDAV or
  ICS calendar from GNOME Calendar or Evolution.
  - A month grid as GNOME's own (its week start, week numbers and days
    off), with up to three calendar-coloured dots per day, and a Day /
    Week / Month switch. Each visit starts on today.
  - Events as cards in their calendar's colour: time, calendar and place,
    "Now" and "Next", past ones dimmed, cancelled ones struck through.
    Repeating events are expanded by GNOME's own calendar library, moved
    occurrences included.
  - A click on an event opens its day in the web calendar it comes from
    (Google, Outlook; iCloud, Nextcloud and Yahoo open their calendar);
    buttons under the grid open each one on the selected day, and one
    opens Online Accounts.
  - Settings → Calendar: show the tab, which calendars it shows, and its
    size (620 × 380 by default).
  - Froonty never adds, changes or removes an event or a calendar, and
    loads nothing until the tab is first opened. Opening and closing the
    island then costs no calls to Evolution Data Server: while the tab
    is not on screen, Froonty only keeps what it sends.
  - A large calendar never stalls the desktop: repeating events are
    expanded a few milliseconds at a time, and a series begun years ago
    (or one repeating every minute) is not walked from its start.
  - Events in a time zone only the calendar knows (Outlook's "Pacific
    Standard Time") all show at their right time, however many there
    are.
  - "Next" marks the next event from now on, not the first one of a
    day, week or month in the future.
  - Needs `gir1.2-ecal-2.0`; without it the tab explains what to install
    (and starts off when it is missing on the first start). Microsoft 365
    and Exchange calendars also need `evolution-ews-core` (Evolution
    Data Server's backends, without the Evolution mail client).
- **Notifications tab** (on by default). GNOME's own notifications in the
  island, urgent ones first, then newest first: each with its app, how
  long ago it came in, its title, up to three lines of its body, its icon
  and up to three action buttons. Froonty keeps no copy; it is a view of
  GNOME's list.
  - A click on a notification, or on one of its buttons, does what GNOME's
    list does, and the island closes. That includes GNOME's rule for an
    app that gave its notification no "open" action: the click opens the
    app and removes all of that app's notifications that are not
    resident.
  - × (or Delete) dismisses one. A double click on × dismisses only that
    one (for the double-click time, the row that moved up under the
    pointer ignores the second click), and holding Delete down dismisses
    only one (key repeats are ignored).
  - "Clear all" asks first: "Clear N?" beside "Keep them". It clears only
    what was listed at the first click, as it was then: one its app
    updated meanwhile stays, and N counts down. From the keyboard, the
    focus goes to "Keep them", so pressing Enter twice keeps them.
  - The tab carries GNOME's unread dot, as the pill and 📅 do. Opening
    the island on purpose with this tab on screen (a click, the keyboard,
    the shortcut), or pressing, typing or scrolling in it, marks what it
    lists as seen, as GNOME's list does, except one still waiting for its
    banner, which shows when the island closes. Opening it by hover alone
    does not, and neither do a modifier key alone, key repeats, a key
    while the focus is still on the pill after a hover-open (Tab moves it
    in), or a scroll outside the list after a hover-open.
  - A Do Not Disturb toggle, bound to GNOME's own switch.
  - Nothing is watched while the tab is not on screen, and nothing is
    ever removed without a click. Settings → Notifications: show the
    tab, and its size (400 × 440 by default).
- **Notes: All notes window.** On the Notes tab, a button between 📅 and ⚙️
  in the island's top row (tinted with a faint wash of the open note's
  colour, so it reads as part of Notes) opens every note in a window of its
  own: the settings window's All notes page (Settings → Notes → All notes
  too). Search all notes at once (every word must match the name, the text
  or a label; case and accents do not matter), filter by labels, and read
  or edit a note there; edits save as in the island. The window stays open
  through a screen lock; its back arrow leads to the settings.
  - It opens on the note you are on in the island, and follows the island
    when you have switched notes there since (the button raises the
    window).
  - Enter in the search goes into the open note at the first match; if the
    search hides that note, into the first result, which opens.
  - Changing the notes folder starts the window over in the new folder,
    also while it shows the settings.
  - Accents are ignored as in Latin, Greek and Cyrillic; the vowel signs
    of Indic scripts and Japanese voicing marks still count.
- **Notes: labels.** Right-click a note's tab (or Menu / Shift+F10 on it)
  to give it labels: type to filter or add one, click to turn one on or
  off. In the All notes window, label chips narrow the list (notes with all
  the chosen labels, or any of them). Labels are kept in a hidden
  `.froonty-labels.json` next to the notes, so the `.md` files stay plain
  Markdown and older Froonty versions leave them alone. A note restored
  from the Trash gets its labels back.
- **Notes: conflict copies.** If a note changes elsewhere (another editor,
  a sync tool, the All notes window) while you have unsaved typing, both
  versions are kept: yours as "<name> (conflict)", which then stays open,
  with a line saying so. A file that was only touched, or rewritten with
  the same text, is no conflict.
- **Media tab** (on by default; Settings → Media). What music and video
  players report over MPRIS, with play, pause, skip and seek, the cover,
  and a choice of player ("Automatic" shows the one playing; browsers are
  followed too, since much music plays in one). Design adapted from
  vorssaint-utils (GPL-3.0-or-later).
  - **Safe controls:** each button acts on the song it was drawn for; the
    song is checked with the player again before a command is sent, and
    commands go only to that player's process, never to one that took
    its name since.
  - **On the collapsed island:** while a song plays, its cover and moving
    bars beside the time, and a new song's title for 3 s. A click opens
    the tab; two fingers left or right on the touchpad change song.
  - **Lyrics:** the player's own, a `.lrc` file next to a local song, or
    lrclib.net when "Find lyrics online" is on; Earlier and Later fix the
    timing.
  - **Up next:** the player's upcoming songs, with "Play now", for
    players that share them (few do).
  - **Volume:** mute and a slider for GNOME's output, as in Quick
    Settings.
  - **Nothing leaves the computer by default.** Two options use the
    internet, both off: covers a player gives as a web address, and
    lyrics from lrclib.net (the song's title, artist, album and length).
  - The position is read only while the tab is on screen; its clock
    ticks once a second only while a song plays there. The chosen player
    survives a screen lock.
- **Panic button "Pause all media"** (not in the bar by default). Pauses
  every player that is playing; a second click plays again the ones it
  paused.
- **Notes: rendered Markdown.** Notes are drawn formatted while staying
  plain Markdown files. Headings are larger, bold is bold, italic is
  italic, struck text is struck, code is monospace, links are underlined,
  quotes are muted, and ticked checklist items are struck through. The
  Markdown markers are hidden except on the line you are editing, so the
  formatting buttons' results show at once.
- **GNOME's calendar and notifications, from the island.** The pill covers
  GNOME's clock, so its menu (notifications, the calendar, events, world
  clocks, weather) and its unread dot were out of reach. Both are back,
  and nothing of them is reimplemented:
  - **📅** in the open island, left of ⚙️ (or Tab to it, Enter), opens
    GNOME's own menu under the pill; the island closes. GNOME's `Super+V`
    works too, also while the island is open. Escape closes the menu.
  - **Unread dot:** while GNOME's clock would show its dot, the pill
    shows it after the time, and 📅 carries it. GNOME's rules decide
    (seen once its list is shown; hidden under Do Not Disturb). Froonty
    never dismisses or removes a notification.
  - **Banners** that arrive while the island is open wait and show when
    it closes, as they do under GNOME's own open menu, instead of showing
    underneath the island and counting as seen.
  - Only one of the two is open at a time: opening the island closes
    GNOME's menu, and the menu opening closes the island.
- **Kill Process tab** (off by default). All of your own processes,
  with their CPU load, memory and number of threads, sorted by any of
  the three (the CPU, Memory and Threads toggles) and filtered by name,
  command line or process id, each with a kill button. Only the rows on
  screen exist, so sorting and showing a long list costs about as much as
  one screenful. Reading `/proc` still grows with the number of
  processes: it is read in small batches, with room for the Shell to draw
  in between, and less often than the interval when one reading takes
  long.
  - Two clicks: ⊘, then "Kill “name”?". The process is asked to quit
    (SIGTERM). If it is still running 3 s later, the row offers "Force
    quit" (SIGKILL).
  - Never offered: GNOME Shell, whatever started it, and a short list of
    session programs (gnome-session, gdm's session wrapper, systemd --user,
    Xwayland, D-Bus, PipeWire and WirePlumber, the keyring). Other users'
    processes are not listed; Froonty never asks for administrator rights.
  - Right before each signal the process is read again, so a process id
    the kernel has since given to another process is never signalled.
  - The list holds still while the pointer is on it (or while the
    keyboard has put the focus on a row), so a click never lands on a
    process that has just moved there. The count over it stays current.
  - Tab scrolls the list to the row it reaches, and a row's buttons act
    only while the row is on screen, so nothing is killed unseen.
  - A process whose main thread has ended while its other threads run is
    listed (and can be killed); its memory shows as "—".
  - It reads `/proc` only while the tab is on screen, every 3 s by
    default, and runs `/usr/bin/kill` once per confirmed step.
  - Settings → Kill Process: show the tab, refresh interval (1-10 s),
    what is never killed, and the tab's size (520 × 440 by default).

### Changed
- The camera panic button is switched off for now (its code is kept).
- Notes: the colour dot is gone from the tabs (more room for names); the
  note's colour still tints its page, the colour button and the All notes
  button.
- Notes: an edit made elsewhere while you are typing no longer waits to
  be overwritten by your next save: both versions are kept (see conflict
  copies above). A keystroke typed while the note was being re-read could
  also be undone by the older text on disk; it no longer is.
- Notes: paler note surfaces (yellow, green, pink, purple, blue, gray), so
  the text is easier to read. Colour swatches keep the stronger shades
  that tell the colours apart.
- The island grows when the panic buttons and the top row's buttons need
  more room than its width, so the centred panic bar never overlaps them.

### Fixed
- Claude tab: **Set up** and **Remove** for the status line no longer
  rewrite a `~/.claude/settings.json` that is a symbolic link (as dotfiles
  managers make it) in place, truncated and then written. The file the
  link names is now replaced whole and the link stays. A settings file
  with more than one hard link is left alone, with the reason in the row,
  and a change Claude Code saved between Froonty's read and write is no
  longer overwritten ("try again").
- Claude tab: while it was on screen without Froonty's status line set up,
  GLib looked for the status line's missing folder every 4 s (its inotify
  backend's rescan of missing paths). Froonty now makes that folder of its
  own (`~/.cache/froonty`, 0700) before watching it.
- Notes: a note whose save fails (no permission, a full disk, a notes
  folder on a USB drive or network share that went away) stays open, with
  its error, until it can be saved. Picking another note used to drop the
  unsaved text and the error. If you switch to another notes folder
  meanwhile, the text is kept there as "<name> (conflict)".
- Notes: a `.froonty.json` that cannot be read (a hand edit with a typo, a
  half-synced file) is left as it is, and the island says so; once fixed,
  its order and colours are back. It used to be rewritten at once with the
  notes in alphabetical order and no colours.
- Notes: a note that is not plain UTF-8 text (Latin-1, a UTF-16 file from
  Windows Notepad, NUL bytes) is shown read-only, with a notice. The first
  keystroke used to replace its accented letters with "�", or cut it at
  the first NUL, for good.
- Notes: a note added to the folder by another program, or a colour
  changed elsewhere, shows in the island at once, not only after something
  else changed.

## 0.4.0-rc0 (2026-10-02)

First release candidate of 0.4.0, for GNOME Shell 50 on Ubuntu 26.04
(Wayland). It builds on 0.3.0-rc1. The Clipboard tab is new work, so it
opens 0.4.0. The Clipboard tab is off by default; the ZeroTier tab stays
out of the packed extension.

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
  - **Paste as plain text:** while formatted text (from a web page or an
    office suite) is on the clipboard, a "Plain text" button leaves only
    its text, so the next paste has no formatting.
  - Screenshots (Print, Shift+Print, Alt+Print) are on the clipboard in
    GNOME, so they show up in the history too.
  - Settings → Clipboard: entries to keep (default 50), how long a password
    is listed, password recognition, the password apps, and the tab's
    size. The extension's description now declares clipboard access, as
    the review guidelines require.
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
