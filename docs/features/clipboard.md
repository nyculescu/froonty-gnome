# Feature: Clipboard

Status: **first iteration, implemented**, 2026-10-01. Public (in `make
pack` output). **Off by default.**

A history of what you copy or cut: text, images, and file or folder
locations. Click an entry and it is on the clipboard again, ready to be
pasted wherever you want.

## Rules it follows (extensions.gnome.org review guidelines)

- **Declared.** `metadata.json`'s description says that Froonty reads the
  clipboard, what it keeps and where, and that it is off by default. The
  guideline: "Extensions that access the clipboard, with or without user
  interaction, MUST declare it in the description."
- **Opt-in.** `clipboard-enabled` is false until the user turns it on in
  Settings → Clipboard. While it is off, nothing listens to copies.
- **Nothing leaves the computer.** The history is on disk, readable by the
  user only. Nothing is sent or shared.
- **No shortcut.** There is no keyboard shortcut for clipboard data, and
  Froonty never pastes by itself; a click only puts an entry back on the
  clipboard.
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

Froonty does not paste by itself. That would need simulated key
presses, and the review guidelines forbid a default shortcut for
clipboard data. Many apps also paste without formatting with
Ctrl+Shift+V.

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
| `clipboard-width`, `clipboard-height` | 400, 440 | The island's size while the tab is shown |

## Code

| File | |
|---|---|
| `features/clipboard/entries.js` | Pure: classify a copy, files format, the history list, previews |
| `features/clipboard/store.js` | The history and images on disk (Gio async) |
| `features/clipboard/recorder.js` | Records copies, copies entries back; GNOME parts passed in |
| `features/clipboard/shared.js` | The one recorder per Shell, over St.Clipboard and Meta.Selection |
| `features/clipboard/view.js` | The tab |
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
- **Headless:**
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
- **Format checks.** Which formats GNOME 50's Files and other apps actually
  offer should be checked on a real session. The tests use the documented
  formats.
