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
- The Notes island is **428×319**.
- **Middle-click** on a tab moves that note to the Trash at once, like
  closing a browser tab (it can be restored from the Trash).
- A **Wrap lines** toggle at the end of the formatting bar (one setting for
  all notes, `notes-wrap`, on by default). When it is off, lines stay on one
  line and the note scrolls horizontally; the view follows the cursor both
  ways.
- Each note has a **colour**, like Windows Sticky Notes: yellow (default),
  green, pink, purple, blue, gray or charcoal. It tints the editor and the
  tab dot, and is chosen with the round colour button.
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

**Next (on hold, agreed 2026-09-28): rendered Markdown.** The formatting
bar only pays off if the note *shows* formatting as Sticky Notes does, with
bold looking bold and headings larger. Proposed approach, not yet validated:

- Style the editable `Clutter.Text` with Pango attributes computed from the
  Markdown source.
- Hide the markers (`**`, `#`, `_`) except on the line being edited, as
  Obsidian's live preview does.
- Files stay plain Markdown.
- First step: a prototype confirming that `Clutter.Text` honours
  attributes while editable.

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
├── store.js      Gio async file I/O: list, read, atomic write, create,
│                 rename (never overwrites), trash; folder monitor
├── service.js    notes list + selection; queued operations; autosave
├── tabs.js       St: capsule tabs, inline rename, two-step ×
├── formatBar.js  St: formatting buttons; lights the active toggles
├── view.js       St: composes tabs, fold button, tools row, editor,
│                 empty state
├── icons/        ⤴ / ⤵ fold icons (symbolic SVG)
└── prefs.js      Notes settings tab: enable, folder
```

`names.js`, `markdown.js`, `store.js` and `service.js` have unit tests
(`tools/unit/`, plain `gjs`, isolated temporary folders).

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
