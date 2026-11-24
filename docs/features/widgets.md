# Feature: Widgets

Status: **first iteration, implemented**, 2026-11-07.

The Widgets tab gathers cards from features of their own: Markets
([markets.md](markets.md)) and Horizon's news briefings
([horizon.md](horizon.md)), plus, on the desktop only, the System card
(below) and the notes' stickies ([notes.md](notes.md)). Widgets sets
where the cards show and how they look; what they show is set on their
own pages (owner, 2026-11-23: "The widgets are a wrapper-feature to
features like Markets, Notes and Horizon News"). In the tab the Markets
and Horizon cards scroll together in one scroll view (`tab.js`), so a
long list of symbols does not push the briefings out of the tab's fixed
height. On the desktop, where each card has a maximum height, each
card's list scrolls under its header.

## Where a card shows

`cards.js`: the Markets or Horizon card shows in a place while its
feature (`markets-enabled`, `horizon-enabled`), the place
(`widgets-enabled` for the tab, `widgets-desktop-enabled` for the
desktop) and its own switch there are on. Each card holds its feature's
service only while it shows (`tab.js`, `desktopLayer.js`). With neither
card in the tab, the tab says how to show one.

The Refresh Markets and Refresh Horizon panic buttons' right-click menus
([panic-buttons.md](panic-buttons.md)) show or hide each card with the
same rule: "In the Widgets tab" or "On the desktop" on turns on all it
needs (the feature, the tab or all desktop widgets, the card's switch);
off turns off only the card's own switch there, so the other cards stay.

## Configuration

- `widgets-enabled` (on): the Widgets tab in the island, and only that
  (2026-11-23, owner: the tab is not needed, the desktop widgets are).
- On the desktop (Settings → Widgets → On the desktop):
  `widgets-desktop-enabled` (on) shows or hides them all;
  `widgets-markets-pin-desktop`, `widgets-news-pin-desktop` (off) and
  `widgets-stickies-on-desktop` (on; the stickies also need the Notes
  tab, the Markets card `markets-enabled`) are each item's own switch.
  None depends on `widgets-enabled`.
- `widgets-desktop-positions` (`a{s(iiii)}`: item → x, y, width,
  height): each item's own place and size, set by dragging (owner,
  2026-11-23: "remove the shifts … I want to place Horizon news on the
  Market's right and I can't. If we remove the corners, we might do it";
  before, one group in columns, then each in a corner with shifts).
  Items: `markets`, `news`, `system`, and each note pinned to the
  desktop as `sticky:NOTE` (owner: "split … by Notes stickies 1, 2,
  etc.", each its own width). x and y are per ten thousand of the room
  the item can move in, so 0 is the room's left or top edge and 10000
  its right or bottom edge, and an item at an edge stays there when its
  size or the screen changes. The room is the primary monitor's work
  area. Width is the card's content width (200-1200 px; padding and
  border are outside it; set as both `width` and `max-width`, as St takes
  `width` as the least natural width); height caps it (120-2000 px; 0:
  as tall as its content, Markets 8 rows, `features/markets/view.js` `MAX_ROWS`).
  Defaults: Markets, Horizon (at most 420 px) and System (260 px wide)
  stacked top left, each sticky top right (300 × 300), under the ones
  before it. `placement.js` holds the rules, tested in
  `widgets-placement.test.js`:
  - Items never overlap each other or a dock. They are placed the
    highest first (ties: Markets, Horizon, System, then the stickies in
    pin order); one that would overlap an item placed before it, or a
    dock, is cut to fit above it when that leaves it at least 120 px (or
    its height), else goes down past it; with no room below either, it
    goes beside what was in its way, at the height it wanted (`settle`).
    One cut to fit scrolls within.
  - Beside a fixed dock that reserves its whole strip but leaves at least
    150 px of it free (the Ubuntu dock not filling the height), the room
    takes in the strip and the dock is in the way: an item may sit above
    it, from the screen's edge, cut at its top (owner's choice). A dock
    that fills its strip leaves it out (`desktopRoom`, `shell/dock.js`).
