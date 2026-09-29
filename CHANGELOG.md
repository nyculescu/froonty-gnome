# Changelog

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
