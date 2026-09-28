# Feature: Notes

Status: **implemented (v1)**. Decisions made 2026-09-28:

- v1 includes a Markdown **formatting bar**: bold, italic, strikethrough,
  heading, bulleted, numbered and check lists, code, and link. There is no
  rendered preview yet.
- New notes are named with a **timestamp**, `2026-09-28 15.40`. It uses `.`,
  not `:`, which is invalid on exFAT/NTFS. A second note in the same minute
  gets ` (2)`.
- There is **no cap** on the number of notes; the tabs scroll. "+" stays
  outside the scrolling row.

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
├── markdown.js   pure: formatting-bar edits on text + selection
├── store.js      Gio async file I/O: list, read, atomic write, create,
│                 rename (never overwrites), trash; folder monitor
├── service.js    notes list + selection; queued operations; autosave
├── tabs.js       St: capsule tabs, inline rename, two-step ×
├── formatBar.js  St: formatting buttons
├── view.js       St: composes tabs, bar, editor, empty state
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
- The editor takes the key focus when the tab is shown, when a note is
  created, and when a tab is picked (`view.setActive`).
- Unit tests run through `tools/unit/run.sh`, with a private `TMPDIR` and
  `XDG_DATA_HOME`. Trashed test notes once reached the real
  `~/.local/share/Trash`; the runner now prevents that, and the file tests
  refuse to run outside it.
