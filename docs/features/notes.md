# Feature: Notes

Status: **implemented (v1)**. Decisions made 2026-09-28:

- v1 includes a Markdown **formatting bar**: bold, italic, strikethrough,
  heading, bulleted, numbered and check lists, code, and link. There is no
  rendered preview yet.
- New notes are named **`dd.mm.yy hh.mm`**, e.g. `28.09.26 16.03`. It uses
  `.`, not `:`, which is invalid on exFAT/NTFS. A second note in the same
  minute gets ` (2)`. These names do not sort chronologically, so tabs keep
  **creation order** instead.
- There is **no cap** on the number of notes. Each tab is **as wide as
  its name**, so "as" gives a small tab. Names longer than **14
  characters** (a full `dd.mm.yy hh.mm` is exactly 14) are shortened to 13
  plus "…", and shown whole in a small note-style bubble while hovered.
- The row scrolls with the wheel or touchpad, shows an edge fade, and keeps
  the selected tab in view. "+" stays outside the scrolling row.
- The Notes island is **428×319** by default. Settings → Notes → Size
  changes its width and height (`notes-width`, `notes-height`; applies
  live), and **Default size** goes back to 428×319. The descriptor names
  the keys (`hubSizeKeys`) instead of a fixed `hubSize`.
- **Renaming** (double-click) swaps the tab's content for an entry of a
  fixed width (10em). It used to expand into the row's spare width, which
  an overflowing row does not have: the entry shrank to a sliver.
- **Middle-click** on a tab moves that note to the Trash at once, like
  closing a browser tab (it can be restored from the Trash).
- A **Wrap lines** toggle at the end of the formatting bar (one setting for
  all notes, `notes-wrap`, on by default). When it is off, lines stay on one
  line and the note scrolls horizontally; the view follows the cursor both
  ways.
