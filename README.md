# Froonty

A small Dynamic-Island-style pill at the top center of the screen for
**GNOME Shell 46** (Ubuntu 24.04). The island is a compact entry point to
facilities GNOME Shell already has. It does not reimplement them.

Status: **0.2.0-rc1**, a release candidate. See [CHANGELOG.md](CHANGELOG.md).

- No subprocesses, no network access, no polling timers.
- GJS and native GNOME Shell APIs only.

See [docs/DESIGN.md](docs/DESIGN.md) for the GNOME 46 API analysis, the list
of private APIs used, compatibility risks and the NexNotch review. Each
feature has a design note in [docs/features/](docs/features/).

## Features

- **Island.** A pill replaces the top bar clock visually. GNOME's clock stays
  underneath, so its calendar menu keeps working.
  - **Open:** click, hover (350 ms, configurable), `Super+Alt+I` or
    Ctrl+Alt+Tab.
  - **Close:** Escape or a click outside.
  - It follows the primary monitor and hides over fullscreen windows.
- **Hub.** The expanded island.
  - Feature tabs sit in a column on the left, each named in a tooltip.
  - The panic bar is centered at the top, with ⚙️ (settings) on the right.
- **Panic buttons.** Up to 5 quick actions, chosen in Settings. Available
  now: **Mute microphone** and **Mute sound**, through GNOME's own audio
  mixer.
- **Clock** tab: weekday, time and date.
- **Notes** tab: plain Markdown files in `~/.local/share/froonty/notes`.
  - Autosave, colours in the style of Sticky Notes, and a formatting bar.
  - A wrap toggle with horizontal scrolling.
  - Rename, middle-click to Trash, and pick-up of edits made in other
    programs.
- **Always reachable.** With "Show island" off, a puzzle-piece icon in the
  top bar (and the shortcut) opens the settings.

Planned: Calendar (Evolution Data Server; see
[docs/features/calendar.md](docs/features/calendar.md)), more panic buttons,
and rendered Markdown in notes.

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
│   ├── collapsedView.js     collapsed content (time, optional date)
│   ├── hub.js               expanded content: tab column, panic bar, ⚙️
│   ├── panicBar.js          up to 5 panic buttons
│   ├── hoverOpen.js         opens the island after hovering it
│   └── panelLauncher.js     top bar icon while the island is hidden
├── features/                hub tabs, one folder each (registry.js lists them)
│   ├── clock/
│   └── notes/               Markdown notes: store, service, tabs, editor, prefs
├── panic/                   panic button catalog, factories, mute buttons, prefs
├── core/                    shared by features: emitter.js, tooltip.js
├── services/clock.js        GnomeDesktop.WallClock-based clock
└── shell/                   adapters over GNOME Shell APIs
    ├── dateMenu.js          the only place touching Shell internals
    ├── mixer.js             the Shell's shared audio mixer
    └── settingsWindow.js    opens or raises the settings window
tools/headless-test/         isolated headless GNOME Shell test harness
tools/unit/                  plain-gjs unit tests
docs/DESIGN.md               GNOME 46 API analysis, private APIs, risks
docs/features/               one design note per feature
docs/local/                  local notes and build rules (not in git)
```

## Develop

```sh
make install    # compiles schemas, symlinks into ~/.local/share/gnome-shell/extensions
```

GNOME Shell 46 only discovers new extensions at startup:

- **Wayland:** log out and back in.
- **X11:** press Alt+F2, type `r`, press Enter.

Then run:

```sh
gnome-extensions enable froonty@catalin
gnome-extensions prefs froonty@catalin
make log        # follow GNOME Shell's journal
make pack       # build dist/froonty@catalin.shell-extension.zip
```

## Test

```sh
make unit       # fast: pure logic and file I/O, no Shell
make test       # headless GNOME Shell 46, default and Ubuntu session modes
tools/headless-test/run.sh --keep   # one mode, keep screenshots and logs
```

`make test` runs a fully isolated headless GNOME Shell 46:

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
`gnome-extensions prefs froonty@catalin`) opens as its own window. It has
four tabs:

- **General:** island, hover, shortcut, clock.
- **Appearance:** size, animation.
- **Panic buttons:** which buttons, and their order.
- **Notes:** enable, folder.

The keys behind it:

| Key | Default | |
|---|---|---|
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
| `notes-enabled` | `true` | Show the Notes tab |
| `notes-folder` | `''` | Notes folder; empty means `~/.local/share/froonty/notes` |
| `notes-wrap` | `true` | Wrap long lines in notes; off scrolls horizontally |
| `notes-show-tools` | `true` | Show the notes formatting row (it can be folded away) |
| `hub-last-tab`, `notes-last` | | Remembered selections (internal) |

## License and provenance

Froonty is an independent implementation. NexNotch
(<https://github.com/NexVar/NexNotch>, GPL-3.0-or-later) was used only as a
behavioral and visual reference; **no NexNotch code was copied or adapted**.
Details are in [docs/DESIGN.md §3](docs/DESIGN.md#3-nexnotch-review).
vorssaint-utils (GPL-3.0-or-later) was likewise used as a layout reference
only; no code or branding was taken.

Copyright (C) 2026 Catalin Niculescu.

Froonty is free software, licensed under the **GNU General Public License
v3.0 or later** (`GPL-3.0-or-later`); see [LICENSE](LICENSE). Each source file
carries an SPDX license identifier.
