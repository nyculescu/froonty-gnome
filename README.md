# Froonty

A small Dynamic-Island-style pill at the top center of the screen for
**GNOME Shell 50** (Ubuntu 26.04, Wayland). The island is a compact entry point to
facilities GNOME Shell already has. It does not reimplement them.

Status: **0.4.0-rc0**, a release candidate. See [CHANGELOG.md](CHANGELOG.md).

- No background subprocesses. The polling timers are the Btop (system
  monitor) and Kill Process tabs', each running only while its tab is on
  screen; the Media tab's display tick (it reads nothing) runs only while
  the tab is on screen and a song plays. The published extension
  package omits the working-tree-only ZeroTier controls; `make install`
  includes them. Froonty also makes one direct network request by
  default: the Claude tab's livenerf row fetches two public files from
  GitHub, at most once an hour while the tab is open. Two Media options,
  off by default, use the internet: covers a player gives as a web
  address, and lyrics from lrclib.net.
- GJS and native GNOME Shell APIs only.

See [docs/DESIGN.md](docs/DESIGN.md) for the GNOME Shell API analysis (written for 46; see the note there), the list
of private APIs used, compatibility risks and the NexNotch review. Each
feature has a design note in [docs/features/](docs/features/).

## Features

- **Island.** A pill replaces the top bar clock visually. GNOME's clock stays
  underneath, so its calendar and notification menu keeps working (below).
  - **Open:** click, hover (350 ms, configurable), `Super+Alt+I` or
    Ctrl+Alt+Tab.
  - **Close:** Escape or a click outside.
  - It follows the primary monitor and hides over fullscreen windows.
- **Hub.** The expanded island.
  - Feature tabs sit in one column on the left, each named in a tooltip;
    the island grows taller when they need the room.
  - The panic bar is centered at the top, with 📅 (calendar and
    notifications) and ⚙️ (settings) on the right.
- **Calendar and notifications:** GNOME's own menu, the one its clock
  opens: notifications (with their actions, Clear and Do Not Disturb), the
  calendar, events, world clocks and weather. Froonty reimplements none of
  it.
  - **Open:** 📅 in the open island (or Tab to it, Enter), or GNOME's own
    `Super+V` at any time. It opens under the pill, and the island closes.
  - **Unread:** while GNOME's clock would show its dot, the pill shows it
    after the time, and 📅 carries it too. Opening GNOME's list marks
    them seen, and the dot goes.
  - Banners that arrive while the island is open wait, and show when it
    closes. See [docs/features/calendar.md](docs/features/calendar.md).
