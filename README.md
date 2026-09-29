# Froonty

A small Dynamic-Island-style pill at the top center of the screen for
**GNOME Shell 46** (Ubuntu 24.04). The island is a compact entry point to
facilities GNOME Shell already has. It does not reimplement them.

Status: **Phase 1** (foundation). The collapsed pill shows the time and,
optionally, the date. Click it, press `Super+Alt+I` or use Ctrl+Alt+Tab to
expand it; press Escape or click outside to collapse it. The ⚙️ button in
the expanded island's top-right corner (or Tab, then Enter) opens the
settings window.

- No subprocesses, no network access, no polling timers.
- GJS and native GNOME Shell APIs only.

See [docs/DESIGN.md](docs/DESIGN.md) for the GNOME 46 API analysis, the list
of private APIs used, compatibility risks and the NexNotch review.

## Layout

```
froonty@catalin/          the extension (this directory is what gets installed)
├── extension.js          lifecycle: enable/disable, settings, keybinding
├── prefs.js              libadwaita preferences
├── stylesheet.css
├── schemas/              GSettings schema
├── ui/island.js          the pill: actors, expand/collapse, grab
├── ui/geometry.js        pill sizes and position (covers the top bar clock)
├── ui/collapsedView.js   collapsed content (time, optional date)
├── ui/hub.js             expanded content: vertical tab column, panic bar, ⚙️
├── ui/panicBar.js       up to 5 panic buttons (Settings → Panic buttons)
├── panic/               panic button catalog, factories, mute buttons, prefs
├── shell/mixer.js       adapter: GNOME Shell's shared audio mixer
├── core/tooltip.js      hover bubble (hub tabs, note tabs)
├── ui/hoverOpen.js       opens the island after hovering it (configurable)
├── ui/panelLauncher.js   top bar icon while the island is hidden
├── ui/chrome.js          registers the island as chrome + Ctrl+Alt+Tab
├── features/registry.js  every hub feature, in tab order
├── features/clock/       the Clock tab (first feature)
├── features/notes/       the Notes tab (Markdown files, autosave)
├── core/emitter.js       signal base for feature services (Shell-free)
├── services/clock.js     GnomeDesktop.WallClock-based clock (start/stop)
├── shell/dateMenu.js     adapter: the only place touching Shell internals
└── shell/settingsWindow.js  opens or raises the settings window
tools/headless-test/      isolated headless GNOME Shell test harness
tools/unit/              plain-gjs unit tests for feature logic
docs/DESIGN.md            GNOME 46 API analysis, private APIs, risks
docs/local/ideas.md       features list, ongoing work, ideas, build rules (local, not in git)
docs/features/            one design note per feature
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
```

To test without touching your session, run a nested Wayland shell:

```sh
dbus-run-session -- gnome-shell --nested --wayland
```

## Test

```sh
make unit                          # fast: pure logic and file I/O, no Shell
```sh
make test                          # or: tools/headless-test/run.sh --keep
FROONTY_TEST_MODE=ubuntu make test # with Ubuntu's session mode
```

The test starts an isolated headless GNOME Shell 46 with:

- its own session bus
- an empty private system bus
- private XDG dirs
- keyfile GSettings
- two virtual monitors

It then drives real pointer and keyboard input, switches the primary monitor
through Mutter's D-Bus API, and runs 25 enable/disable cycles with a
before/after leak footprint. It also opens the preferences window. Your real
session, dconf and extensions directory are never touched.

`tools/headless-test/unsafe-mode@froonty-test` is a **test-only** helper that
enables unsafe mode (for `org.gnome.Shell.Eval`) inside that throwaway
session. Never install it in a real session.

## Settings

The settings window (⚙️, or `gnome-extensions prefs froonty@catalin`) opens as
its own window with tabs: **General** (island, shortcut, clock) and
**Appearance** (size, animation). The keys behind it:

| Key | Default | |
|---|---|---|
| `island-enabled` | `true` | Tears down the island without disabling the extension; a top bar icon (and the shortcut) then opens the settings |
| `hide-panel-clock` | `true` | Makes the top bar clock transparent; its menu keeps working |
| `hover-open-delay` | 350 ms | Open the island after hovering it this long; 0 turns it off |
| `toggle-shortcut` | `['<Super><Alt>i']` | |
| `show-date` | `false` | |
| `clock-format` | `system` | `system`, `24h` or `12h` |
| `collapsed-width` / `collapsed-height` | 160 / 28 | Logical px. Both are minimums: while the top bar clock is hidden, the pill grows to cover its button completely (full top bar height, full clock width) |
| `expanded-width` / `expanded-height` | 360 / 140 | Logical px |
| `corner-radius` | 14 | Clamped to half the height by St |
| `animation-duration` | 250 ms | GNOME's enable-animations setting still applies |
| `panic-buttons` | microphone, sound | Panic buttons in bar order, at most 5 |
| `notes-enabled` | `true` | Show the Notes tab |
| `notes-folder` | `''` | Notes folder; empty means `~/.local/share/froonty/notes` |
| `notes-wrap` | `true` | Wrap long lines in notes; off scrolls horizontally |
| `hub-last-tab`, `notes-last` | | Remembered selections (internal) |

## License and provenance

Froonty is an independent implementation. NexNotch
(<https://github.com/NexVar/NexNotch>, GPL-3.0-or-later) was used only as a
behavioral and visual reference; **no NexNotch code was copied or adapted**.
Details are in [docs/DESIGN.md §3](docs/DESIGN.md#3-nexnotch-review).

Copyright (C) 2026 Catalin Niculescu.

Froonty is free software, licensed under the **GNU General Public License
v3.0 or later** (`GPL-3.0-or-later`); see [LICENSE](LICENSE). Each source file
carries an SPDX license identifier.