- Each note has a **colour**, like Windows Sticky Notes: yellow (default),
  green, pink, purple, blue, gray or charcoal. It tints the editor, the
  round colour button that chooses it, and the All notes button in the hub
  header. Tabs show no colour dot (2026-10-02, user request: "No reason to
  have it and diminish the space").
- **Order and colours** are kept in a hidden `.froonty.json` in the notes
  folder, so the `.md` files stay plain Markdown. A note restored from the
  Trash comes back yellow.
- A **fold button** after "+" hides the whole tools row (formatting bar,
  wrap, colour) to give the note more height. It shows ⤴ while the row is
  open and ⤵ while it is folded, and is remembered (`notes-show-tools`, on
  by default). The arrows are bundled symbolic icons (`icons/`): the
  Unicode ⤴ ⤵ need a fallback font whose line height made the tab row
  11 px taller.
- **Formatting toggles show their state** at the cursor or selection:
  lit in accent blue = on (a click removes it), plain = off (a click adds
  it). Link is an action, not a toggle. Wrap uses the same look. A bare
  cursor inside `**hi**` counts as bold, and Bold then unwraps the span
  instead of inserting `****`. Markers pair left to right within one line.
  Over a selection of several lines, Bold, Italic, Strikethrough and Code
  wrap each line's text on its own (`**line 1**`, `**line 2**`), skipping
  blank lines and the spaces around a line; on lines all wrapped already
  they unwrap them. A Markdown span cannot hold a blank line, and per line
  it reads the same in every Markdown app.

**Rendered Markdown** (second iteration, 2026-10-02, user request: "render
Markdown so that I can use the edit buttons"):

- **What shows.** The editor draws the note formatted while it stays plain
  Markdown in its file, as in Obsidian's live preview.
  - Headings are bold and larger (`#`, `##`, `###`).
  - `**bold**` is bold, `_italic_`/`*italic*` is italic, and `~~struck~~`
    is struck through, also over a line break inside a paragraph
    (`**line 1` then `line 2**`), as in CommonMark; a blank line, a
    heading, a list item, a quote or a code block ends the paragraph.
  - `` `code` `` and fenced blocks are monospace, code spans on a light
    grey background.
  - Links show their label underlined.
  - `> quotes` are italic and muted.
  - Ticked checklist items (`- [x]`) are struck through and muted.
- **Markers** (`**`, `_`, `~~`, `` ` ``, `# `, `[`, `](url)`) are hidden
  except on the line holding the cursor. There they show muted, so they
  can be edited. Without the key focus, all of them are hidden. List
  bullets, numbers, checkboxes and code fences always show, muted.
- **How:** `render.js` (pure, unit-tested) finds the spans. `styler.js`
  turns them into Pango attributes on the editable `Clutter.Text`, with
  byte offsets. It restyles on each edit, when the cursor changes line,
  and on focus changes. Clutter does honour attributes while editable
  (checked in the headless Shell).
- **Why markers shrink instead of disappearing.** Pango has no "invisible"
  attribute and Clutter ignores Pango's foreground alpha. So hidden markers
  are drawn at 5% size in the muted colour. Every character stays in place,
  so cursor positions and the formatting bar's edits are those of the plain
  text.
- **Muted colour.** It comes from the editor's CSS
  (`-froonty-markdown-muted`, read from St's theme node), so it follows the
  note's colour: grey on the pastels, lighter on charcoal.
- **Not yet:** clicking a checkbox to tick it, and images.

## Formulas (2026-10-05, working-tree builds only)

Agreed with the user on 2026-10-03: the notes hold formulas for a PhD, and
`$…$` and `$$…$$` should show as rendered math in both editors, as in
Obsidian's live preview. Local builds only (MathJax is there already, for
the Formulas tab); the published Notes tab is unchanged.

### What shows

- **Off the edited line, a formula is a picture**, drawn by MathJax in
  the note's text colour (the island) or the style's (the window, light
  or dark), at the editor's font size. `$…$` sits on the text's
  baseline, and a tall one makes its line taller. `$$…$$` is drawn in
  display style; alone on its line or lines, it is centred on a line of
  its own (lines wrapped; unwrapped, it starts at the left), and a block
  over several lines takes the picture's height, not one line each.
- **On the edited line, the LaTeX shows**, its dollars dimmed like other
  markers, so it can be edited. A `$$` block over several lines shows
  whole while the cursor is on any of its lines. Without the key focus
  every formula is drawn, as every marker is hidden. A click on a picture
  puts the cursor there, so it opens for editing.
- **Until its picture comes**, a formula shows as dimmed source. One
  MathJax refuses shows its source with a squiggly underline; in the
  window MathJax's message is its tooltip (the island has no tooltip for
  it). Without MathJax (`make mathjax`), or when the helper cannot run,
  the source shows as plain text, and the formulas are asked for again
  30 s later.
- **The file stays the Markdown, byte for byte**: only how the text is
  laid out changes. Undo, the formatting bar, the search, cursor
  movement and every offset are those of the plain text.

### Which dollars are formulas (`render.js`, `mathSpans`)

As Pandoc reads them (tex_math_dollars):

- `$…$`: the opening `$` has a non-space character right after it, the
  closing one a non-space character right before it and no digit after
  it, and nothing between them is another `$`. One line only. So
  `$5 and $10` and `$20,000 and $30,000` stay text, while `$5 and $x^2$`
  has one formula, `x^2`.
- `$$…$$` may span lines, but not a blank line or a code fence; a `$`
  inside it is part of it. Empty ones (`$$ $$`) are text, and so are runs
  of three or more dollars.
- `\$` is a dollar sign (an even number of backslashes before it is not an
  escape). Dollars in code (`` `…` ``, fenced blocks) are text.
- Nothing inside a formula is Markdown: `mathMarkdownSpans` runs the usual
  `markdownSpans` over the note with each formula's characters masked
  (one neutral character per UTF-16 unit, line breaks kept), so offsets
  stay and `$a_1 * b_2$` is no italic.

### How: the island (`features/formulas/notes/island.js`)

Prototyped in the headless Shell (2026-10-05) before building:

- **Pango shape attributes work on the editable `Clutter.Text`.** A shape
  on a formula's first character with the picture's logical rectangle
  (its top `baseline` px above the text baseline) reserves exactly that
  box: the line grew from 21 to 40 px for a 30 + 10 px shape, and the
  cursor rectangle of the shaped character is the box itself
  (`position_to_coords`: y = baseline − shape top), so the picture goes
  at that point. A shape of no size on the formula's other characters
  makes them take no width, and a line holding only such characters
  takes no height: a three-line `$$` block measured 50 + 0 + 0 px for a
  50 px picture. Clutter draws nothing in a shape. Every character stays
  in the text, so cursor keys and the formatting bar work on the plain
  offsets. `allow_breaks: false` keeps a formula on one line.
- **Pictures cannot be children of the `Clutter.Text`**: added there, an
  actor was allocated and mapped but never painted (ClutterText draws
  only its text). They are children of a **layer of no size** added after
  the entry in the scrolled box, so they scroll and clip with the note
  and are drawn over the text; their places come from the entry's,
  the text's and the layer's allocation boxes plus `position_to_coords`,
  set in a `BEFORE_REDRAW` later after each restyle and allocation.
- A formula alone on its lines gets a shape as wide as the editor (less
  1 px) when lines wrap, with the picture centred in it; a new width
  restyles. Unwrapped it is as wide as the picture: a shape the editor's
  width there would pin the editor's minimum width to it.
- **Reading the `Clutter.Text`'s `font-description` (or its getter) again
  and again crashed GNOME Shell 50** (`free(): invalid pointer`, found by
  bisecting in the headless Shell); the font comes from the theme node
  (`get_font()`) instead, which was fine 150 times over.
- Scale: the font's px size / 16 (MathJax's em) × the text's resource
  scale; colour: the theme node's foreground colour.

### How: the window (`features/formulas/notes/window.js`)

GtkTextView cannot shape text, and options that add a character to the
buffer were ruled out. Evaluated (Broadway prototype, 2026-10-05):

- **(b) a child anchor or a paintable in the buffer** adds U+FFFC: the
  saved text, undo, the formatting bar's offsets and the search would all
  have to filter it. Not taken.
- **(a) overlays plus tags on the source**, taken:
  - A transparent tag at 1 % size (never `invisible`, which
    GtkTextBuffer:text leaves out) makes the formula's characters about
    0.1 px each.
  - `letter_spacing` on the first character alone widened it by exactly
    the asked amount (60 px asked, 19 → 80 px), with no trimming at the
    run's edges, so it makes the picture's width.
  - `rise` on a tiny character moves the line's extents exactly: +30 px on
    the first and −20 px on the last made a 51 px line (30 above, 20
    below, 1 for the tiny text). So the first character is raised by the
    picture's height above the baseline and the last lowered by its
    depth.
  - A formula alone on its lines: `pixels_above_lines` = the picture's
    height on its first line (measured: 40 px asked, a 41 px line), its
    lines' spaces hidden too, the picture centred.
  - `add_overlay(widget, x, y)` takes buffer coordinates and scrolls with
    the text; the places come from `get_iter_location` and
    `get_line_yrange`, set at once and again in a `PRIORITY_DEFAULT_IDLE`
    idle (after GTK's own line validation), and when a scroll adjustment
    says the width (`page-size`) or the height changed.
  - GTK 4.20 allocates an overlay at its **minimum** size, so each
    `Gtk.Picture` has its size request; and `remove()` does not take an
    overlay off ("not a child of GtkTextView"), so unused ones are hidden
    and reused.
  - Pictures drawn for a scale of 2 are twice as large in pixels as on
    screen: a small `Gdk.Paintable` gives the texture its size in logical
    pixels.
- The tags sit just under the hidden one, so the search's match stays on
  top. Light/dark changes restyle (`Adw.StyleManager`, while the view is
  mapped).

### Rendering and its cost (`features/formulas/notes/images.js`)

- One math renderer client per process, shared with the Formulas tab
  (`features/formulas/renderer/shared.js`): GNOME Shell runs at most one
  helper, the settings window one of its own (docs/features/formulas.md
  §4).
- Every formula of the open note is asked for (notes are short), at
  (tex, display, colour, scale), 0.25 s after the last change, so typing
  never waits and partial formulas are not each sent while typing. The
  client caches 200 pictures; answers that come together make one
  restyle. A formula keeps its picture while the text around it changes.
- Restyling is synchronous as before (the parse is a pass over the
  note); placing pictures waits for layout (a later, an idle).

### Public build

`render.js`, `styler.js`, `view.js` and `allNotesStyler.js` hold the math
path in `local:begin notes-math` blocks, which `tools/pack-public.sh`
strips (`strip_local.py --several`); `features/formulas` (with `notes/`)
is deleted, and `check_zip.py` fails on `formulas/notes`, `mathSpans`,
`mathMarkdownSpans`, `IslandMath`, `WindowMath` or `notes-math` in the
zip. After stripping, `render.js` and `view.js` are as before; `styler.js`
gained `spanAttributes()` (what `markdownAttributes()` did, for given
spans) and `allNotesStyler.js` a `_spans()` method, the same behaviour.

### Tests

- `tools/unit/notes-math.test.js`: the dollar rules (inline, display,
  over lines, escapes, money, code), no Markdown inside, the edited line,
  offsets with other scripts; the pictures' states against the stand-in
  helper (pending, ready, error, MathJax missing, a helper that cannot
  start, destroy); the shared client.
- `tools/unit/notes-all-notes.gtk.test.js` (real MathJax; skipped,
  saying so, without it): the window draws two pictures off the edited
  line, the inline one on its room (place, width, line height), the block
  centred and its line as tall; the edited line shows the LaTeX, dollars
  dimmed; text, the saved file (typing around formulas) and undo are the
  plain note; Bold after a formula by the plain offsets; a refused
  formula underlined with tooltips on.
- Headless (`FROONTY_TEST_ONLY=testNotesMath`): pictures off the edited
  line by one helper, the inline one on its reserved box and drawn (ink),
  the block centred with its lines one picture high, money as text, the
  source on the edited line, the text and the file unchanged, a helper
  that cannot start leaves plain source, and disable() leaves no helper
  and no picture.
- `tools/unit/notes-render.test.js` tests `styler.js` as the public build
  has it (the island's formula path needs GNOME Shell's Clutter).

### Not done or not verified

- No tooltip with MathJax's message in the island.
- A change of the monitor's scale is picked up at the next restyle (an
  edit, a move to another line, a focus change), not at once.
- Fractional scaling in the window: the surface's scale is used where
  GTK gives one; not tried on a fractionally scaled display.
- Very long notes: every formula of the note is asked for, not only the
  ones on screen.

## All notes window and labels (2026-10-02)

User requests: "I want a button to show all the notes under the Notes tab,
separately, into another window so that it will be easy for me to search
through them. I also want a new sub-feature, to add one or more labels to
a note and filter to search by one or more labels (like an indexing
feature)"; then: labels by right-click on the note's title; "The
expandable bar button and the + button (to add a new note) must be the
only buttons on that row"; "To show all notes, a button next to the
settings button"; that button "tinted slightly different to indicate that
is part of the Notes tab"; and "The color circle in the Note's title
should disappear".

### What shows

- **Hub header, Notes tab only:** `[panic] (date pill) [panic] … [All notes]`. An
  icon button like its neighbours (`edit-find-symbolic`, tooltip and
  accessible name "All notes"), with a faint wash of the selected note's
  colour behind the icon: alpha 0.16 at rest, 0.28 on hover or focus,
  0.38 pressed (charcoal 0.30/0.48/0.60: #3b3b3b would vanish on the
  black island). Tab order: ⚙️ (at the bottom of the tab column) → panic
  buttons → date pill → All notes. A click collapses the island (which
  saves the open note) and opens the settings window on its All notes
  page, or raises it. Other tabs show nothing at the header's right end
  (the date pill was 📅 until 2026-10-03, and ⚙️ sat at the header's
  right end until 2026-10-04).
- **The tab row** keeps the note tabs, "+" and the fold button only; the
  tools row is unchanged. A tab shows its name, and × on hover or while
  selected. No colour dot, and labels never show there.
- **A note's labels:** right-click its tab, or Menu / Shift+F10 on a
  focused tab. A GNOME popup menu opens under the tab:

  ```
  ┌ Labels · Plan ───────────────┐  title (plain text)
  │ [Filter or add a label…    ] │  has the focus
  │ ✓ q4                         │  this note's labels, then the others,
  │ ✓ work                       │    each by name; the order holds while
  │   home                       │    the menu is open
  │ + Add “ideas”                │  when the text is a new label
  │   3 more — type to filter    │  past 12
  └──────────────────────────────┘
  ```

  Typing filters (ignoring case and accents). Enter turns an existing label
  on (never off) or adds a new one, then clears the entry; Down moves to
  the list. Click, Space or Return flips a label, written at once, and the
  menu stays open. Escape or a click outside closes only the menu: the
  island stays open and the focus goes back where it was. If the labels
  file cannot be read, the menu says so and offers nothing else.
- **The All notes page** is a subpage of Froonty's settings window, the GTK
  window GNOME's extension preferences service runs: a real window (Alt+Tab,
  resizable, stays open through a screen lock) whose back arrow leads to
  the settings tabs. 900×640 when it opens on this page.
  - Sidebar: a search entry (Ctrl+F; Down to the list; Escape clears it;
    Enter goes into the note at its first match, or at its end without a
    search: the open note while it is listed, else the first result, which
    opens, so typing never goes into a note the search or the chips hide),
    label chips with their counts (over notes that exist),
    All/Any while two or more chips are on, Clear, and the list: colour,
    name, date ("16:03" today, "29 Sep" this year, else with the year), a
    two-line excerpt with the matches in bold, and the note's labels. At
    most 300 rows, then "Showing 300 of N — refine the search".
  - Note pane: colour, name, labels, a **Labels** menu (an entry and a
    check per label) and the fold button, then the island's **formatting
    bar** (see below), then the editor with GTK's undo, drawn rendered as
    in the island (see below). Matches of the search are marked in yellow,
    over the rendering, and the view scrolls to the first.
    Loading a note or a reload cannot be undone, so undo never reaches into
    another note or version.
  - Without a search the newest notes come first; with one, name matches,
    then label matches, then text-only matches, newest first within each.
  - The list re-runs only when the search, the chips, All/Any or the notes
    change; not while typing in the editor, so rows do not move. A note the
    filter hides stays open in the pane.
  - It opens on the note last used in the island (`notes-last`), else the
    newest. It follows the island again whenever the island has moved to
    another note since the window last looked: when the page is shown
    again, or the window is raised (the island's button raises it without
    changing the view key). A note picked in the window stays while the
    island stays on its note.
  - Another notes folder (Settings → Notes): the page starts over there,
    also when the folder changed while the page was hidden. The open note
    is saved in its own folder first, and closed (it was once still open,
    and typing went to the old folder's file).
  - A note that is not plain UTF-8 text is shown read-only, with a banner
    (see Data).
  - Settings → Notes → **All notes** opens it too.
  - Create, rename and Trash stay in the island (v1).

### Formatting bar in the window (2026-10-03)

User request: "I want to be able to edit in 'All notes' too. Enable that
bar there too."

```
● Plan                       q4 · work  [Labels ▾] [⤴]
[B][I][S][H][•][1.][☑][</>][🔗][↩]
─────────────────────────────────────────────────────
# Q4 plan
```

- **The same buttons, in the same order, as the island's bar:** Bold,
  Italic, Strikethrough, Heading (`H`), Bulleted list, Numbered list,
  Checklist, Code (`</>`), Link, then Wrap lines. Same icons (Adwaita's),
  the names as tooltips and accessible names. The list lives in one pure
  module, `formatActions.js`, which both bars build from, so they cannot
  drift apart. Same edits too (`markdown.js`): a bare cursor inside
  `**hi**` counts as bold, a selection over several lines wraps each line
  on its own, Link selects the URL.
- **Toggles show their state** at the cursor or selection, as in the
  island: GTK toggle buttons, lit in the accent colour when on (a click
  removes it). They follow clicks, the keyboard, typing and undo. Link is
  a plain button.
- **An edit is one undo step** (Ctrl+Z): only the changed part of the text
  is replaced, inside one user action of the `GtkTextBuffer`, so the
  search marks and the scroll position elsewhere stay. The edit's
  selection is kept (inside the markers, or the edited lines), and the
  focus stays in the editor: the buttons never take it on a click. The
  edit saves like typing, after the pause.
- **Wrap lines and the fold button are the island's settings**
  (`notes-wrap`, `notes-show-tools`), so both editors look alike: wrapping
  off in the window is off in the island too, and the other way round.
  Before, the window always wrapped. The fold button (⤴ / ⤵, the same
  bundled icons, loaded by path in the settings process too) is at the
  end of the note's header; folded, only the bar goes.
- **Read-only** notes (not plain UTF-8) and no note open (none picked, or
  gone): the formatting buttons are insensitive. Wrap lines still works:
  it changes the view, not the note.
- No keyboard shortcuts (Ctrl+B and so on): the island has none either.
- **Rendered, as in the island** (2026-10-04, for a light, Notion-like
  editor in the window): `allNotesStyler.js` turns the
  same `render.js` spans into GTK text tags. Headings, bold, italic,
  strikethrough, code, links, quotes and done items are drawn formatted.
  The line with the cursor shows its markers, dimmed; the others hide
  theirs, and so does every line while the editor has no focus. A
  checkbox and a quote's `>` stay, dimmed. The tags recompute on each
  edit, on a move to another line and on focus changes; they are not
  edits, so they never reach the undo history or the autosave.
  - Hidden markers are transparent at a twentieth of the size, not tagged
    `invisible`: GtkTextBuffer:text leaves invisible characters out, and
    the pane saves that text, so `invisible` would drop the markers from
    the file. As in the island, each character also keeps its place for
    the cursor and the bar.
  - The muted colour is a mid grey for light and dark styles alike (the
    window's editor has no note colour).

### Filters

Words of the search must all match (AND), each in the name, the text or a
label, ignoring case and accents. Selected labels narrow further: **all of
them** by default, **any of them** as an option, remembered in
`notes-label-match`. AND by default because each extra chip should narrow
the list, the way an index is used; OR would widen it with every click.

- **Accents** are the combining diacritical marks (the five Unicode blocks
  of that name: Latin, Greek and Cyrillic accents; "cafe" finds "Café",
  "ежик" finds "Ёжик"). Other combining marks are letters or sounds of
  their scripts and count: Devanagari vowel signs ("काता" does not find
  "कुत्ता", "dog"), Japanese voicing marks ("がき" does not find "かき"),
  Thai vowels. Folding removed every mark before.
- **Cost:** a search keeps one folded copy of each note's text (a string),
  and works out excerpts and bold ranges only for the rows shown (at most
  300). Measured on this machine with 500 generated notes of 10 KB: the
  first search took about 120 ms and the process grew by about 19 MB;
  before, with a map of two numbers per character for every note, about
  1 s and 171 MB, held while the window was open. Later searches take a
  few ms.

### Data

- `.md` files: unchanged, plain Markdown.
- `.md` files that are not plain UTF-8 text (Latin-1, UTF-16 from Windows
  Notepad, NUL bytes): shown **read-only** in both editors, with a notice
  (invalid bytes as "�", NUL as "␀"), and never written. Before, the
  editors replaced the bytes with U+FFFD or cut the text at the first
  NUL, and the first keystroke saved that for good. Renaming, colours,
  labels and the Trash still work.
- `.froonty.json` (order, colours): format unchanged, written by the Shell
  only. Keys Froonty does not know are now kept (`meta.extra`), so a later
  version's fields survive. A file that cannot be read (not UTF-8, invalid
  JSON, not an object, another `version`, a read error other than "not
  found") is **never written**: the island shows the default order and
  colours with the line "Order and colours could not be read
  (.froonty.json), so they are not saved.", colour changes are refused,
  and the window's banner says so. Once the file is fixed it counts again.
  Before, any such file was rewritten at once with the alphabetical order
  and no colours (and a sync tool spread that). Empty: nothing, writable.
- **`.froonty-labels.json`** (new), next to the notes:
  `{"version": 1, "labels": {"Plan": ["q4", "work"]}}`, 2-space indent.
  - A file of its own: older Froonty builds rewrite `.froonty.json` and
    would drop labels kept there; they never touch this file.
  - Missing: no labels. Empty: no labels, and it may be written. Invalid
    JSON, a top level or `labels` that is not an object, another `version`,
    invalid UTF-8, or a read error other than "not found": the file is
    read-only (never written), and the menu and the window say "Labels
    could not be read (.froonty-labels.json)". In a readable file, bad
    entries are dropped one by one; unknown top-level keys are written back
    as found. (A file without `labels` reads as no labels.)
  - A label: NFC, trimmed, leading `#` dropped, whitespace runs made one
    space; 1 to 40 code points, no control characters. Identity ignores
    case, not accents ("Work" = "work", "café" ≠ "cafe"); the first
    spelling in the file wins.
  - Writes: read, change, write back with the etag read (the previous file
    is kept as `.froonty-labels.json~`); if someone wrote in between, all
    over again, up to 3 times. A missing file is first made empty with
    `create`, never over one that appeared meanwhile.
  - Entries move or go only when the user turns a label off, when Froonty
    renames a note (an old entry at the new name is replaced), and when
    Froonty creates a note (or a conflict copy) whose name has an old entry
    (cleared). Conflict copies clear it in `store.saveCopy`, shared by the
    island and the window (the window's copies kept old labels before). Entries of notes that are gone are kept, never shown or
    counted: a note restored from the Trash gets its labels back (its
    colour still comes back yellow). A rename made outside Froonty leaves
    the labels under the old name, and renaming back restores them: a known
    v1 limit.
- `settings-window-view` (`settings` | `all-notes`, internal): which page
  the settings window shows. The Shell sets it before it opens or raises
  the window; the window follows it, sets it as the user navigates, and
  sets it back to `settings` when it closes on All notes. With no window of
  Froonty's, the Shell also sets it back: on enable (login, unlock) and
  when a requested window has not come after 10 s (another extension's
  preferences were open). Before, a window that never came, or one that
  went without closing (logout, a killed process), left it on `all-notes`,
  and the Extensions app then opened on All notes.

### Two writers

The island and the window are two processes that may edit the same note.
Both save through `noteWriter.js`:

- Each write names the etag (modification time) of the version it
  replaces. If the file changed since, the writer reads it. The same text
  as ours: take its etag. Our base text (only the time changed, e.g. a sync
  tool touched it): write again. Anything else: keep both. Ours goes to a
  new note `<name> (conflict)` (or `(conflict) (2)` and so on, made with
  `create`, so it never overwrites anything), which becomes the open note,
  with the notice "“Plan” changed elsewhere. Your version was kept as “Plan
  (conflict)”." A copy starts without labels and yellow.
- Writes run one after the other, each with the etag the previous one
  returned. A write in flight finishes after disable or a screen lock,
  conflict copy included.
- A note deleted elsewhere while it has unsaved edits: they go to a copy.
- **A save that fails** (no permission, a full disk, a USB or network
  folder that went away) leaves the text unsaved, with the error shown: it
  is tried again with the next keystroke or switch. Neither the island nor
  the window opens another note over it (a tab or row click, "+" and Enter
  do nothing until it can be saved); `NoteWriter.open()` throws rather than
  drop unsaved text. When the notes folder changes, text that still cannot
  be saved in the old folder is kept as `<name> (conflict)` in the new one,
  which opens, with the notice "“Plan” could not be saved in the previous
  folder. Your text was kept here as “Plan (conflict)”." Before, picking
  another note dropped the text and wiped the error.
- Trash waits for a write in flight (written after the Trash, it would
  make the note again).
- A reload never replaces text typed (or saved) while its read was on the
  way. Before, a keystroke typed during a refresh could be undone by the
  older text from disk.
- A rename while the window's library is listing the folder (a slow or
  large folder) is not taken for a removal: entries renamed after a
  listing started are left to the next refresh. Before, the renamed note
  was "removed", and the window saved its unsaved edits as a needless
  `(conflict)` copy.
- Limits: folders without etags write unchecked, as before. A save that
  still fails when the island is disabled (a screen lock) is lost with
  the island's state, as before. On exFAT,
  changes less than about 10 ms apart are not told apart (measured), so the
  last writer wins. A window save racing the island's Trash can make the
  note again; its text is kept, never lost. The window's process exits 2 s
  after its window closes; a write still pending then is cut off, and
  `g_file_replace` keeps the previous file, so at most the last ≤0.8 s of
  typing is lost.

### How

- **Right-click (the route that shipped):** a `Clutter.ClickGesture` for
  the secondary button with `recognize_on_press`, added to each tab, as
  GNOME's app icons do. It is recognized before St.Button's own gesture,
  which then neither selects nor renames; the headless tests check both.
  The fallback (button 3 in `button_mask`, handled in `clicked`) was not
  needed. The keyboard way is St's `popup-menu` signal (Menu, Shift+F10).
  The double-click detector counts primary presses only.
- **The menu hangs from the tab's content**, not the tab: a PopupMenu takes
  over its source's Space and Return, which must stay the tab's.
- **The entry keeps the focus** until the pointer moves over the menu.
  GNOME's menu items take the key focus when the pointer enters them; a
  menu opened from the keyboard under a resting pointer lost the typing to
  the item below it (found by the headless tests). Items follow the
  pointer only after a motion inside the menu (`ui/contextMenu.js`).
- **Flipping a label keeps the menu open:** the items override
  `activate()` instead of emitting 'activate', which would close the menu.
- **Tabs are rebuilt only when the notes or the selection change**, so a
  folder event (or a label written) leaves an open menu alone. A rename or
  Trash rebuilds them, and the menu closes with its source. The service
  tells the view when a refresh changed the list, its order or the
  colours, also when the open note is unchanged: a note made by another
  program (or a window's conflict copy) used to get its tab only once
  something else changed.
- **Hub header actions** (`ui/hubHeader.js`): a view may expose
  `headerActions`, widgets it owns and destroys; the hub places them at
  the header's right end, only while that tab is active. The hub also
  reports a `minWidth`: the island grows so that the date pill and the
  panic buttons around it fit between the side column (the tabs, ⚙️) and
  the header's buttons, 8 px clear of each. The pill is centred on the
  island where that leaves them clear, and moved as far as needed where
  not. (With the date pill, from 2026-10-03, the bar used to stay centred
  and the island grew instead: about 498 px on the Notes tab, whose
  default is 428. Until 2026-10-04 the header also held ⚙️, and the
  panic bar sat left of the date pill.) The value it returns
  is always the one it reports. With no panic buttons it used to return 0
  while still reporting the last width, so the header's allocation watch
  saw a change on every frame of an expand: about 60 resizes, each
  restarting the animation (1.5 s, no bounce) until panic buttons came
  back or the extension restarted.
- **Lifecycle, Shell:** the button lives with the Notes view. The label
  menu exists only while open (one modal grab, one uiGroup child, one focus
  group, one `Main.sessionMode` and one `system-modal-opened` handler) and
  is destroyed when it closes, on a tab switch or collapse, and on disable
  or lock. No new timer, monitor or subprocess.
- **Lifecycle, window:** while the page is shown, one folder monitor and up
  to 8 reads in flight; while its editor has unsaved text, one 0.8 s
  one-shot timer. Everything stops when the page is left or the window
  closes.

## 1. Goal

The hub gets a Notes tab: a quick plain-text / Markdown scratch space.
Several notes are shown as capsule tabs, and edits save by themselves.

## 2. Storage (agreed): Markdown files

- There is one `.md` file per note, in a folder. The default is
  `$XDG_DATA_HOME/froonty/notes` (`~/.local/share/froonty/notes`), and it can
  be changed in the Notes settings tab.
- The **note title is the file name** without `.md`. Renaming a note renames
  the file.
- Files are plain UTF-8. Any editor can open them, and they can be synced
  (Nextcloud, Dropbox, git).
- **Deleting a note moves it to the Trash** (`Gio.File.trash`), not a hard
  delete.
- **External changes** (another editor, sync) are picked up through
  `Gio.FileMonitor` on the folder, which is event-driven with no polling.
  An open note that is being edited is not reloaded underneath the user.

## 3. Structure

```
features/notes/
├── index.js      descriptor
├── names.js      pure: note name ↔ file name, timestamps, uniqueness
├── markdown.js   pure: formatting-bar edits on text + selection, and
│                 which formatting applies there (toggle state)
├── render.js     pure: rendered Markdown spans, markers to hide
├── styler.js     Pango attributes on the editor from render.js
├── labels.js     pure: labels, their file, label filters
├── search.js     pure: folding, search, ranking, excerpts, Pango markup
├── store.js      Gio async file I/O: list, read, atomic write (etag-
│                 checked), create, rename (never overwrites), trash,
│                 conflict copies, labels file; folder monitor
├── noteWriter.js autosave of one note: etag checks, conflict copies
│                 (shared by the island and the window)
├── service.js    notes list + selection; queued operations; labels
├── tabs.js       St: capsule tabs, inline rename, two-step ×, right-click
├── labelMenu.js  St: a note's labels in a GNOME popup menu
├── headerActions.js  St: "All notes" in the hub header, tinted
├── formatActions.js  pure: the formatting bar's buttons, in order (both
│                 bars)
├── formatBar.js  St: formatting buttons; lights the active toggles
├── view.js       St: composes tabs, fold button, tools row, editor,
│                 empty state
├── icons/        ⤴ / ⤵ fold icons (symbolic SVG)
├── prefs.js      Notes settings tab: enable, folder, All notes
├── library.js    window side, no GTK: every note, followed by the monitor
├── allNotesPage.js  GTK: the All notes page (search, labels, list)
├── allNotesNote.js  GTK: its note pane (header, Labels, bar, editor)
├── allNotesFormatBar.js  GTK: the window's formatting bar
└── allNotesStyler.js  GTK: text tags on the window's editor from
                  render.js
```

`names.js`, `markdown.js`, `labels.js`, `search.js`, `store.js`,
`noteWriter.js`, `service.js` and `library.js` have unit tests
(`tools/unit/`, plain `gjs`, isolated temporary folders). The All notes
page itself (`allNotesPage.js`, `allNotesNote.js`) is driven through its
widgets in `notes-all-notes.gtk.test.js`: search and bold matches, chips
with All/Any and Clear, the Labels menu writing the file, Enter into the
first result, a failed save, a folder change (also with a failed save),
following the island, a conflict copy's labels, read-only notes, and the
formatting bar: every action on a selection and on a bare cursor (text,
selection, lit toggles, saved), Link and undo, toggles following the
cursor, Bold over several lines, an emoji before the selection, read-only
and no note, Wrap and the fold button. It runs
on a private Broadway display (`tools/unit/run.sh`) and imports a copy of
the modules in which the preferences service's gettext import names a
stub.

## 4. Behaviour

- **Autosave:** 0.8 s after the last keystroke, a single `GLib.timeout`
  that is reset on each change. Changes are also flushed immediately when
  the island collapses, when the tab changes, and on disable. This is the
  only timer; it exists only while there are unsaved changes.
- **Writes** use `replace_contents_async`, which is atomic (write to a
  temporary file, then rename), so a crash never leaves half a note.
- **Editor:** a multi-line `St.Entry` in an `St.ScrollView`, with wrapped
  text.
  - Limitation: Clutter's text widget has **no undo**. Undo would have to be
    written by us, so it is left out of v1.
- **Tabs:**
  - capsule tabs with a "+" to add a note
  - the selected note is remembered
  - rename by double-clicking the tab
  - a "×" on hover moves the note to the Trash, after confirmation
- **Visual language** is adapted from vorssaint-utils' Scratchpad (layout
  ideas only):
  - capsule tabs 22 px tall
  - editor surface radius 12, white 6.5%
  - placeholder "Type anything. It saves by itself."

## 5. Implementation notes

- `service.js` runs every folder operation through **one queue**. The folder
  monitor also fires for Froonty's own writes; without the queue, its
  refresh raced the operation that caused it. Unit tests caught this.
- Clicking inside the expanded hub no longer collapses the island. The pill
  is an St.Button, and a press that bubbled up to it cleared the editor's
  key focus.
- **Scrolling keeps a gap around the cursor line.** While typing or moving
  the cursor, its line stays a gap away from the editor's rounded top and
  bottom edges, and the note has the same extra space below its last line.
  The gap is the editor's bottom padding in `stylesheet.css` (16 px).
  Before this, the cursor position was taken relative to the text instead
  of the scrolled box, so the last line ended up 8 px under the edge.
- The editor takes the key focus when the tab is shown, when a note is
  created, and when a tab is picked (`view.setActive`).
- Long notes scroll inside the editor. Ubuntu's Yaru theme sets
  `StEntry { min-height: 22px }`. A scrolled view sizes its content by its
  minimum height, so that rule stopped scrolling; `min-height: auto` on the
  editor fixes it. Only the Ubuntu-mode tests saw this, so `make test` now
  runs both modes.
- Unwrapped, `Clutter.Text` still reports a ~1px minimum width, and a
  scrolled view sizes content by its minimum. So the editor's minimum width
  is pinned to its natural width while wrapping is off.
- After scrolling a long note, clicks on the tabs and toolbar went to the
  editor. The note is one tall actor reaching up behind the header, and
  Clutter only re-checks the actor under the pointer outside that actor's
  area minus actors drawn above it. The editor is now drawn *below* the
  header: a grid places it in row 1 but adds it first. Clipping did not
  help, and clipping the scrolled content blanked it. The headless suite
  now also checks pixels, so that the text is really visible when scrolled.
- Unit tests run through `tools/unit/run.sh`, with a private `TMPDIR` and
  `XDG_DATA_HOME`. Trashed test notes once reached the real
  `~/.local/share/Trash`; the runner now prevents that, and the file tests
  refuse to run outside it.