- **Panic buttons.** Up to 5 quick actions, chosen in Settings. Available
  now:
  - **Mute microphone** and **Mute sound**, through GNOME's own audio
    mixer.
  - **Claude session usage** shows the session's percentage, large, over a
    faint Claude Spark. A click opens the Claude tab.
  - The camera button (**Block camera for apps that ask GNOME**) is switched
    off for now; its code is kept
    ([details](docs/features/panic-buttons.md#4-block-camera-for-apps-that-ask-gnome)).
- **Clock** tab: weekday, time and date.
- **Calendar** tab: the events of every calendar GNOME knows, read-only
  and live: Google, Microsoft 365, Nextcloud and other accounts in
  Settings → Online Accounts, and calendars added in GNOME Calendar or
  Evolution (iCloud, any CalDAV or ICS address).
  - A month grid with GNOME's week start, week numbers and days off,
    and up to three calendar-coloured dots per day; a Day / Week / Month
    switch; the events as cards with "Now" and "Next", repeating events
    as GNOME expands them.
  - A click on an event opens its day in the web calendar it comes from
    (Google, Outlook; iCloud, Nextcloud and Yahoo open their calendar);
    buttons below the grid open each one on the selected day.
  - Froonty never adds, changes or removes an event. It reads Evolution
    Data Server once the tab has been opened, with no polling; while the
    tab is not on screen it only keeps what EDS sends. A large calendar
    is expanded a few milliseconds at a time, so it never stalls the
    desktop.
  - **Needs `gir1.2-ecal-2.0`** (`sudo apt install gir1.2-ecal-2.0`);
    without it the tab says so, and it starts off when it is missing on
    the first start. Microsoft 365 and Exchange calendars also need
    `evolution-ews-core` (EDS's backends, without the Evolution client).
    See [docs/features/calendar.md](docs/features/calendar.md).
- **Notifications** tab: GNOME's own notifications, urgent ones first,
  then newest first, each with its app, how long ago, its title, its
  body and up to three action buttons. Froonty keeps no copy.
  - Click one to open it, as in GNOME's list (the island closes). As in
    GNOME's list, a click on one whose app gave it no "open" action opens
    the app and removes all of that app's notifications (resident ones
    stay). × or Delete dismisses one: a double click on × or a held
    Delete dismisses only one. "Clear all" asks first ("Clear N?"; from
    the keyboard, the focus goes to "Keep them"), and keeps any its app
    updated meanwhile.
  - The tab carries GNOME's unread dot. Opening it on purpose marks what
    it lists as seen, as GNOME's list does, except those still waiting
    for their banner. Opening the island by hover alone does not, nor
    does typing on into your window afterwards (a modifier key, or any
    key before Tab moves the focus into the island).
  - A Do Not Disturb toggle, GNOME's own. Nothing is watched while the
    tab is not on screen, and nothing is ever removed without a click.
    See [docs/features/notifications.md](docs/features/notifications.md).
- **Media** tab: what music and video players report (MPRIS), with play,
  pause, skip and seek, the cover (tinting the island's accent), and a
  choice of player ("Automatic" picks the playing one).
  - While a song plays, the collapsed pill shows its cover and moving bars
    beside the time, and a new song's title for 3 s; a click opens the
    tab, a two-finger swipe changes song.
  - Lyrics (the player's own, a `.lrc` file next to a local song, or
    lrclib.net when allowed) and the player's upcoming songs, for players
    that share them.
  - The output volume, through GNOME's own mixer.
  - Nothing leaves the computer unless one of its two internet options is
    turned on. See [docs/features/media.md](docs/features/media.md).
- **Notes** tab: plain Markdown files in `~/.local/share/froonty/notes`.
  - Autosave, colours in the style of Sticky Notes, and a formatting bar.
  - A wrap toggle with horizontal scrolling.
  - Rename, middle-click to Trash, and pick-up of edits made in other
    programs. If a note changes elsewhere while you type, both versions
    are kept ("<name> (conflict)"). A note that cannot be saved stays
    open until it can; a note that is not plain UTF-8 text opens
    read-only.
  - Labels: right-click a note's tab (or Menu / Shift+F10) to add or remove
    them. They live in a hidden `.froonty-labels.json`; the `.md` files
    stay plain Markdown.
  - **All notes**, a button next to ⚙️ on the Notes tab (tinted with the
    note's colour), opens every note in a window: search them all, filter
    by labels (all of them, or any), and read or edit them there.
- **Claude** tab: your Claude plan's usage (Session, Weekly, Weekly Fable)
  and when each resets, as Claude Code last checked it.
  - It is read from Claude Code's own config file each time the tab opens.
    Froonty never contacts Claude and never polls.
  - Offline, the values read "Unknown", with a line saying why.
  - A last row shows Claude Opus 5.5 against its own launch week, from the
    independent [livenerf](https://github.com/ninjahawk/livenerf) benchmark:
    the latest day's score over a small copy of livenerf's chart, and the
    measured change once livenerf publishes one. These are the tab's only
    network requests: livenerf's README and chart, from GitHub, at most
    once an hour while the tab is open.
- **When Claude needs you:** a slim bar under the collapsed pill while a
  Claude session waits for you, e.g. "Claude needs your permission ·
  Froonty · Visual Studio Code". A click brings that window up; × hides it.
  - From Claude Code (terminal, VS Code, the Claude app's Code tab) through
    its hooks, after Settings → Claude → "Claude Code hooks" → **Set up**:
    a permission, a question, an error, a finished reply.
  - From the Claude app's own notifications, and (off by default)
    browser notifications that mention claude.ai.
  - Nothing is polled: Claude Code runs Froonty's small GJS script, which
    writes one file per waiting session under `$XDG_RUNTIME_DIR/froonty`,
    and Froonty watches that folder. Nothing Claude said is written down.
    See [docs/features/claude-attention.md](docs/features/claude-attention.md).
- **Btop** tab, a system monitor: the CPU (model, clock, temperature,
  load, and each thread's load and temperature in a fold-out), each
  graphics card (load, temperature, power, memory), RAM and cache, root,
  swap and EFI usage, and download/upload speed and totals. Each share is
  its value and a five-cell level, green to red (`▂▄▆▇█` at 100%).
  - It reads the computer only while the tab is on screen, every 2 s
    (1-10 s in Settings); sections switched off are not read.
  - NVIDIA cards are read with `nvidia-smi`, and never while asleep. See
    [docs/features/sysmon.md](docs/features/sysmon.md).
- **Clipboard** tab (off by default; turn it on in Settings → Clipboard):
  a history of what you copy or cut, meaning text, images and file
  locations. Click an entry to copy it again. It is kept on this computer
  only, readable by you only; password managers' copies are never kept.
  See [docs/features/clipboard.md](docs/features/clipboard.md).
- **Kill Process** tab (off by default; turn it on in Settings → Kill
  Process): all of your own processes, sorted by CPU load, memory or
  threads, with a filter by name, command line or process id, each with a
  kill button.
  - Two clicks: ⊘, then "Kill “name”?". The process is asked to quit
    (SIGTERM); "Force quit" (SIGKILL) is offered only if it is still
    running 3 s later.
  - GNOME Shell, whatever started it and a short list of session programs
    (gnome-session, systemd, Xwayland, D-Bus, PipeWire, the keyring) are
    never offered. Other users' processes are not listed, and Froonty
    never asks for administrator rights.
  - It reads `/proc` only while the tab is on screen, every 3 s (1-10 s
    in Settings), and runs `/usr/bin/kill` once per confirmed step. See
    [docs/features/kill-process.md](docs/features/kill-process.md).
- **ZeroTier** tab (working-tree installs only): whether ZeroTier runs,
  starts with the computer and reaches its network, and how each joined
  network is doing, with Start/Stop. Networks are managed in ZeroTier
  itself. Turned off on the first start when ZeroTier is not installed;
  see [docs/features/zerotier.md](docs/features/zerotier.md).
- **Always reachable.** With "Show island" off, a puzzle-piece icon in the
  top bar (and the shortcut) opens the settings.
- **Start at login**, or not. With it off, Froonty waits after login behind
  that icon; a click (or the shortcut) starts it.

> Planned: more panic buttons, rendered Markdown in notes and many more inspired from https://github.com/vorssaint/vorssaint-utils

## Layout

```
froonty@catalin/             the extension (this directory is what gets installed)
├── extension.js             lifecycle: enable/disable, settings, keybinding
├── prefs.js                 settings window (libadwaita)
├── stylesheet.css
├── schemas/                 GSettings schema
├── ui/
│   ├── island.js            the pill: actors, expand/collapse, grab
│   ├── geometry.js          pill sizes and position (covers the top bar clock)
│   ├── animations.js        content cross-fade
│   ├── chrome.js            registers the island as chrome + Ctrl+Alt+Tab
│   ├── collapsedView.js     collapsed content (time, optional date, unread dot)
│   ├── hub.js               expanded content: tab column, panic bar, header
│   ├── hubHeader.js         its top row: 📅, the active tab's buttons, ⚙️
│   ├── contextMenu.js       GNOME popup menus for features (note labels)
│   ├── panicBar.js          up to 5 panic buttons
│   ├── attentionBar.js      the "Claude needs you" bar under the pill
│   ├── hoverOpen.js         opens the island after hovering it
│   └── panelLauncher.js     top bar icon while the island is not shown
├── features/                hub tabs, one folder each (registry.js lists them)
│   ├── clock/
│   ├── calendar/            Calendar tab: Evolution Data Server (eds.js),
│   │                        month grid, agenda, provider links
│   ├── notifications/       GNOME's own notifications (through ctx.notifications)
│   ├── media/               MPRIS players: watcher, service, tab, pill music,
│   │                        lyrics, up next
│   ├── notes/               Markdown notes: store, service, tabs, editor,
│   │                        labels, the All notes window page, prefs
│   ├── claude/              Claude plan usage, read from Claude Code's config;
│   │                        livenerf's Opus 5.5 row, fetched from GitHub;
│   │                        the attention bar's hook script, set-up and model
│   ├── sysmon/              Btop tab (system monitor): /proc and /sys, nvidia-smi
│   ├── clipboard/           clipboard history: recorder, store, tab
│   └── killprocess/         Kill Process tab: your processes from /proc, kill(1)
├── panic/                   panic button catalog, factories, buttons (mute,
│                            Claude session, block camera, pause media), prefs
├── core/                    shared by features: emitter.js, tooltip.js
├── services/clock.js        clock ticks from the top bar's GnomeDesktop.WallClock
└── shell/                   adapters over GNOME Shell APIs
    ├── dateMenu.js          the clock, GNOME's calendar and notification menu
    ├── messageTray.js       GNOME's notifications for the Notifications tab
    ├── notificationStore.js the only code reading or writing them (Shell-free)
    ├── mixer.js             the Shell's shared audio mixer
    ├── claudeAttention.js   the attention bar's apps, windows, focus, banners
    └── settingsWindow.js    opens or raises the settings window (or its
                             All notes page)
third_party/livenerf/        git submodule: the benchmark behind the Claude
                             tab's Opus 5.5 row (not installed or packed)
tools/headless-test/         isolated headless GNOME Shell test harness
tools/unit/                  plain-gjs unit tests
docs/DESIGN.md               GNOME Shell API analysis, private APIs, risks
docs/features/               one design note per feature
docs/local/                  local notes and build rules (not in git)
```

## Develop

```sh
make install    # compiles schemas, copies into ~/.local/share/gnome-shell/extensions
make pack       # builds a public archive without local-only ZeroTier controls
```

`make install` copies rather than links, so Froonty starts at login even
when the working tree is on a drive that is mounted later. Run it again
after each change.

GNOME Shell only discovers new extensions at startup: log out and back in.

Then run:

```sh
gnome-extensions enable froonty@catalin
gnome-extensions prefs froonty@catalin
make log        # follow GNOME Shell's journal
make pack       # build dist/froonty@catalin.shell-extension.zip
```

## Test

```sh
make unit       # fast: pure logic and file I/O, no Shell (the GTK
                # All notes page on a private Broadway display)
make test       # headless GNOME Shell 50, default and Ubuntu session modes
tools/headless-test/run.sh --keep   # one mode, keep screenshots and logs
```

`make test` runs a fully isolated headless GNOME Shell 50:

- its own session bus and an empty private system bus
- private XDG dirs and keyfile GSettings
- two virtual monitors
- a private PipeWire with a virtual speaker and microphone. The host's audio
  hardware is never touched.

It drives real pointer and keyboard input. It also checks, among other
things:

- mute and unmute;
- that Notes text is really visible when scrolled (pixel checks);
- a real primary-monitor switch;
- 25 enable/disable cycles with a before/after leak footprint.

It exits non-zero on any failure. Your real session, dconf and extensions
directory are never touched.

`tools/headless-test/unsafe-mode@froonty-test` is a **test-only** helper that
enables unsafe mode (for `org.gnome.Shell.Eval`) inside that throwaway
session. Never install it in a real session.

## Settings

The settings window (⚙️, the top bar icon while the island is hidden, or
`gnome-extensions prefs froonty@catalin`) opens as its own window. Among
its tabs:

- **General:** startup, island, hover, shortcut, clock.
- **Appearance:** size, animation.
- **Panic buttons:** which buttons, and their order.
- **Calendar:** enable, Online Accounts, which calendars, size.
- **Notifications:** enable, size.
- **Media:** enable, music on the island, players followed, lyrics, up
  next, cover art from the internet, size.
- **Notes:** enable, folder, size, All notes.
- **Claude:** enable.
- **Kill Process:** enable, refresh interval, what is never killed, size.
- **ZeroTier:** enable, allow reading ZeroTier's status.

The keys behind it:

| Key | Default | |
|---|---|---|
| `start-at-login` | `true` | When off, Froonty waits after login with only a top bar icon; a click or the shortcut starts it. A screen unlock keeps the current state |
| `island-enabled` | `true` | Tears down the island without disabling the extension; a top bar icon (and the shortcut) then opens the settings |
| `hide-panel-clock` | `true` | Makes the top bar clock transparent; its menu keeps working |
| `hover-open-delay` | 350 ms | Open the island after hovering it this long; 0 turns it off |
| `toggle-shortcut` | `['<Super><Alt>i']` | |
| `show-date` | `false` | |
| `clock-format` | `system` | `system`, `24h` or `12h` |
| `collapsed-width` / `collapsed-height` | 160 / 28 | Logical px. Both are minimums: while the top bar clock is hidden, the pill grows to cover its button completely |
| `expanded-width` / `expanded-height` | 360 / 140 | Logical px; used by tabs without their own size (Clock) |
| `corner-radius` | 14 | Clamped to half the height by St |
| `animation-duration` | 250 ms | GNOME's enable-animations setting still applies |
| `panic-buttons` | microphone, sound | Panic buttons in bar order, at most 5 |
| `calendar-enabled` | `true` | Show the Calendar tab; turned off once, on the first start, when `gir1.2-ecal-2.0` is missing |
| `calendar-hidden-sources` | `[]` | Evolution Data Server calendar ids hidden in the tab |
| `calendar-granularity` | `week` | `day`, `week` or `month`; chosen in the tab |
| `calendar-width` / `calendar-height` | 620 / 380 | Logical px, while the Calendar tab is shown |
| `calendar-eds-checked` | `false` | The first-start check for `gir1.2-ecal-2.0` ran (internal) |
| `notifications-enabled` | `true` | Show the Notifications tab (GNOME's own notifications) |
| `notifications-width` / `notifications-height` | 400 / 440 | Logical px, while the Notifications tab is shown |
| `media-enabled` | `true` | Show the Media tab |
| `media-show-in-pill` / `media-track-notice` | `true` | Cover and bars beside the time while music plays; a new song's title for 3 s |
| `media-include-other-players` | `true` | Follow browsers and video players automatically (off: only when chosen) |
| `media-remote-art` / `media-lyrics-online` | `false` | The Media tab's two internet options: web covers, lyrics from lrclib.net |
| `notes-enabled` | `true` | Show the Notes tab |
| `notes-folder` | `''` | Notes folder; empty means `~/.local/share/froonty/notes` |
| `notes-wrap` | `true` | Wrap long lines in notes; off scrolls horizontally |
| `notes-show-tools` | `true` | Show the notes formatting row (it can be folded away) |
| `notes-label-match` | `all` | All notes window: `all` shows notes with every selected label, `any` with at least one |
| `settings-window-view` | `settings` | Which page the settings window shows, `settings` or `all-notes` (internal) |
| `claude-enabled` | `true` | Show the Claude tab |
| `zerotier-enabled` | `true` | Show the ZeroTier tab |
| `zerotier-install-checked` | `false` | ZeroTier's installation was checked on the first start (internal) |
| `hub-last-tab`, `notes-last` | | Remembered selections (internal) |

## License and provenance

Froonty is an independent implementation. NexNotch
(<https://github.com/NexVar/NexNotch>, GPL-3.0-or-later) was used only as a
behavioral and visual reference; **no NexNotch code was copied or adapted**.
Details are in [docs/DESIGN.md §3](docs/DESIGN.md#3-nexnotch-review).
vorssaint-utils (GPL-3.0-or-later) was used as a layout reference. The
Media tab's behaviour is adapted from vorssaint-utils (GPL-3.0-or-later);
no branding was taken. A few of its rules (the LRC parser, the lrclib
match, the cover tint, new-song detection) follow its code closely, and
those files carry its copyright line.

Copyright (C) 2026 Catalin Niculescu.

Froonty is free software, licensed under the **GNU General Public License
v3.0 or later** (`GPL-3.0-or-later`); see [LICENSE](LICENSE). Each source file
carries an SPDX license identifier.
