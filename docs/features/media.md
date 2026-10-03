# Feature: Media

Status: **first iteration, implemented**, 2026-10-02. Public (in `make
pack` output). **On by default.**

What music and video players on this computer report over MPRIS, with
play, pause, skip and seek: a tab in the island, the song on the collapsed
pill, lyrics, the player's upcoming songs, and a "Pause all media" panic
button. Design adapted from vorssaint-utils (GPL-3.0-or-later).

GNOME already has a media card in its notification list; Froonty leaves it
alone (DESIGN.md §2, principle 1). The tab adds what that card lacks: the
position and seeking, a large cover, a choice of player, lyrics, the
upcoming songs, and the song on the pill.

## Look

```
┌────────┐  Title                       [Source ▾] ▁▃▂
│  art   │  Artist
│        │  ━━━━━━━━━●──────────────
└────────┘  1:23                              −2:04
            ⏮        ( ⏯ )        ⏭
[lyrics or up next, while open]
🔈 ━━━●──                          [≡ Lyrics] [• Up next]
```

- **Size:** 480 × 248 px by default (Settings → Media → Size,
  `media-width` 360-960, `media-height` 200-720). Lyrics and Up next add
  224 px while open (216 for the panel, 8 of spacing); the island then
  stays on the monitor.
- **Player row:** the cover is as tall as the row (56-200 px), with
  rounded corners (16 px, 12 px on a short row) and a soft halo in the
  cover's colour. Beside it: the title (one line, ellipsized, the whole
  title in a tooltip), the artist (or the album), the timeline and the
  transport. A short row first uses smaller type and buttons, then drops
  the artist, then the timeline.
- **Accent:** the slider and the moving bars take the cover's colour;
  white when the cover has none (dark or grey covers).
- **Timeline:** a slider when the player can seek, a read-only bar when it
  cannot, nothing for live streams (no length) or when the player does not
  tell its position. Elapsed time on the left, remaining time on the right
  (`m:ss`, `h:mm:ss` from an hour).
- **Transport:** previous, a large white play/pause, next. Previous and
  next hide only when the player says it cannot skip (`CanGoNext` false);
  a player that does not say keeps them. A player that cannot be
  controlled (`CanControl` false) shows "This player can't be controlled
  from here." and "Open player" instead.
- **Nothing playing:** a note tile, "Nothing playing", and "Your music and
  playback controls appear here." Never shown before the first reading:
  the tab stays blank until the players are known (at most 1 s).
- **Failed command:** "Could not change playback." in yellow, in place of
  the artist, until the next command or the next song.
