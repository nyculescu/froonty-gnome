# Changelog

## 0.9.0-rc0 (2026-10-05)

First release candidate of 0.9.0, for GNOME Shell 50 on Ubuntu 26.04
(Wayland). It builds on 0.8.0-rc0. The published package (extensions.
gnome.org) gains Stop/Start Froonty in Settings → General; otherwise it
offers the same: the Notes tab, the date pill and the panic buttons.
`make install` builds add Froonty to Show Apps and rework the Writing tab
(an English editor in B2 and C1, Translate, Humanize), which stays
working-tree only.

### Added
- **Stop Froonty and start it again** (Settings → General), for a
  computer that needs all its power. Stopped, nothing of Froonty runs: no
  island, no clipboard history, break tracking or Claude usage, no
  Super+V; only the top bar icon that starts it again (as do the shortcut
  and the same button). A screen lock keeps it stopped; the next login
  follows "Start at login". New key `running`.
- **Froonty in Show Apps** (local installs: `make install` adds
  `~/.local/share/applications/froonty.desktop`, `make uninstall` removes
  it). It opens Froonty's settings; right-click it for Start Froonty and
  Stop Froonty.

### Changed
- **Writing: Fix grammar is now an English editor, in two versions**
  (working-tree only). The models are told the writer thinks in their
  first language (Settings → Writing, Romanian by default) and writes in
  English, and give a B2 version (a light edit, in the writer's own words)
  and a C1 one (a fluent rewrite, same tone, plain words), each with its
  own Copy; one that comes out the same is shown once. The other rewrites
  keep to plain B2-C1 wording. Prompts tested against three local models
  (docs/features/writing.md §3).
- **Writing: Summarise and Paraphrase are gone.** On a short text
  Summarise gave no summary, and Shorten does that job; Fix grammar's C1
  and Humanize cover Paraphrase.
- **Writing: Humanize replaces Casual.** It says what the text says in
  words a real person would use: no buzzwords, no filler, same meaning and
  formality.
- **Writing: a text that asks for something is reworded, not answered.**
  Casual answered "help me get new ideas…" with ideas, and small models
  wrote the e-mail "write me an e-mail…" asked for. The models are now
  told the text is the writer's message to someone else, and the text and
  their reply are JSON; a reply that still looks like an answer is asked
  for once more, strictly, and then shown with a warning.
- **Writing keeps the writer's directness.** No added "really",
  "absolutely", "Could you please" or small talk, in rewrites and in
  translations ("vreau" is "I want"). Shorten must cut to about half the
  words, and is asked once more when it does not. A reply is capped at
  about four times the text, and a runaway one (gemma3:4b's `”} 0} 0}…`)
  is cut where it went wrong.
- **Writing: your politeness, as you wrote it.** B2 keeps it exactly
  ("te rog" is "please" in a translation); C1 may make a request slightly
  more courteous, implicitly ("Could you help me…"), never more.
- **Writing: tooltips** on the tab's buttons and in Settings → Writing say
  what each action does and which models did best (qwen3:4b-instruct as
  Model, gemma3:4b for Translate). Froonty's tooltips can now wrap and sit
  above their button.

### Added
- **Writing: Another option** asks again for other wording than the
  versions so far (they go along, to be avoided).
- **Writing: Translate**, from and to languages chosen in the tab and
  kept (Romanian to English by default), with the text's idioms: each one,
  its natural equivalent, what it means, and an example. Claude Code and
  Ollama; Ollama can use a model of its own for it (Settings → Writing).

### Fixed
- **Writing with a thinking model (qwen3:4b) showed its reasoning** before
  the result. Ollama is now asked to let such a model think apart, and
  reasoning left in a reply is dropped. Settings now suggests
  qwen3:4b-instruct-2507-q4_K_M: it answers in under a second where
  qwen3:4b thinks for 30 s or more.
- **Writing: the result could not be selected with the keyboard**, and a
  selection dragged past its bottom edge did not scroll. Arrows,
  Home/End, Page Up/Down, with Shift and Ctrl, Ctrl+A and Ctrl+C now work
  there, and the result follows the selection.

## 0.8.0-rc0 (2026-10-05)

First release candidate of 0.8.0, for GNOME Shell 50 on Ubuntu 26.04
(Wayland). It builds on 0.7.0-rc0. The published package (extensions.
gnome.org) is unchanged in what it offers: the Notes tab, the date pill
and the panic buttons. `make install` builds add the Clipboard tab's
Super+V switcher and formulas drawn in notes; Media, Claude, Btop,
Clipboard, Kill Process, Break and Formulas follow on extensions.gnome.org
in later versions; ZeroTier and Writing stay working-tree only.

### Added
- **Clipboard switcher** (the Clipboard tab, local builds; Settings →
  Clipboard → Switcher, on while the tab is on). Super+V shows the newest
  history entry in a small pop-up by the text cursor; with Super held,
  each further V steps to an older entry and Shift+V back to a newer one;
  releasing Super inserts the shown entry where you were typing, Escape
  cancels. Text, images and copied files; hidden passwords show as dots.
  Text goes into a text field through GNOME's input method and leaves the
  clipboard alone; anything else (and text in terminals or apps without a
  text field the input method knows) goes on the clipboard and is pasted
  with Ctrl+V, Ctrl+Shift+V in terminals. The shortcut can be changed.
- **Formulas in notes** (local builds; the published Notes tab is
  unchanged). In the island's Notes tab and the All notes window, `$…$`
  and `$$…$$` show as math drawn by MathJax on the lines without the
  cursor, as in Obsidian's live preview; the line being edited shows the
  LaTeX, its dollars dimmed. `$$…$$` alone on its lines is centred on a line of its own. Dollars
  follow Pandoc's rules, so `$5 and $10` stays text, `\$` is a dollar and
  code is left alone. A formula MathJax refuses keeps its source,
  underlined (with MathJax's message as a tooltip in the window). The
  files stay plain Markdown, byte for byte; undo and the formatting bar
  work on the plain text. The Formulas tab and the notes share one
  renderer process.

### Fixed
- **Inline formulas were cut after their first piece** (the Formulas tab
  with Display off, and copies of its picture): MathJax 4 split
  `E=mc^2` at `=` and only `E` was drawn. Inline formulas are now one
  picture.

### Changed
- **GNOME's notification list opens with Super+M** while the switcher is
  on: GNOME's `toggle-message-tray` loses Super+V and gets Super+M. The
  previous value is remembered and comes back when the switcher or the
  Clipboard tab is turned off; screen locks leave it alone.

## 0.7.0-rc0 (2026-10-04)

First release candidate of 0.7.0, for GNOME Shell 50 on Ubuntu 26.04
(Wayland). It builds on 0.6.0-rc0. The published package (extensions.
gnome.org) keeps the Notes tab, with the new header: the date pill over
GNOME's clock, up to 8 panic buttons around it, and ⚙️ in the tab
column. `make install` builds add the Formulas tab and the CPU load
panic button; Media, Claude, Btop, Clipboard, Kill Process, Break and
Formulas follow on extensions.gnome.org in later versions; ZeroTier and
Writing stay working-tree only.

### Added
- **CPU load panic button** (Settings → Panic buttons, local builds): the
  processor's load, large, over a faint processor chip, as the Claude
  session button shows its number, coloured green to red as the Btop
  tab's levels. It reads only while the island is open; a click opens the
  Btop tab.
- **The Formulas tab** (working-tree installs only; `make pack` leaves it
  out, with MathJax). Write LaTeX with a preview drawn as you type, and
  MathJax's message ("Missing close brace") when it cannot read the
  formula; symbol palettes searchable by name (`alpha`, `approx`, `≈`),
  with each symbol's glyph and its LaTeX in a tooltip; templates
  (fraction, root, sum, integral, limit, derivative, matrix, cases,
  aligned equations…) that leave the cursor in their first slot; recent
  and starred formulas; a short guide. Copy as `$…$`, `$$…$$` or raw, or
  put `$…$` at the open note's cursor. MathJax 4 runs in a separate `gjs`
  helper process, started with the first preview and stopped after a
  minute idle or when Froonty is disabled; the Shell never waits for it.
  `make install` fetches MathJax once (`make mathjax`): official npm
  packages, pinned and sha512-checked, into a git-ignored folder; nothing
  is fetched at runtime. Settings → Formulas: the tab, display style,
  whether MathJax is installed, Clear recent, size.

### Changed
- **Up to 8 panic buttons** (was 5), Settings → Panic buttons: half on
  each side of the hub header's date pill, the right side one more when
  the count is odd (3 → 1 + 2). Both sides are equally wide: the side
  with fewer or narrower buttons spreads them apart. The settings page
  refuses a 9th.
- **The date pill sits exactly over GNOME's clock** (concealed under the
  island), with the panic buttons on its two sides; it never moves off
  it: an island without room for both sides grows wider. Without GNOME's
  date menu (no pill)
  the panic buttons are centred as one group. The open tab's own header
  buttons (Notes' All notes) sit at the header's right end.
- **⚙️ moved to the bottom of the tab column**, below the tabs, with a
  tab's size and its name in a tooltip on its right. It is there with one
  tab or none on as well. Keyboard order: the tabs, ⚙️, the panic buttons
  and the date pill from left to right, the tab's own buttons, the tab.

## 0.6.0-rc0 (2026-10-04)

First release candidate of 0.6.0, for GNOME Shell 50 on Ubuntu 26.04
(Wayland). It builds on 0.5.0-rc0. The Notifications and Calendar tabs
are gone, so the published package (extensions.gnome.org) now has the
Notes tab only, with the date pill and the mute panic buttons. `make
install` builds keep every other tab: Media, Claude, Btop, Clipboard,
Kill Process and Break follow on extensions.gnome.org in later versions;
ZeroTier and Writing stay working-tree only.

### Removed
- **The Notifications and Calendar tabs** (the date pill opens GNOME's
  own calendar and notifications). A click on the date pill in the hub
  header, or GNOME's own Super+V, shows GNOME's notification list (with
  Do Not Disturb and Clear) and its calendar with the events of the
  calendars GNOME knows, so the two tabs were duplicates. The island now
  opens on the Notes tab; one that last showed Calendar or Notifications
  opens on the first tab that is on. Their settings (`calendar-*`,
  `notifications-*`) are gone, and so is the Calendar tab's need for
  `gir1.2-ecal-2.0`. The published package now has the Notes tab only,
  with the date pill and the mute panic buttons. GNOME's unread dot
  stays on the collapsed pill and on the date pill.

### Added
- **Media: pause the other players when one starts playing** (Settings →
  Media, on by default): one plays at a time. Between apps only; a
  browser reports all its tabs as one player.
- **Media: bringing up a player's window shows that player** on the pill
  and in the tab, until another player starts playing; a player picked by
  hand still comes first.
- **The formatting bar in the All notes window.** The note pane has the
  island's bar: Bold, Italic, Strikethrough, Heading, Bulleted list,
  Numbered list, Checklist, Code, Link and Wrap lines, in the same order
  and with the same edits. Toggles light up for the formatting at the
  cursor or selection; an edit is one undo step (Ctrl+Z) and saves like
  typing. Wrap lines and the fold button are the island's settings, so
  both editors look alike (the window used to wrap always). Read-only
  notes leave the formatting buttons insensitive.
- **The All notes window draws notes rendered**, as the island does:
  headings, bold, italic, strikethrough, code, links, quotes and done
  items formatted; the line with the cursor shows its Markdown markers,
  dimmed, and the other lines hide theirs. The file stays plain Markdown.

### Changed
- Media: anything that plays comes before anything paused in the
  automatic choice. Pausing a music player while a browser still plays
  now shows the browser, not the paused player.

### Fixed
- Settings opened again right after its window closed: the request no
  longer fails while GNOME's preferences service is still leaving (it
  keeps its name a moment without its object, or exits without
  replying); Froonty retries briefly.

## 0.5.0-rc0 (2026-10-03)

First release candidate of 0.5.0, for GNOME Shell 50 on Ubuntu 26.04
(Wayland). It builds on 0.4.0-rc0. The published package (extensions.
gnome.org) now has the first submission's tabs only: Calendar,
Notifications and Notes, with the date pill and the mute panic buttons.
`make install` builds keep every tab: Media, Claude, Btop, Clipboard, Kill
Process and Break follow on extensions.gnome.org in later versions;
ZeroTier and Writing stay working-tree only.

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
- **Calendar tab**, the first tab: the events of every calendar GNOME
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
  - The tab carries GNOME's unread dot, as the pill and the date pill
    do. Opening the island on purpose with this tab on screen (a click,
    the keyboard, the shortcut), or pressing, typing or scrolling in it,
    marks what it lists as seen, as GNOME's list does, except one still
    waiting for its banner, which shows when the island closes. Opening it
    by hover alone does not, and neither do a modifier key alone, key
    repeats, a key while the focus is still on the pill after a hover-open
    (Tab moves it in), or a scroll outside the list after a hover-open.
  - A Do Not Disturb toggle, bound to GNOME's own switch.
  - Nothing is watched while the tab is not on screen, and nothing is
    ever removed without a click. Settings → Notifications: show the
    tab, and its size (400 × 440 by default).
- **Notes: All notes window.** On the Notes tab, a button between the date
  pill and ⚙️ in the island's top row (tinted with a faint wash of the open note's
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
- **Writing tab** (working-tree installs only, off by default; `make pack`
  leaves it out). Paraphrase, Fix grammar, Shorten, Formal, Casual and
  Summarise, on text you type or paste, or the Clipboard tab's current
  entry (never a hidden password). The result is plain text; Copy puts it
  on the clipboard. Text is sent only on a click, and the line above the
  box always says where it goes. No paid API keys.
  - **Engines**, each switched on in Settings → Writing (one switched off
    is not in the tab at all): your own **Claude Code** on your Claude
    plan, with every tool, MCP server, skill, hook and settings file off
    and API-billing sign-ins refused; **LanguageTool**'s free public
    service, grammar and spelling only, at most 10 texts a minute;
    **Ollama** on this computer. While a request runs, the engine cannot
    be switched (the line above the box keeps naming where the text went),
    and switching its engine off in Settings stops it.
  - **Why an engine is not ready:** Claude Code not found; LanguageTool
    offline; Ollama not installed, not running (with the right way to
    start yours: `systemctl` only when it has a system service, else
    `ollama serve`), no model chosen, or model not downloaded. Checked
    again when the tab is shown, a setting changes, or the network comes
    back while it is shown.
  - **Passwords:** text that holds the password the Clipboard tab is
    hiding (compared in memory; also when pasted with Ctrl+V or a middle
    click: a passphrase, a long API key, a hex token), or that looks like
    a password or key, never goes to Claude Code or LanguageTool.
  - **Long texts:** time limits grow with the text (Claude Code 90 s plus
    8-15 ms per character, Ollama 3 min plus 60 ms per character); the
    busy line says when a long text can take minutes; Ollama's reply
    shows as it is written, and Cancel or a timeout keeps what came. The
    text box scrolls with the caret, and typing in it leaves the result,
    and a selection in it, alone.
  - **Fixed addresses:** LanguageTool's public service and Ollama on
    127.0.0.1. The variables that move them are read only under the
    tests, so a stale one cannot send text elsewhere.
  - **Settings → Writing:** each engine's status, how to set it up by
    hand, **Set up…** for Ollama (Ollama's official archive from GitHub,
    SHA-256 checked, installed for you only, a user service on 127.0.0.1,
    no administrator password), **Download model…**, **Remove…**, and
    **Remove everything Froonty set up for Writing…**, which undoes all of
    it after listing it. Ollama's **Model** list reads "Choose a model"
    until one is picked, and picking one, even the only one, saves it.
    LanguageTool's wait message names the limit that applies (10 texts or
    60 KB a minute). See
    [docs/features/writing.md](docs/features/writing.md).
- **`make pack` leak guard.** The public build is checked for any trace of
  the working-tree-only tabs (files, settings keys, CSS, addresses); the
  zip is deleted and the build fails if one is found. Their CSS now sits
  between `local:begin`/`local:end` markers.
- **Break tab** (off by default; turn it on in Settings → Break). GNOME's
  own break reminders (Settings → Wellbeing), shown and driven from the
  island; GNOME keeps the timing. Not medical advice.
  - GNOME's breaks are off until you choose: the tab offers "Turn on eye
    and movement breaks" (every 20 min for 20 s, every 30 min for 5 min by
    default), and Settings → Break shows all of GNOME's break settings.
  - **A cue on the collapsed pill** when a break is near, due, overdue or
    urgent (levels 0-4, each with its own shape; "Icon and minutes"
    adds the minutes), or when it is time to stand up or sit down. The
    island never opens by itself; a click on the pill opens the tab.
  - **Reminders in the island instead of GNOME's notifications** (on by
    default): GNOME's Wellbeing notifications are off while the island is
    shown (this also hides GNOME's daily screen-time limit alerts), kept
    off under the lock screen, and turned back on exactly as they were
    when the tab, the island or Froonty is turned off.
  - **Take, Delay and Skip**, only when GNOME can act on them; urgency
    that rises after skips and delays, and a long rest after 2 h at the
    screen (Froonty's rules, labelled as such); a suggested length.
  - **Exercise cards** with Workrave's pictures and texts
    (GPL-3.0-or-later, credited): a stretch when a movement break is near,
    the 20-20-20 line and eye exercises ("comfort only") when an eye break
    is due.
  - **Sit/stand tracker** for a desk with a manual lever: a
    Sitting/Standing switch and a "Sitting or standing" panic button;
    standing counted only while you use the computer; 2 h a day as the
    minimum, an optional build-up (+15 min after meeting it on 4 of 5
    days, at most weekly, up to 4 h; switch it off, or "Just the minimum
    today"); a reminder to switch, none to stand once the target is met.
  - **Today's totals and a history** (98 days), on this computer only, in
    `~/.local/share/froonty/break` (readable by you only), with "Forget
    history…". Only when you were at the computer or away, and daily
    totals, are recorded.
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
  - **The date pill** in the open island, left of ⚙️ (or Tab to it,
    Enter or Space), opens GNOME's own menu under the pill; the island
    closes (it was a 📅 button first; see Changed). GNOME's `Super+V`
    works too, also while the island is open. Escape closes the menu.
  - **Unread dot:** while GNOME's clock would show its dot, the pill
    shows it after the time, and so does the date pill. GNOME's rules decide
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
  - Never offered: GNOME Shell, whatever started it, the session's
    programs (gnome-session, gdm's session wrapper, systemd --user,
    Xwayland, D-Bus, PipeWire and WirePlumber, the keyring), and the
    desktop services that nothing starts again once asked to quit, so
    their job would stay undone until the next login: GNOME's settings
    daemon (every `gsd-*` process: power, media keys, Night Light, …),
    IBus (`ibus-daemon`, `ibus-x11`: input methods), the accessibility bus
    (`at-spi-bus-launcher`, `at-spi2-registryd`) and `mutter-x11-frames`
    (X11 windows' title bars). Services that come back when next needed
    (portals, Evolution's, Online Accounts, GVfs, the file indexer) and
    apps can be killed. Other users' processes are not listed; Froonty
    never asks for administrator rights.
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
- **Resize the island live.** An arc in the open island's bottom-right
  corner, on tabs whose size Settings → Size sets: drag it and the island
  follows the pointer, centred (the width changes on both sides, the height
  downward), within the keys' range, the screen's work area and what the
  tabs and the panic bar need. The size is saved on release, per tab, and
  Settings shows it; a double-click goes back to the tab's default size.
  "Drag to resize, double-click to reset" on hover; with the key focus on
  it, the arrow keys resize in steps of 10 px (Shift: 50), and Escape
  cancels a drag.

### Changed
- **The hub header's 📅 button is now a date-and-time pill:** "Sat Oct 3
  14:05", the date as GNOME's top bar clock writes it in your language,
  the time in Froonty's 12/24-hour setting (always with the date; "Show
  date when collapsed" stays the collapsed pill's), with GNOME's unread
  dot after the time, and the collapsed pill's look. A click, a touch,
  Enter or Space closes the island and opens GNOME's own calendar and
  notification menu, as a click on the clock under the pill would. Screen
  readers hear "Calendar and notifications" and the full date. It follows
  the top bar clock's ticks, with no timer of its own. The pill is wider
  than 📅 was; on a tab too narrow to centre the panic bar beside it, the
  panic bar moves left to keep clear of it, and each tab keeps the width
  set in Settings.
- **Every tab can be turned off.** With none on, the island still opens:
  its top row (the date pill, the panic buttons, ⚙️) and "No tabs are
  on", with a button to Settings. Settings → Appearance → Expanded width
  and height are now the island's size for that case (each tab has its
  own).
- **The published package has the first submission's tabs only:**
  Calendar, Notifications and Notes, with the mute panic buttons. Media,
  Claude, Btop, Clipboard, Kill Process and Break are in `make install`
  builds and follow on extensions.gnome.org in later versions; ZeroTier
  and Writing stay working-tree only. `make pack` keeps only the code the
  published tabs reach, their settings and styles, and a description of
  what the package has, and ships `LICENSE`.
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
- The panic bar never overlaps the top row's buttons: it is centred on
  the island where there is room, moves left where there is not, and the
  island grows only when the bar does not fit between the tabs and those
  buttons at all.

### Removed
- **The Clock tab.** The time and the date are in the island itself: on
  the collapsed pill, and on the date pill in the hub header. The island
  opened on the Clock tab last opens on the first tab that is on
  (Calendar by default).

### Fixed
- Notes: Bold (and Italic, Strikethrough, Code) on a selection of several
  lines wraps each line on its own, so every line shows bold; it used to
  put one pair of markers around the whole selection, which Froonty did
  not render. Bold, italic and struck text written over a line break
  inside a paragraph (`**line 1` then `line 2**`) now shows formatted, as
  in other Markdown apps.
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