- Settings → Widgets → On the desktop (`desktopPrefs.js`, three groups:
  a preferences group puts its rows above any other widget in it): the
  switches (one for all, one per widget, one for all stickies), then a
  picture of the primary monitor with its top bar and dock and each
  shown item's box exactly where the Shell put it (its geometry), at its
  measured size; widgets not on the desktop dimmed, placed around the
  shown ones; stickies only as the Shell last listed them, "Notes sticky
  1, 2, …" in pin order, the note named in the tooltip. No size rows
  (owner, 2026-11-23: the edges' arrows, not sliders). Drag a box
  anywhere: it settles as it moves (`snapBox`, shown live): within 24 px
  its edges line up with another box's or the room's, over another box
  it goes to that box's nearest free side, and it stays clear of the top
  bar and the dock, like GNOME Settings' Displays page. A dropped box
  stays where it landed until the Shell's geometry follows (at most
  1.5 s), so it does not jump back and forth. Drag any edge or corner to
  resize it (the arrow cursor shows which); from the left or the top the
  box moves too, its far edge staying put. One drag gesture on the picture,
  which stays put, finds the box under the pointer (a gesture on each box
  made the boxes shake, reported 2026-11-23). Arrow keys move the
  selected box 1 % of its room, Shift+arrows resize it by 10 px. Reset
  layout gives the defaults back.
  The Shell writes the picture's geometry to the internal
  `widgets-desktop-geometry` (`a{s(iiii)}`: monitor, work area, dock and
  each shown item's box) after each layout that changed it.
- Desktop items (`desktopLayer.js`) are an extension part: each exists
  while its switches are on, whether or not the tab was opened. They
  share their services with the tab (`news/shared.js`,
  `features/markets/shared.js`). They are laid out again, once before the
  next redraw, when the placement, the work area (a fixed dock reserves its
  space after Froonty starts, also after each unlock), the dock (it moves
  or grows as apps are added) or an item's size (it fills) changes.
- Stacking: Desktop Icons NG (on in Ubuntu's session) covers each monitor
  with a transparent window that took the cards' clicks and scrolling
  (seen 2026-11-20). Where it runs, the layer goes in the window group
  right above its topmost window, below every other window, and again
  after each `restacked` (Mutter puts window actors back in order then,
  leaving other actors above them). Without it, the layer is on GNOME's
  background group. `shell/desktopIcons.js` finds its windows by the
  `customJS_ding.keepAtBottom` its extension sets on them; their titles
  differ between versions ("Desktop Icons 1", "@!x,y;BDHF"), and it
  replaces `global.get_window_actors()` to leave them out, so the window
  group is read. `testDesktopPins` checks both cases (Desktop Icons runs
  in the headless test's Ubuntu mode).
- The layer (`desktopLayer.js`) holds the widget cards and the notes
  pinned to the desktop as stickies (`features/notes/stickies.js`,
  docs/features/notes.md), each placed in it; they are moved, never made
  again, so a card keeps its scrolling. It is kept while Froonty runs,
  hidden while empty, so it keeps its place in the stacking.
- `widgets-desktop-actions` (on): Settings → Widgets → "Clicks on Markets
  and Horizon". Off, the desktop Markets rows and Horizon headlines take
  no pointer (`setActions` in their views): the cards only scroll, the
  wheel reaching their scroll views. The island's tab is not affected.
- The **Desktop widgets** panic button (`desktop-widgets`,
  panic/desktopWidgets.js) goes through three states, a click to the
  next: shown with scrolling and clicks, shown with scrolling only,
  hidden (`widgets-desktop-enabled` off), and back with clicks; checked
  while hidden (docs/features/panic-buttons.md).
- `widgets-desktop-locked` (off): **Widget Lock** in Quick Settings
  (`lockToggle.js`), there while a card or sticky shows (user request,
  2026-11-20: "how can I lock again the widgets to not be active"). On,
  the whole layer is hidden from picking, so clicks and scrolling reach
  the desktop and Desktop Icons under it.
- `widgets-markets-enabled` (on, in the tab), `widgets-markets-range`
  (`1d`): how the Markets card looks (below). Its symbols and sources:
  [markets.md](markets.md).
- `widgets-news-enabled` (on, in the tab): the Horizon card. Its own
  settings: [horizon.md](horizon.md).

## Markets and Horizon

Each a feature of its own since 2026-11-23 (owner: "make Markets a
standalone feature … Only the visuals should be configured from
Widgets", then the same for Horizon): what they show is on Settings →
Markets ([markets.md](markets.md)) and Settings → Horizon
([horizon.md](horizon.md)). Settings → Widgets keeps how the cards look
and where they show: "Show Markets in the Widgets tab" and "Graph span",
"Show Horizon in the Widgets tab"; the desktop cards' switches and places
are under "On the desktop". A feature off, its card shows nowhere and its
group there is dimmed.

## System (Settings → Widgets → System)

Added 2026-11-23 (owner: "a new widget from Btop … configurable on what
to show … history from the last 30 minutes for each metric"; then
"adjustable on width … the period … a Moving Average … the order"). A desktop
card only, like the others placed on Settings → Widgets → On the desktop
(`widgets-system-pin-desktop`, off; `system` in `placement.js`, top left,
260 px wide, as tall as its rows; any width from 200 px there). Per
chosen reading: its value now (coloured as Btop's levels and the
temperature readouts), its name with its low and high over the period,
and a graph of the period, the right edge now. The graph takes the row's
width left (at least 60 px), so a narrow card stays compact. Every row's
value is as wide as the widest value (right-aligned) and every name as
wide as the widest name (less on a narrow card), so the parts line up
as columns whatever a name's length, and the last part ends at the
card's edge (a Clutter grid did not give the graph the width left). A pause of
over three intervals (a lock, a suspend) breaks the line.

- `widgets-system-metrics` (CPU load, CPU temperature, RAM, download and
  upload): any of the 13 in `system/metrics.js`: CPU load, temperature
  (average of the cores), hottest core and clock; RAM and swap; GPU load,
  temperature, memory and power (the busiest awake card); download and
  upload; root disk used. Shown in that order.
- `widgets-system-interval` (5 s, 2-60): how often it reads.
- `widgets-system-period` (30 min, 5-240): what each graph, and its low
  and high, cover. The header says it ("Last 30 min").
- `widgets-system-average` (`off`; 30, 60, 120 or 300 s): the graphs draw
  each reading's trailing moving average over that window
  (`movingAverage`), so quick swings do not hide the trend; the value
  shown stays the latest reading, and the header adds "· 1 min average".
  The average is drawn in front of the readings, in solid orange.
- `widgets-system-layout` (`value-name-graph`): the order of a row's
  parts, any of the six (`LAYOUTS`).
- Resources: Btop's own sampler (`SystemSampling`, `features/sysmon`),
  reading only the sections the chosen readings need, only while the card
  exists. GPU readings run `nvidia-smi` on an NVIDIA card, which may keep
  it awake (as for the readouts).
- History: per reading, its points of the period in wall time,
  in the service module (`system/service.js`), so it outlives a screen
  lock (GNOME disables extensions then; the card goes, the module stays)
  and is dropped when the card is switched off or Froonty stops
  (`DesktopPins.destroy({locked})`, `forget`). At 5 s and 30 minutes
  that is at most 360 numbers per reading (2880 at 240 minutes); a
  shorter period prunes at once. A reading taken off the list loses its history.
- Tests: `tools/unit/widgets-system.test.js` (readers, formats, history,
  the service's record, lock and switch-off),
  `widgets-system-prefs.gtk.test.js` (the switches), and headless
  `testDesktopSystem`.