- **Paused:** the cover shrinks slightly (94%); the bars stand still.
- The cover opens the player (its app; else the player's own Raise), and
  the island closes.

## Players and the automatic choice

- **Players** are the MPRIS names on the session bus
  (`org.mpris.MediaPlayer2.*`), found with `ListNames` and followed with
  `NameOwnerChanged`. `playerctld` is never listed (it mirrors other
  players). At most 16.
- **One entry per player.** A process that publishes one song under two
  names (VLC: `vlc` and `vlc.instance…`) is one source; one process with
  different songs (KDE Connect, one name per phone) stays several.
- **Name:** the app's (its `DesktopEntry`, else the app whose windows
  belong to the player's process), else the player's `Identity`, else its
  bus name. Two sources with one name get their song's title after it.
- **Music apps** are apps with the `Audio` or `Music` desktop category
  (never `WebBrowser`), and the daemons `mpd`, `spotifyd`, `ncspot` and
  `cmus` (their bus names are not verified).
- **The automatic choice**, in order:
  1. a source you chose (with a song), even paused;
  2. a playing music player;
  3. a playing browser or video player that started last or is already
     shown (with "Follow browsers and video players automatically");
  4. a paused music player;
  5. with that setting on, the player that played last.

  Ties go to the source already shown, then the one that started playing
  last, then the lowest process id, then the bus name.
- **"Follow browsers and video players automatically"** is **on** by
  default (vorssaint-utils has it off). A browser cannot be told apart
  from a music app over MPRIS, and much music plays in a browser (Apple
  Music as a Brave web app, for one). Off, they show only when chosen.
- **Choosing a source** (the chip "Name ▾" opens a list over the player;
  "Automatic" first): the tab shows nothing until the chosen source's
  first reading, and controls of the previous source stop at once. A
  chosen source without a song keeps the choice (and its check mark)
  for 5 s while the automatic choice fills in. The choice ends when that
  player exits, or another process takes its name.
- The choice lives in memory, for as long as GNOME Shell runs: a screen
  lock (which runs `disable()`) keeps it; logging out forgets it.

## Commands and their safety

- Every control acts on the context it was drawn with: the source, its
  owner (the unique bus name, `:1.42`), the song and a revision number that
  changes with every song or source.
- **Refused** (nothing sent) during a gap hold (below), after the song or
  the source changed, or when the owner differs.
- **Checked again** before sending: Froonty reads the player's Metadata
  (1 s at most) and sends only if it is still the same song.
- **Sent only to that owner**, never to a well-known name and never to
  "whichever player is active": a player that restarts gets a new unique
  name, so an old button can never reach it.
- 2 s at most per command, no retry. Play/Pause sends `Pause` while
  playing (if it may pause), `Play` while not, else `PlayPause`.
- **Seeking:** `SetPosition(trackid, position)` when the song has a track
  id, else `Seek(offset)`. One seek in flight per source; a newer target
  replaces a waiting one. After the reply the position is read again,
  since some players do not announce a jump. The slider keeps its thumb
  at the target until the player is within 2 s of it, or 1 s passes.

## Position

- Read with `Properties.Get` (never from a proxy's cache: players do not
  announce position changes) only for the shown source and only while the
  tab is on screen: when it comes on screen, on a new song, on a play,
  pause or rate change, and after a seek. A `Seeked` signal from any
  player updates that player at once.
- In between, the position is extrapolated by the playback rate (a
  browser at 2× moves twice as fast).
- **Display tick:** one timer, only while the tab is on screen and the
  song plays with a known length and position. It reads nothing; each
  tick fires at the next whole second shown (the delay is computed from
  the position and the rate, 50-1100 ms). It has no setting because its
  step is the unit shown (DESIGN.md §2.2).
- **A position that stays 0** while playing (reported for Spotify; not
  verified): Froonty checks once more 3 s later; still 0 and no `Seeked`
  meanwhile, the timeline hides for that player until a real position
  comes.

## Art (and why not TextureCache or CSS)

- `mpris:artUrl` with `file://` is read asynchronously (regular files up
  to 12 MiB) and decoded with GdkPixbuf at the size shown. `http(s)://`
  covers are fetched only with "Cover art from the internet" on (below).
  `data:` and other addresses show the placeholder.
- Loaded only while the tab or the pill shows a cover, as soon as the song
  changes (Chromium and Firefox delete their old cover files).
- **Not `St.TextureCache.load_file_async`:** it keeps a file monitor on
  every file it ever loaded, for the life of the Shell. **Not CSS
  `background-image`:** loaded synchronously and cached for good. Both
  checked in the GNOME Shell 50 sources.
- **Placeholder:** the player's app icon (or a note) on a faint square.
  When a web cover was not fetched, its tooltip says "Cover art from the
  internet is off (Settings → Media)".
- **Gaps:** on a new song the old cover stays until the new one loads, at
  most 1.5 s; another source drops it at once.
- **Tint:** the cover reduced to 16 × 16, its colour averaged (weighted by
  alpha) and stretched; covers with no real colour (dark, or grey) get
  none: white accent, no halo.
- Rounded corners are painted: Clutter has no rounded clip, so a mask
  paints the corners in the colour behind the tile (black in the tab, the
  pill's colour on the pill).

## In the island (wings, peek, swipe)

```
( [art] [pad] 14:35 [•] [▁▃▂] )      while a song plays
( [art]  Title · Artist      )        a new song, 3 s
```

- **Wings:** while a song plays, the island is collapsed and on screen
  (not over a fullscreen window) and "Show music while playing" is on:
  the cover left of the time, three moving bars right of it. The time
  stays centered (the wings are equally wide). The pill grows only if the
  time and the wings need more room than it has, so it keeps covering
  GNOME's clock. They fade in after the pill has grown, and out before it
  shrinks back (paused, stopped, or the player gone).
- **New song:** with "New song" on, the title and artist replace the time
  for 3 s (at most 360 px wide). Quick skips give one notice, for the
  last song, 0.5 s after the skipping stops. Expanding the island, the
  song stopping or another notice ends it.
- **A click (or hover-open) on the pill while it shows music opens the
  Media tab** ("Open the Media tab from the island"). The shortcut and
  Ctrl+Alt+Tab keep the last tab.
- **Swipe to change song:** two fingers left (next) or right (previous) on
  the touchpad, over the pill's music or the tab's player row; once per
  swipe (40 px). Only touchpad finger scrolls without modifier keys count;
  the direction is the fingers' own, with natural and with traditional
  scrolling. **Not verified on a real touchpad** (only with GNOME's
  virtual input in the headless tests).
- **Bars** move only while a song plays, "Moving bars" is on, GNOME's
  Animations switch is on, and they are on screen. The motion is
  Clutter's own (no JavaScript per frame), but GNOME redraws their small
  area every frame while they move. The power cost was not measured.
- Accessible name of the pill: "14:35, playing “Title” by Artist";
  during a notice "14:35, Now playing: Title, Artist".

## Lyrics

Only while the Lyrics panel is open; closing it cancels any request.

1. The player's own `xesam:asText`: timed if it is LRC, else plain text.
2. A `.lrc` file next to a local song (`file://` `xesam:url`, same name,
   at most 128 KiB).
3. **lrclib.net**, only with "Find lyrics online" on: `GET
   https://lrclib.net/api/get?track_name=…&artist_name=…&album_name=…&duration=…`.
   Needs a title, an artist and an album (" - Single" and " - EP" are
   dropped from the album) and a length of 1 s to 1 h; no redirect,
   at most 128 KiB. Only an exact match (title, artist and album ignoring
   case, length within 2 s) is shown.

- **States:** "Sends the song's title, artist, album and length to
  lrclib.net." with a "Find lyrics online" switch (online off and nothing
  local); "Loading lyrics…"; "No matching lyrics for this recording.";
  "Could not load the lyrics." with "Try again".
- **LRC:** `[mm:ss.xx]` tags (repeated tags allowed), `[offset:±ms]` up to
  60 s, at most 2000 lines and 128 KiB once expanded; an empty timed line
  is a pause, shown as "♪". Text without timing is shown as plain text,
  never given made-up timing.
- **Display:** the current line large and white, the others dim; the
  current one is kept in the middle. "Waiting for the first verse" before
  the first line; without a position, plain text and "The player does
  not share its position."
- **Timing:** "Earlier", the offset (click: reset), "Later", 0.25 s steps,
  ±10 s.
- One wake-up at the next line's time, none while paused.
- Kept in memory for one song: hiding the panel keeps them, another song
  clears them.

## Up next

- Only for players with an MPRIS TrackList (`HasTrackList`); few have
  one, so "This player does not share its upcoming songs." (with "Open
  player") is the common case.
- Up to 20 songs after the current one, numbered from 1, each with "Play
  now" (`GoTo`) when the player can be controlled. It counts only once
  the player's current song is that one, within 1.5 s; otherwise "The
  player did not switch to this song."
- Lists with repeated or invalid ids, or without the current song, are
  not shown. The TrackList's signals are followed only while the panel is
  open, through one subscription removed when it closes.

## Panic button

"Pause all media" (Settings → Panic buttons; not in the bar by default):

- A click pauses every player that is playing (no song check: the intent
  is "everything") and the button turns red.
- A second click plays again the ones it paused, if they are still there
  and still paused.
- It stays red only while some of those are still paused; one that plays
  again, exits, or did not pause within 1.5 s drops out.
- Insensitive while there is no player and nothing to resume.
- What it paused is kept on the button: a screen lock forgets it.

## Settings

Settings → Media:

| Key | Default | |
|---|---|---|
| `media-enabled` | `true` | Show the Media tab. Needs no packages: it only reads the session bus |
| `media-width` / `media-height` | 480 / 248 | Logical px while the tab is shown; extras add 224 |
| `media-show-in-pill` | `true` | Cover and bars beside the time while music plays |
| `media-track-notice` | `true` | A new song's title on the pill for 3 s |
| `media-pill-opens-tab` | `true` | A click or hover-open on the pill with music opens the tab |
| `media-animate-bars` | `true` | Moving bars (GNOME redraws them every frame) |
| `media-gestures` | `true` | Touchpad swipes change song |
| `media-include-other-players` | `true` | Follow browsers and video players automatically |
| `media-remote-art` | **`false`** | Cover art from the internet |
| `media-lyrics` | `true` | The Lyrics button |
| `media-lyrics-online` | **`false`** | Find lyrics online (lrclib.net) |
| `media-queue` | `true` | The Up next button |

No key stores the chosen player.

## Network and privacy

- **Nothing leaves the computer by default.** Two options use the
  internet, both off by default and declared in the extension's
  description:
  - "Cover art from the internet": a cover a player gives as a web
    address is downloaded from that address (the player chose it: often
    a music service's image server). Up to 4 MiB, `image/*` only; up to 8
    recent ones kept in memory.
  - "Find lyrics online": lrclib.net receives the song's title, artist,
    album and length.
- One `Soup.Session`, made on the first such request and never otherwise:
  no cookies, no cache on disk, a 10 s timeout, User-Agent
  `Froonty/<version>`. Turning an option off aborts its requests and drops
  web covers. Requests run only while the cover or the lyrics are shown.
- Commands, metadata and covers stay between the player, GNOME Shell and
  the session bus.

## Code

| File | |
|---|---|
| `features/media/model.js` | Pure rules: decoding and caps, identity, position, seek plan, play/pause, time format, music apps, the automatic choice, mirrors, names, tint, new-song detection, swipes |
| `features/media/lyrics.js` | LRC parser, current line, wake-ups, lrclib rules, sidecar path, TrackList decoding |
| `features/media/mpris.js` | `MprisWatcher`, `MprisPlayer`: async proxies on unique names, no interface info |
| `features/media/service.js` | `MediaService`: sources, choice, smoothing, position, commands, art, pause all |
| `features/media/shared.js` | One service per Shell, reference-counted |
| `features/media/apps.js` | Shell adapter: app by DesktopEntry or process id, activate |
| `features/media/art.js`, `fetch.js` | Cover loading; the opt-in web session |
| `features/media/lyricsService.js`, `queue.js` | Lyrics sources; TrackList client |
| `features/media/view.js`, `artFrame.js`, `bars.js`, `volume.js`, `extrasView.js` | The tab |
| `features/media/pill.js`, `gesture.js` | Music on the collapsed pill; swipes |
| `features/media/prefs.js` | Settings → Media |
| `panic/pauseMedia.js` | "Pause all media" |

**Not GNOME Shell's `ui/mpris.js`:** its `MprisPlayer` has no teardown (no
`destroy()`, the `NameOwnerChanged` handler is never removed), exposes no
position, seeking, rate, length or album, replaces missing data with
"Unknown title" and "Unknown artist", and its API changed in Shell 48 and
50. Only its ideas are reused: type checks, the app lookup by
DesktopEntry, and `app.activate()` before `Raise`.

Generic hooks outside `features/media/` (any feature may use them):

- `ctx.memory` (plain data kept across screen locks, from `extension.js`)
  and `ctx.collapse()`.
- A **pill accessory**: the first feature whose `wantsPillAccessory()` is
  true gets wings on the collapsed pill (`createPillAccessory`, rebuilt
  when its `pillAccessoryKeys` change); a pointer open selects its
  `tabId`; scrolls on the collapsed pill go to its `handleScroll()`.
- Views may emit `'size-changed'` and report `extraHeight` (the island
  grows by it) and `handleEscape()` (Escape closes something of the view
  first; the island's `captured-event` handler runs before GrabHelper's).

**Teardown:** `releaseMedia()` → `MprisWatcher.stop()` unsubscribes from
`NameOwnerChanged`, cancels every call and drops every player; each
player disconnects its proxy handlers. The proxies' own match rules on
the bus go when GJS frees them (GDBusProxy removes them in finalize), as
with GNOME Shell's own media card.

## Tests

- `make unit`: `media-model.test.js` (M1-M34: decoding, choice, mirrors,
  names, smoothing on a fake clock, tint, new songs, swipes, texts),
  `media-lyrics.test.js` (L1-L13), and `media-mpris.test.js` (D1-D17)
  against fake players on a **private dbus-daemon** started by the test.
- `make test` (both session modes): fake players run as processes on the
  test Shell's private session bus (`tools/headless-test/fake-mpris.js`,
  with test-only `.desktop` files for a music player and a browser).
  Checked: the tab and its idle state, title, artist, cover (pixels),
  halo and accent; play/pause by pointer and Space; next and previous;
  `CanGoNext`; slider drags (`SetPosition`, `Seek`); the elapsed time
  and the tick; reading the position on show; `Seeked`; a failed
  command; a restarted player; two players, the source list by pointer
  and keyboard, Automatic, Escape; the automatic choice; a gap; sizes and
  extras; the pill's wings, centered time, width and clock cover; the
  accessible name; a new song's notice and its debounce; click to open
  the tab; swipes; bars with animations off and over fullscreen; web
  covers off and on; Up next and "Play now"; lyrics from the player,
  their timing, and lrclib (against a local fake, never the internet);
  the volume row; "Pause all media"; 25 enable/disable cycles with music
  playing; the choice across a lock; turning the tab off live; no web
  session with the default settings.
- GNOME Shell turns its animations off when it renders in software, as
  the headless test Shell does (`main.js`, `_shouldEnableAnimations`).
  The check of the moving bars lifts that for itself and puts it back;
  the other checks run with animations off.
- Three layout facts the checks caught: Clutter tells a parent it is
  mapped before it maps the children (so the bars start from their last
  child's `notify::mapped`, or their eases would be skipped); an actor
  whose relayout is pending reports its natural height (so the player is
  sized from the last allocation, which does not change, and sends no
  `notify::allocation`, when the player is shown again); and children
  that expand make their parents expand unless those say otherwise (so
  the cover tile sets `x_expand: false`, or it stretches in its row).

## Limits

- **Not verified with real players yet** in this iteration: the manual
  pass (Brave with the Apple Music web app, Firefox snap with YouTube,
  the VLC deb, pause-all) is still to do; findings go here.
- Swipe direction on a real touchpad, with natural and traditional
  scrolling: to verify.
- Which real players carry the `Audio` or `Music` category, and the bus
  names of mpd, spotifyd, ncspot and cmus: to verify.
- Spotify: a position stuck at 0, missing `Seeked` and web covers are
  community reports, not verified.
- Brave: its Identity, and whether the process id finds Brave or the web
  app: to verify.
- Snap and Flatpak players may keep their covers in a private `/tmp`
  that GNOME Shell cannot read: the placeholder (with the app's icon)
  shows. Not verified.
- GNOME's lock screen shows its own media card for players that allow it
  (read in `unlockDialog.js`, not seen); Froonty shows nothing there.
- No shuffle, repeat, rating, stop or per-player volume. The volume row
  is GNOME's output volume (100% at most), with no device menu: Quick
  Settings has one.
- The rounded corners are painted in the colour behind the cover; the
  pill's own hover colour change (150 ms) can briefly show a slightly
  different corner shade.
- The title is one line (St labels have no line limit); the whole title
  is in its tooltip.
- Lyrics from a file chooser (as vorssaint-utils offers) are not offered:
  GNOME Shell has no file chooser of its own.

## Credit

Design adapted from vorssaint-utils (GPL-3.0-or-later).
