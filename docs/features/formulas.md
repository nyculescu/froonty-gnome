# Feature: Formulas

Status: **implemented for working-tree installs** (`make install`),
2026-10-04. On by default there. `make pack` leaves it out, with its
settings, CSS and every MathJax file, and fails if any of it reaches the
zip (§7).

The Formulas tab is for writing LaTeX formulas: an editor with a rendered
preview, symbol palettes searchable by name, templates, recent and starred
formulas, and a short guide. A formula is copied as `$…$`, `$$…$$` or as it
is, or put into the open note at its cursor. Formulas are drawn on this
computer by MathJax, running in a helper process; nothing goes online.

Math in Notes (the island and the All notes window) is a later step. The
renderer is built for it: its client is toolkit-free (§4.3), so the Shell
and the settings window can both use it.

## 1. The tab

```
┌ LaTeX editor ─────────────────────────────────┐
└───────────────────────────────────────────────┘
┌ preview (rendered), or MathJax's error ───────┐
└───────────────────────────────────────────────┘
[Display] [☆]        [$…$] [$$…$$] [Raw] [Into note]
Copied as $…$.                                      status line
[Symbols] [Templates] [Recent] [Starred] [Guide]
┌ the chosen panel ─────────────────────────────┐
└───────────────────────────────────────────────┘
```

- **Editor**: monospace, a few lines high, wrapping; it takes the key
  focus when the tab shows. The draft survives the island being rebuilt
  (`ctx.memory`), not a disable (screen lock).
