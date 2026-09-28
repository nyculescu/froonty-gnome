# Feature: Notes

Status: **design**. The decisions below are agreed; the open questions in §5
are still open.

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
├── store.js      Gio async file I/O: list, read, write (atomic replace),
│                 rename, trash; folder monitor; no St
├── service.js    notes list + selected note; debounced autosave; emits 'changed'
├── view.js       St: capsule tabs (+ to add), editor, empty state
└── prefs.js      Notes tab: enable, folder
```

`store.js` and the debounce logic get unit tests (plain `gjs`, temporary
folder).

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

## 5. Open questions

1. **Markdown:** v1 is plain text with no formatting bar and no rendered
   preview. A preview needs Markdown-to-Pango conversion, which would be a
   separate step. Is that OK?
2. **New note naming:** use "Note 1", "Note 2", …, or a timestamp such as
   "2026-09-28 15:40"?
3. **Limits:** vorssaint caps at 12 notes. Should Froonty have no cap, with
   tabs that scroll?
