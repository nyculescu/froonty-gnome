# Feature: Clipboard

Status: **first iteration, implemented**, 2026-10-01; the switcher,
2026-10-04. Working tree only for now (`features/localFeatures.js`;
`make pack` leaves it out). **Off by default.**

A history of what you copy or cut: text, images, and file or folder
locations. Click an entry and it is on the clipboard again, ready to be
pasted wherever you want. Or, where you type, hold Super and press V to
pick an entry from a pop-up and insert it ([Switcher](#switcher)).

## Rules it follows (extensions.gnome.org review guidelines)

- **Declared.** `metadata.json`'s description says that Froonty reads the
  clipboard, what it keeps and where, and that it is off by default. The
  guideline: "Extensions that access the clipboard, with or without user
  interaction, MUST declare it in the description."
- **Opt-in.** `clipboard-enabled` is false until the user turns it on in
  Settings → Clipboard. While it is off, nothing listens to copies.
- **Nothing leaves the computer.** The history is on disk, readable by the
  user only. Nothing is sent or shared.
- **No shortcut in a published build.** The review guidelines forbid a
  default shortcut for clipboard data. The tab's click only puts an entry
  back on the clipboard. The switcher (Super+V, it pastes) is part of the
  working-tree-only tab; it must be rethought (no default shortcut) before
  the tab is submitted.
- **Shexli.** The single `St.Clipboard.get_default()` call
  (`features/clipboard/shared.js`) is flagged EGO-A-005 "manual review",
  as for every clipboard extension. That is the access the description
  declares.

## Passwords

**A password is never saved.** At most the latest one is listed, hidden, in
memory only.

A copy counts as a password when any of these is true:

1. **The copy is marked secret.** Password managers mark a copied password
   by offering the extra format `x-kde-passwordManagerHint` (KDE's
   convention; KeePassXC sets it, for example). The macOS-style
   `org.nspasteboard.ConcealedType` counts too.
2. **A password app has the focus** when the text is copied. The focused
   window's app id, app name, window classes and Flatpak app id are
   matched, ignoring case, against `clipboard-ignored-apps`. The default
   list is keepass, 1password, bitwarden, enpass, lastpass, dashlane,
   keeper, protonpass, proton-pass, proton.pass, world.secrets (GNOME
   Secrets), passwordsafe (its old id), seahorse (Passwords and Keys) and
   authenticator.
3. **The text looks like a password** (`clipboard-detect-passwords`, on by
   default). Browsers' own password managers (Firefox, Chrome) mark
   nothing; the user checked that on 2026-10-01. So the text is judged
   (`entries.js` `looksLikePassword`): one word of 8–64 characters mixing
   at least three of lower case, upper case, digits and symbols. Ruled
   out: links, e-mail addresses, paths, numbers and dates, hexadecimal
   hashes and UUIDs, dotted names (org.gnome.Shell), camelCase, snake_case
   and CONSTANT_CASE names, and calls (`foo(bar)`). API keys and tokens
   count as passwords. Plain words, phrases with spaces, and short
   passwords like "hunter2" are not recognised.

**How it is shown:** `••••••••` (the same 8 dots whatever its length), a
key icon, and "hidden until 16:42". A click copies it again, and it stays
hidden. Hovering explains when it goes; the password itself is never
shown.

**When it goes,** whichever comes first:
- `clipboard-password-minutes` pass (1–60, default 5; one one-shot
  timer);
- the clipboard is cleared, as password managers do after a few seconds;
- anything else is copied (only the latest password is ever listed);
- the screen locks or the session ends (memory only).

With 0 minutes, passwords are not listed at all, which is the previous
behaviour.

**"When pasted" is not possible.** An app pastes by reading the clipboard
through the compositor, and GNOME Shell tells extensions nothing about
reads. Detecting them would mean replacing GNOME's own clipboard source;
that is too risky for review.

**A password picked from the history stays history.** A text entry saved
before recognition was on, or with it off, is not hidden when copied again
from the tab.

## How it works

- **Copies are announced, not polled.** `Meta.Selection`'s `owner-changed`
  signal fires for each copy. Only the clipboard is recorded, not the
  primary selection or drag and drop.
- **Formats.** The copy's formats (`St.Clipboard.get_mimetypes`) decide
  what it is, first match wins:

  | Kind | Formats | Kept |
  |---|---|---|
  | Files | `x-special/gnome-copied-files` (`copy`/`cut`, then `file://` URIs); or `text/uri-list` without text | Operation and URIs |
  | Text | `text/plain;charset=utf-8`, `text/plain`, `UTF8_STRING`, … | The text, up to 1 MiB |
  | Image | `image/png` first, else another `image/*` (not SVG) | The image file, up to 16 MiB |

  Text wins over an image, because office suites also offer a picture of
  copied text. A browser's "Copy link" offers a URI list and text, so it is
  kept as text.
- **Duplicates.** A copy of something already in the history (same SHA-256)
  moves that entry to the top.
- **Picking an entry.** A click puts the entry back on the clipboard
  (`St.Clipboard.set_text`/`set_content`). It comes back as a copy, which
  is recognised and moved to the top. Files go back as
  `x-special/gnome-copied-files`, with their original "copy" or "cut".
- **Several readers.** One recorder per Shell (`shared.js`). The extension
  holds it while the tab is enabled, so copies are recorded with the
  island collapsed; the tab holds it too while it exists.
- **Overlapping copies.** If a newer copy arrives while one is being read,
  the older one is dropped.
- **St's bytes.** `St.Clipboard` frees the bytes it hands to a callback
  when the callback returns, so they are copied inside it. Keeping them
  crashed the Shell in testing.

## Paste as plain text

When the copy on the clipboard is formatted text (it also offers
`text/html`, RTF, or an office suite's or Qt's rich formats;
`entries.js` `isFormatted`), the tab's header shows **Plain text**. A
click puts only its plain text back on the clipboard, so the next paste
anywhere has no formatting.

Entries copied again from the history are always plain text: only the
text is kept.

The tab does not paste by itself; the switcher does, on its shortcut.
Many apps also paste without formatting with Ctrl+Shift+V.

## Screenshots

Screenshots are already in the history; there is nothing separate to
turn on. In GNOME Shell 50, Print (the screenshot UI), Shift+Print (the
whole screen) and Alt+Print (a window) all end in `_storeScreenshot`,
which puts the PNG on the clipboard (`ui/screenshot.js`, checked
2026-10-02). It arrives as any other image copy. The exception is a
password app having the focus: then the capture is not kept, because a
screenshot of it may show a secret.

Screencasts (video) are not put on the clipboard, so they are not in the
history.

## Switcher

Like Windows' clipboard history, driven like Alt+Tab:

1. **Super+V** where you type: a small pop-up by the text cursor shows
   the newest entry and "1 / 14".
2. **V again**, Super still held: the next older entry. **Shift+V**: back
   to a newer one. It wraps at both ends, as Alt+Tab does ("14 / 14",
   then "1 / 14"). The arrow keys and the scroll wheel step too.
3. **Release Super:** the shown entry is inserted where you were typing.
   **Escape** cancels; so does a click outside the pop-up. A click on it,
   Enter or Space inserts.

On while the Clipboard tab is on (`clipboard-enabled`) and
`clipboard-switcher-enabled` (default on); the history is the tab's.
Every kind: text, images, copied files and folders, and the hidden
password (shown as `••••••••`, never in clear).

### The pop-up

- 360 px wide, the island's black look: a kind icon, a line about the
  entry ("15 characters", "Image · 2.1 kB", "Copied 2 items", "Password,
  hidden"), the position, the preview, and a one-line hint.
  - Text: up to 5 lines of 46 characters.
  - Image: a thumbnail 120 px tall, in proportion, from GNOME's texture
    cache.
  - Files: up to 4 names, then "and 3 more".
- **Where:** its left edge at the text cursor and 6 px below it, or above
  it when there is no room below; always inside the cursor's monitor,
  8 px from its edges (`switching.js` `popupPlacement`).
  - The text cursor comes from GNOME's input method
    (`shell/inputMethod.js`, below). Without one: the pointer when it is
    over the focused window, else that window's middle, else the pointer.
- **Shown after 150 ms**, as Alt+Tab (`POPUP_DELAY_TIMEOUT`): a quick tap
  and release inserts the newest entry (usually what is on the clipboard)
  without a flash. A second V shows it at once. An empty history shows
  "Clipboard is empty" at once, and it goes on release.
- **Nothing takes the app's focus** beyond the modal grab while Super is
  held: `Main.pushModal` on a full-stage, transparent actor, so a click
  outside the card is seen. GNOME's keybindings are off under the grab,
  so each V reaches the pop-up.

### How it follows the keys (as `ui/switcherPopup.js`)

- The shortcut is Froonty's own keybinding (`Main.wm.addKeybinding`, key
  `clipboard-switcher-shortcut`, default `['<Super>v']`, normal mode
  only). It exists only while the switcher is on.
- On the first press the pop-up takes the grab and keeps the binding's
  primary modifier (the highest bit of `binding.get_mask()`, as Alt+Tab's
  `primaryModifier`). Right after grabbing it checks
  `global.get_pointer()`'s modifiers: Super may have been released before
  the grab (Alt+Tab's "race" comment). Then it is a quick tap.
- A key press is the shortcut when `global.display.get_keybinding_action()`
  gives the binding's action; with Shift held, the same key without Shift
  is the shortcut backwards. So a changed shortcut steps the same way.
- A key release with the modifier no longer held inserts.
- `system-modal-opened` (a system dialog), `disable()` and the screen
  lock close it without inserting.

### Inserting

The grab goes first, so the app has the keyboard again. Then:

| What | Where | How |
|---|---|---|
| Text (and the hidden password) | A text field GNOME's input method knows (`Main.inputMethod.currentFocus` when Super+V was pressed), not a terminal | Typed with `Main.inputMethod.commit()`, as the on-screen keyboard types (`ui/keyboard.js`). The clipboard is left alone |
| Text | A terminal, or no such text field | Put on the clipboard, then Ctrl+V (Ctrl+Shift+V in a terminal) |
| Image, files | Anywhere | Put on the clipboard, then Ctrl+V (Ctrl+Shift+V in a terminal) |

- **"Put on the clipboard"** is the tab's click (`recorder.copy()`): the
  entry moves to the top of the history; a password stays hidden and is
  not saved. Nothing new is logged.
- **The input method's focus comes back** a moment after the grab: the
  app re-enables its text field. GNOME tells nothing when it does, so
  Froonty checks every 20 ms, at most 30 times (0.6 s), only between a
  release and the insertion (DESIGN.md §2). If it does not come back, the
  text goes through the clipboard instead.
- **Keys** come from a Clutter virtual keyboard
  (`seat.create_virtual_device(KEYBOARD_DEVICE)`, `notify_keyval`), as the
  on-screen keyboard sends them: every key pressed, then released in
  reverse order, so none stays down. It is made on the first paste and
  dropped in `destroy()`. Keys are sent only while the window that had
  the focus at Super+V still has it.
- **Terminals are not typed into:** a typed line ending in a newline would
  run at once, while a paste in a terminal is bracketed (the shell sees it
  as pasted text). A terminal is told by its text field's purpose
  (`Clutter.InputContentPurpose.TERMINAL`, which VTE sets: GNOME Terminal,
  Ptyxis, Console, Tilix) or by the focused window's app id, window class
  or Flatpak id against a list (`switching.js` `isTerminal`: Alacritty,
  kitty, foot, WezTerm, Konsole, Ghostty, xterm and others).

### What each kind of app gets

Only the GTK 4 row was checked (headless, 2026-10-04); the rest is what
the protocols suggest and should be tried on the real session.

| App | Cursor position | Text | Image, files |
|---|---|---|---|
| GTK 4 (text-input-v3) | The text cursor (checked) | Typed (checked) | Ctrl+V reaches the app (checked) |
| GTK 3, Qt 6, Firefox on Wayland using text-input | The text cursor (expected) | Typed (expected) | Ctrl+V |
| Apps using IBus directly (`GTK_IM_MODULE=ibus`, `QT_IM_MODULE=ibus`) | X11 apps: IBus's cursor (`set-cursor-location`); Wayland apps: the pointer | Clipboard and Ctrl+V | Ctrl+V |
| XWayland apps without IBus, Electron apps without text-input | The pointer, or the window's middle | Clipboard and Ctrl+V | Ctrl+V |
| VTE terminals | The text cursor (expected) | Ctrl+Shift+V (bracketed) | Ctrl+Shift+V |

On this machine `QT_IM_MODULE` and `XMODIFIERS` name IBus (2026-10-04),
so Qt apps there probably talk to IBus directly: their cursor is not
known and text goes through the clipboard. Whether an app accepts an
image or files on paste is up to the app.

### Super+V and GNOME's notification list

GNOME's `org.gnome.shell.keybindings toggle-message-tray` opens the
calendar and notification list; its default is `['<Super>v', '<Super>m']`
(on the user's machine it was `[]`, not set by Froonty). Two bindings on
one key cannot both work, and the user wants Super+M for the list. So, in
`features/clipboard/messageTrayKey.js` (the only code that touches it),
with the decisions in `switching.js`:

- **The switcher turns on** (the tab or the switcher switched on in
  Settings, or the first `enable()` that finds it on): GNOME's key loses
  the switcher's shortcuts and gets Super+M (`adjustTrayBinding`). The
  user's previous value is remembered in `clipboard-switcher-tray-backup`
  (JSON `{original, written}`; `original` null means GNOME's default),
  with what Froonty wrote.
- **Changed once.** With that record present, later `enable()`s (each
  screen unlock) change nothing. `disable()` (each screen lock) never
  touches GNOME's key.
- **The user turns the switcher or the tab off:** the previous value comes
  back (or GNOME's default, reset), and the record goes. If the user
  changed GNOME's key in the meantime (it no longer holds what Froonty
  wrote), their newer value stays.
- **The shortcut changes** while on: GNOME's key is worked out again from
  the remembered original, unless the user changed it meanwhile.
- **Froonty turned off or removed** while the switcher is on leaves
  GNOME's key as it is: `disable()` never touches it. Turning the switcher
  off first gives it back. If the switcher was turned off while Froonty
  was off, the next `enable()` gives it back.
- Settings → Clipboard → Switcher says what it changes.

### Private API

`shell/inputMethod.js`, verified against GNOME Shell 50.1 (DESIGN.md
§6.3):

- Public: `Clutter.InputMethod`'s `cursor-location-changed` (a
  `Graphene.Rect` in stage pixels; the on-screen keyboard follows it),
  `commit()`, `content_purpose`; `Main.inputMethod.currentFocus` (the
  Shell's getter); IBusManager's `set-cursor-location` for X11 clients.
- Private: `Main.inputMethod._cursorRect`, kept by the Shell's
  `vfunc_set_cursor_location` while IBus runs. Read only when the signal
  has not given a cursor inside the focused window.
- A cursor rectangle is believed only inside the focused window's frame:
  both sources outlive the field they came from.

## Storage

```
~/.local/share/froonty/clipboard/       0700
├── history.json                        0600, newest first
└── images/<id>.<ext>                   0600
```

- **Why on disk.** GNOME disables extensions on every screen lock, so a
  history kept only in memory would be lost each time.
- **Writes.** Files are written with `g_file_replace` (a temporary file,
  then a rename) with `G_FILE_CREATE_PRIVATE`, one write after another.
- **Damaged files.** A damaged `history.json` gives an empty history.
  Entries are checked field by field, and image names must be plain
  `<id>.<ext>`.
- **Limit and deletes.** Past `clipboard-history-size` (5–500, default 50)
  the oldest entries go, and their images are deleted. "Clear history"
  deletes the file and every image.

## The tab

- **Header:** a status line and "Clear clipboard history".
- **Rows,** newest first, with a type icon (text, image, files, or cut
  files), a small preview, the time it was copied, and a trash button:
  - Text: up to 3 lines of 60 characters.
  - Image: a thumbnail 56 px tall, in proportion and at most 240 px wide,
    loaded in the background by GNOME's texture cache.
  - Files: "Copied 2 items" or "Cut 2 items", then the first names.
- **Wider preview on hover:** up to 12 lines of 80 characters, every file's
  full path (up to 10), or the image's format and size.
- **The current entry:** the one on the clipboard is outlined and reads "On
  the clipboard, ready to paste".
- **Rebuilds:** rows are rebuilt only while the tab is on screen.

## Settings (Settings → Clipboard)

| Key | Default | |
|---|---|---|
| `clipboard-enabled` | false | Show the tab and record history |
| `clipboard-history-size` | 50 | Entries to keep, 5–500 |
| `clipboard-ignored-apps` | see Passwords | Password apps: what is copied there is a password |
| `clipboard-password-minutes` | 5 | How long the latest password is listed, hidden; 0 = never |
| `clipboard-detect-passwords` | true | Treat text that looks like a password as one |
| `clipboard-switcher-enabled` | true | The switcher, while the tab is on |
| `clipboard-switcher-shortcut` | `['<Super>v']` | Its shortcut; needs a modifier (typed in Settings, e.g. `<Super>v`) |
| `clipboard-switcher-tray-backup` | `''` | Internal: GNOME's `toggle-message-tray` before the switcher took Super+V |
| `clipboard-width`, `clipboard-height` | 400, 440 | The island's size while the tab is shown |

## Code

| File | |
|---|---|
| `features/clipboard/entries.js` | Pure: classify a copy, files format, the history list, previews |
| `features/clipboard/store.js` | The history and images on disk (Gio async) |
| `features/clipboard/recorder.js` | Records copies, copies entries back; GNOME parts passed in |
| `features/clipboard/shared.js` | The one recorder per Shell, over St.Clipboard and Meta.Selection |
| `features/clipboard/view.js` | The tab |
| `features/clipboard/switching.js` | Pure: stepping, the pop-up's place, terminals, the `toggle-message-tray` bookkeeping |
| `features/clipboard/messageTrayKey.js` | GNOME's `toggle-message-tray`: changed on, given back off |
| `features/clipboard/switcher.js` | The switcher: keybinding, recorder hold, inserting |
| `features/clipboard/switcherPopup.js` | Its pop-up: the grab, the keys, the preview |
| `shell/inputMethod.js` | GNOME's input method: the text cursor, typing text |
| `features/clipboard/prefs.js` | Settings page |

## Tests

- **`tools/unit/clipboard.test.js`:**
  - Classification: secret hints, password-manager apps, and what wins
    between files, text and images.
  - The files format, duplicates and the limit, and damaged history files.
  - The store's file modes and clearing it.
  - The recorder against a fake clipboard: recording, skipped passwords,
    copying back (also with a password manager focused), the limit
    deleting images, remove and clear, empty and oversized copies.
- **`tools/unit/clipboard-switcher.test.js`:** stepping and wrapping,
  shortcut spellings, GNOME's key without the shortcut and with Super+M,
  the record's on / kept / off / shortcut-change rules (also through
  `MessageTrayKey` with fake settings), terminals, the pop-up's place.
- **Headless (`testClipboardSwitcher`,** with
  `tools/headless-test/textEntry.js`, a GTK 4 window with one text field
  that logs its text and the keys it gets):
  - The keybinding exists only while the tab is on; GNOME's key gets
    Super+M on, survives disable/enable, comes back when the switcher or
    the tab is turned off.
  - Super+V held shows the newest entry below the field's text cursor
    under a grab; V, V, Shift+V, V step 2, 3, 2, 3; releasing Super types
    the entry into the field (no Ctrl+V, clipboard unchanged); Escape
    cancels.
  - An image entry goes on the clipboard and the app gets Ctrl+V.
  - A password shows as dots; an empty history says so.
  - Disabled while held: no grab, pop-up or keybinding left.
- **Headless (`testClipboard`):**
  - Off by default, so nothing listens. Turning it on adds one listener;
    turning it off removes it.
  - Copies made with the tab closed are listed, newest first.
  - The tab's size.
  - A click puts an entry back on the clipboard.
  - The history is in the private data folder.

## Limits of this iteration

- **Files paste into file managers.** They go back in Nautilus's format
  only: `St.Clipboard.set_content` offers one format, so apps that only
  accept `text/uri-list` may not paste them.
- **Rich text** (HTML, RTF) is kept as plain text.
- **No search,** no pinning, and the primary selection is not recorded.
- **Switcher:** the paste keys follow the keyboard layout's `v`; a layout
  without a Latin `v` (Cyrillic alone, for example) cannot send Ctrl+V.
  VS Code's built-in terminal is not told from the editor. Shift still
  held when Super is released turns Ctrl+V into Ctrl+Shift+V.
- **Format checks.** Which formats GNOME 50's Files and other apps actually
  offer should be checked on a real session. The tests use the documented
  formats.