- **Preview**: drawn PREVIEW_DELAY_MS (250 ms) after typing pauses, in the
  island's text colour, at 1.25 × the renderer's 16 px em (times the
  screen's scale). **Display** (`formulas-display`, on by default) previews
  it as a formula on its own line (`$$…$$`: large operators, bounds above
  and below); off, as inside a line of text. A formula MathJax refuses
  shows MathJax's own message instead ("Missing close brace", "Undefined
  control sequence \foo"): those are plain words already. The preview
  scrolls when the formula is larger than its box.
- **Copy**: `$…$`, `$$…$$` and **Raw** (the LaTeX alone) put the formula
  on the clipboard (trimmed). The status line says what happened; it
  clears with the next edit (no timer).
- **Into note** puts `$…$` at the cursor of the note open in the Notes tab
  (replacing a selection there), as if typed, so it saves the same way.
  Without the Notes tab, or with no note open (the Notes tab not opened
  since the island was built, or a read-only note), the status line says
  so. The island stays on the Formulas tab.
- **☆** stars the formula (`formulas-favorites`, newest first, at most
  100).
- **Recent** (`formulas-recent`, at most 20, most recent first): a formula
  is added when copied, put into a note, or when the tab is left while its
  preview shows it. A click puts it back into the editor; × removes it.
  Settings → Formulas → Clear empties the list. Settings keys rather than
  a file: two short string lists that GSettings already writes atomically,
  and the settings window can show them.
- **Symbols**: 14 sections (Greek letters, capitals and variants,
  operators, relations, arrows, sets and logic, accents, brackets, number
  sets and fonts, functions, physics and units, statistics, chemistry),
  each symbol a button with its glyph in plain Unicode text, so the
  palettes need no MathJax; the tooltip shows the LaTeX and the words it is
  found by. The search finds a symbol by its command (`alpha`, `\alpha`),
  a keyword (`approximately`, `real`, `water`) or its glyph (`≈`); Enter
  inserts the first match and returns to the editor.
- **Templates**: fraction, root, n-th root, power and index, sum, integral,
  limit, derivative, partial derivative, matrix, determinant, cases,
  aligned equations, binomial, text.
- **Guide**: thirteen short topics written for Froonty (letters and
  signs, commands, groups, powers, fractions, growing brackets, sums and
  integrals, words, matrices, aligned, physics, chemistry, formulas in a
  note), each with an example that a click puts into the editor.

### Inserting at the cursor (`edit.js`)

Symbols and templates mark their empty places with ‸. The cursor goes to
the first one. With a selection, the selection fills the first place and
the cursor goes to the second (select `a+b`, click Fraction:
`\frac{a+b}{|}`), or after the snippet when it has one place. A command
ending in a letter gets a space when a letter follows (`\alpha x`, not
`\alphax`). Positions count characters (code points), as Clutter.Text's
cursor does.

## 2. Data modules (pure, unit-tested)

| File | |
|---|---|
| `symbols.js` | `SECTIONS` (glyph, LaTeX, keywords) and `searchSymbols()` |
| `templates.js` | `TEMPLATES` |
| `guide.js` | `GUIDE` |
| `edit.js` | `insertSnippet()`, `copyText()`, `pushRecent()`, `toggleFavourite()`, `errorText()` |

Labels, titles and guide texts are English in the data and translated by
the view, as the Writing tab's actions are. A unit test renders every
symbol, template and guide example with the real MathJax (§8), so a
palette entry MathJax does not know fails the build. (`\div` is the
physics package's divergence, so ÷ is not in the palettes.)

## 3. MathJax

MathJax 4 (`@mathjax/src`, Apache-2.0) runs in plain GJS: no browser, no
Node. Measured here, unloaded machine: about 90-150 ms to load, 1-5 ms a
formula after the first (the first is about 20 ms); these are one
machine's numbers, not a promise.

### 3.1 Fetching (`tools/fetch-mathjax.py`, `make mathjax`)

Four official packages from registry.npmjs.org, pinned by version and by
the registry's sha512 integrity, checked before anything is unpacked:

| Package | Version | What for |
|---|---|---|
| `@mathjax/src` | 4.1.3 | TeX input, SVG output, the lite DOM |
| `@mathjax/mathjax-newcm-font` | 4.1.3 | The default font (New Computer Modern), SVG parts |
| `@mathjax/mathjax-mhchem-font-extension` | 4.1.3 | The arrows of `\ce` |
| `mhchemparser` | 4.2.1 | `\ce`'s parser |

They go into `froonty@catalin/third_party/mathjax/` (git-ignored), so
`make install` copies them with the extension. `make install` and `make
devkit` run the fetch when `fetched.json` is missing; `make mathjax` runs
it on demand. It is idempotent (a tree with the pinned versions is left
alone) and atomic (built beside the old tree, swapped in once complete).
Nothing is fetched at runtime.

Only what the renderer imports is kept: the script follows the imports
from the renderer's entry modules (MathJax core, TeX input and the TeX
packages below, SVG output, lite adaptor, HTML handler, the font and the
mhchem extension), plus the folders MathJax loads on demand (the font's
`svg/dynamic`, MathJax's named-entity tables). No source maps, type files,
CommonJS copies, CHTML output, menus or speech. That is 330 modules, 12.5
MB (11 MB of it the font's glyph outlines); on this exFAT drive, with its
128 KB clusters, they take about 56 MB.

GJS has no package resolver, so the script rewrites imports to relative
paths: `#default-font/…` → the font's `mjs/`, `#mhchem/…` →
`mhchemparser/esm/`, and the fonts' `@mathjax/src/mjs/…` → `src/mjs/`.
An import it cannot resolve (`#menu`, `#sre`, a bare package) fails the
fetch, which proves nothing kept imports the menu or speech code. Each
package keeps its `package.json` (its licence field) and its LICENSE file
where it ships one (`@mathjax/src` and `mhchemparser`; the two font
packages ship none, their `package.json` says Apache-2.0).

### 3.2 Rendering (`renderer/mathjax.js`)

- The modules are imported at run time (`import()` of file URIs), so a
  missing tree is an error the helper reports, not a module that fails to
  load.
- TeX packages: base, ams, newcommand, mhchem, physics, braket, cancel,
  cases, mathtools, boldsymbol, upgreek, textmacros, gensymb, units,
  color. Not noundefined: an unknown command stays an error the editor
  can name, instead of a red box.
- `formatError` throws, so the message reaches the caller.
- `mathjax.asyncLoad` maps the font's lazily loaded parts (for example
  double-struck ℝ) to the font folder, and MathJax's relative paths to
  `src/mjs`.
- `MathJaxNewcmFont.addExtension(MathJaxMhchemFontExtension)` before the
  output is made: without it `\ce{A -> B}`'s arrow is an empty box.
- SVG output with a local font cache; `adaptor.serializeXML()` (innerHTML
  is not well-formed XML for librsvg).
- No line breaks inside inline formulas (`linebreaks: {inline: false}`,
  2026-10-05). MathJax 4 splits an inline formula at its break points into
  one `<svg>` per piece, and only the first was drawn: `E=mc^2` came out
  as `E` (15 px wide; 65 px since), `\int_0^1 x\,dx` without its `x\,dx`.
  Display formulas were whole. Found while drawing formulas in notes.
- Size from the viewBox (1/1000 em): width and height in px at the asked
  scale, padded by 0.08 em (glyphs reach slightly past MathJax's box),
  rounded up, and the viewBox widened to match, so nothing is stretched.
  The baseline comes from the viewBox's top (it is MathJax's
  vertical-align, measured from the top).
- Colour: the SVG's `color` (MathJax fills with currentColor), and
  `opacity` for an alpha.
- librsvg (`Rsvg.Handle`) draws it to a GdkPixbuf, saved as PNG.
- Limits: 4000 characters, 4096 px a side, scale 0-16, colours
  `#rrggbb` or `#rrggbbaa` only.

## 4. The helper process

### 4.1 Why a process

The Shell must never wait for MathJax: loading takes a sixth of a second
and a large formula several milliseconds, all on the main thread. The
helper is `gjs -m features/formulas/renderer/helper.js`, `/usr/bin/gjs`
first (another toolchain's `gjs` may come earlier on PATH), then `gjs`.

### 4.2 Protocol: JSON lines

```
→ {"id": 7, "tex": "x^2", "display": false, "color": "#ffffff", "scale": 1}
← {"id": 7, "png": "<base64>", "width": 38, "height": 33, "baseline": 29.2}
← {"id": 7, "error": "Missing close brace", "kind": "tex"}
```

One request per line on stdin, one reply per line on stdout, in request
order. `baseline` is the px from the image's top down to the text
baseline (more than the height for a formula above the baseline, such as
°). `kind`: `tex` (MathJax's message), `unavailable` (MathJax missing or
broken), `request` (not a valid request). MathJax loads on the first
request; the helper ends when stdin closes. `FROONTY_MATHJAX_DIR` names
another tree (tests). Imported as a module it does nothing (it runs only
when it is the program), so the unit tests' parse check can import it.

### 4.3 Client (`renderer/client.js`)

Gio and GLib only, no St or Gtk. One client per process
(`renderer/shared.js`, 2026-10-05): the Formulas tab and the formulas in
notes (docs/features/notes.md, "Formulas") hold the same one, so GNOME
Shell runs at most one helper and the settings window one of its own; it
is made by the first holder and destroyed when the last lets go.

- Started lazily on the first request; stopped after IDLE_MS (60 s)
  without one, and on `destroy()` (the service's `stop()`, which the hub
  calls when the tab is turned off and on every disable): stdin closed,
  SIGTERM, SIGKILL 2 s later if needed (`core/subprocess.js`).
- LRU cache of CACHE_SIZE (200) results by (tex, display, color, scale);
  a TeX error is cached too (the same formula fails the same way). Equal
  requests in flight share one answer.
- Channels: a request on a channel (the preview's) rejects the older one
  at once (`superseded`); the older reply, when it comes, only fills the
  cache. Replies to ids the client no longer waits for are dropped; the
  view also ignores an answer for text that has changed.
- A helper that dies is started again after 200 ms, 1 s, 5 s, then 20 s
  (reset by the next answer); what it was drawing is sent once more, and
  fails (`crashed`) if that helper dies too.
- While requests are out, the helper must answer within TIMEOUT_MS (10 s)
  of the previous answer; otherwise the oldest request fails (`timeout`),
  the helper is stopped and the rest go to a new one.
- Writes to stdin are asynchronous and queued; replies are read with
  `read_line_async`. Nothing blocks the Shell.
- `isMathJaxFetched()` checks for `fetched.json` with `query_info_async`.

## 5. Without MathJax

The preview says: "Formulas are drawn by MathJax, which is not installed
yet. In Froonty's source folder, run “make mathjax”, then “make
install”." The palettes, templates, guide, copy buttons, Into note and
the lists all work. The service asks again on each preview until MathJax
is there, so after `make mathjax` and `make install` the tab draws without
logging out: the helper is a new process each time, and `make install`
replaces the installed copy.

## 6. Code

| File | |
|---|---|
| `features/formulas/index.js` | Descriptor: `formulas-enabled`, 500×560 (`formulas-width`/`-height`) |
| `service.js` | The client while the tab exists, MathJax's presence, recent and starred lists (no St) |
| `view.js` | The tab |
| `wrapLayout.js` | Rows of buttons that wrap (Clutter's FlowLayout gave a several-row section the height of one inside a scroll view) |
| `prefs.js` | Settings → Formulas: show the tab, display style, whether MathJax is installed, Clear recent, size |
| `symbols.js`, `templates.js`, `guide.js`, `edit.js` | Pure data and editing (§2) |
| `renderer/mathjax.js` | MathJax → SVG → PNG (helper only) |
| `renderer/helper.js` | The helper program |
| `renderer/client.js` | The toolkit-free client |
| `renderer/shared.js` | One client per process, held by the tab and the notes |
| `notes/images.js` | Formulas in notes: the pictures' states, sent after a pause in typing (GLib only) |
| `notes/island.js` | Formulas in the island's Notes editor (Pango shapes, a layer of pictures) |
| `notes/window.js` | Formulas in the All notes window's editor (tags, overlays) |
| `tools/fetch-mathjax.py` | The fetch (§3.1) |

Generic, public changes: `ui/hub.js` has `viewOf(id)` (an opened tab's
view, never creating one); `ui/island.js` gives features
`ctx.featureView(id)`; `features/notes/view.js` has `insertText(text)`,
which puts text at the open note's cursor without taking the key focus.

Settings keys: `formulas-enabled` (true), `formulas-display` (true),
`formulas-recent`, `formulas-favorites` (string lists), `formulas-width`
/ `formulas-height` (500 / 560, 360-960 / 320-720; the resize grip works).

Icon: the theme's `accessories-calculator-symbolic` (Adwaita's legacy set,
Yaru).

## 7. The public build

- `features/localFeatures.js` and `features/localPrefs.js` list it.
- `tools/pack-public.sh` deletes `features/formulas` and
  `third_party/mathjax` from the staged copy and strips the
  `local:begin formulas` CSS block; `strip-local-schema.py` removes the
  `formulas-*` keys (and requires `formulas-enabled`); `prune.py` knows
  the prefix, the `froonty-formulas` classes and the folder.
- `check_zip.py` fails on any file under `features/formulas/` or
  `third_party/`, and on `features/formulas`, `formulas-enabled`,
  `froonty-formulas`, `MathJax` or `mathjax` anywhere in the zip.
- The Makefile leaves `third_party` out of `--extra-source`.
- Formulas in notes: the Notes modules' `local:begin notes-math` blocks
  are stripped (docs/features/notes.md, "Public build"), and
  `check_zip.py` fails on `formulas/notes`, `mathSpans`,
  `mathMarkdownSpans`, `IslandMath`, `WindowMath` or `notes-math`.
- `tools/unit/modules-parse.test.js` skips `third_party/` (vendored code;
  importing it would run it).

## 8. Tests

- `tools/unit/formulas-data.test.js`: palettes and search, templates,
  guide, insertion at the cursor, copy formats, the lists.
- `tools/unit/formulas-client.test.js`: the client against a stand-in
  helper (`fakeMathHelper.js`, same protocol, no MathJax): cache and LRU,
  shared requests, cached errors, channels, a helper dying once or every
  time, the time limit, the idle stop, `destroy()`, a helper that cannot
  start; the service's lists in a memory-backed copy of the real schema.
- `tools/unit/formulas-renderer.test.js` (skipped, saying so, without
  MathJax): geometry, PNG size and baseline, display vs inline, MathJax's
  messages, an inline formula drawn whole, the mhchem arrow, lazily
  loaded glyphs, every palette entry,
  template and guide example, the protocol through the client, the
  missing-tree reply, speed.
- `tools/pack-public/test_pack_public.py`: the leak guard on MathJax and
  Formulas files and strings, the CSS prune, the real pack.
- Headless (`FROONTY_TEST_ONLY=testFormulas`): the tab opens at its size
  with the editor focused, no helper before the first formula, typing
  renders through one helper process, MathJax's errors, palette search
  and Enter, a symbol click, a template's slot, copy and the recent list,
  the star, Into note (and its save), Notes off, the missing-MathJax
  message, and disable: the helper gone and the Shell's footprint as
  before. The 25-cycle lifecycle check runs with the tab on.

## 9. Not verified

- Fractional scaling: with the monitor framebuffer scaled, the Shell's
  scale factor is 1 and the preview is drawn at 1×, so it may look soft.
- The palettes' glyphs depend on the fonts installed; a missing glyph
  shows as the font's fallback box (the button still inserts its LaTeX).
- MathJax's own messages are English.
