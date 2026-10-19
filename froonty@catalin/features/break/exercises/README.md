# The Break tab's exercises: catalog, pictures, ideas

What the Break tab's exercise cards, routines and ideas are made of, and
where each part comes from:

| Part | File | Source | Licence |
|---|---|---|---|
| The moves: titles, texts, tags | `catalog.json` | Froonty's own words | GPL-3.0-or-later |
| Moving pictures for most moves | `third_party/break-art/` (not in the repository) | WorkoutLabs, fetched by `tools/fetch-break-art.py` (`make break-art`) | All rights reserved by WorkoutLabs; on the owner's computer only, never committed or packed |
| Eye and breathing exercises | `features/break/drawn.js` | Drawn by Froonty | GPL-3.0-or-later |
| Fallback pictures | `images/`, `exercises.json` | Workrave (below) | GPL-3.0-or-later (inferred) |
| Break ideas | `ideas.json`, `IDEAS-LICENSE.md` | Stretchly, Safe Eyes (below) | BSD-2-Clause, GPL-3.0-or-later |

## The catalog

`catalog.json` (format 2) lists every move: `id`, `title`, `text`
(Froonty's own words, no health claims), `kind` (stretch, move, eyes,
breath), `region` (for routines that spread over the body), `posture`
(seated: can be done sitting; standing: needs standing up), `discreet`
(can be done unnoticed in a video call), `sides`, `seconds`, and `art`:
where its picture comes from, in this order of preference: `workoutlabs`
(the fetched frames), `drawn` (a kind in `drawnKinds.js`), `workrave` (an
exercise of `exercises.json`). A move with none shows a pictogram.

## WorkoutLabs' pictures (fetched, not here)

`tools/break-art/workoutlabs.json` (in Froonty's repository) lists one
link per move, checked on 2026-10-16: an animation (GIF) or a still with
several poses side by side (SVG). `tools/fetch-break-art.py` downloads
them to `third_party/break-art/` and turns each into square PNG frames:
an animation's repeating cycle of poses, a still's poses cut apart. The
pictures are WorkoutLabs' (<https://workoutlabs.com/exercise-guide/>),
all rights reserved; they stay on the computer that fetched them. Without
them the cards show Workrave's pictures, or none.

## Workrave's exercises (the fallback pictures)

The Break tab's exercise cards use the pictures, titles and descriptions of
**Workrave**'s exercises.

- **Source:** <https://github.com/rcaelers/workrave>, commit
  `f3936169a86c697f08415adc3baf965425a29dff` (2026-09-26), file
  `ui/data/exercises/exercises.xml.in` and the pictures next to it.
- **Copyright:** the Workrave authors. Workrave's `AUTHORS` lists Rob
  Caelers, Raymond Penners and Ray Satiro as its core developers; it credits
  no illustrator.
- **Licence: treated as GPL-3.0-or-later.** This is an inference, not a
  statement by the Workrave authors (they may be asked):
  - Workrave's `COPYING` is the GNU GPL version 3, and its source headers say
    "either version 3 of the License, or (at your option) any later version";
  - its `LICENSES.md` lists the files under other licences, and none of these
    pictures or the exercise file is among them.
- Some pictures show Workrave's sheep mascot.

### What is here

- `images/`: the 18 pictures the 10 active exercises use, **byte-identical**
  copies of Workrave's PNG files (250 × 250, rendered colour pictures):
  `backward-shoulder-stretch.png`, `chair-pushup-1.png`, `chair-pushup-2.png`,
  `depth-focus-1.png`, `depth-focus-2.png`, `eye-darkness.png`,
  `finger-stretch-1.png`, `finger-stretch-2.png`, `monitor-border-1.png` to
  `monitor-border-4.png`, `neck-tilt-stretch-1.png`, `neck-tilt-stretch-2.png`,
  `rotate-arm.png`, `shoulder-arm-stretch.png`, `turn-head-1.png`,
  `turn-head-2.png`.
- `exercises.json`: converted from `exercises.xml.in` by
  `tools/import-workrave-exercises.py` (in Froonty's repository). Titles and
  descriptions are Workrave's English text, verbatim apart from whitespace;
  frame times and mirroring are Workrave's. Only the active exercises are
  converted (the ones not commented out in Workrave's file).

### Left out

- The 6 exercises Workrave has commented out (wrist and lower arm desk
  stretch, relax the eyes, fist roll, move the shoulder blades, stretch your
  back, neck stretch), and the 3 pictures only they use (`fist-roll-1.png`,
  `fist-roll-2.png`, `wrist-lower-arm-desk-stretch-1.png`).
- Workrave's `.xcf` sources and its translations (`po/`).

Froonty's own words on the cards (how to stretch safely, "comfort only" for
the eye exercises) are Froonty's, not Workrave's.

## Break ideas: from Stretchly and Safe Eyes

The Break tab's one-line break ideas ("Another idea") are texts from two
other break reminders:

- **Stretchly:** <https://github.com/hovancik/stretchly>, commit
  `3cb3af2d480c352ed903007426fd86e1226bd6fc` (2026-10-15), files
  `app/utils/defaultMicrobreakIdeas.js` (51 microbreak ideas) and
  `app/utils/defaultBreakIdeas.js` (36 break ideas, each a title and a
  paragraph). **BSD-2-Clause**, "Copyright (c) 2016-, Jan Hovancik". Its
  notice is in `IDEAS-LICENSE.md`, which must ship with `ideas.json`.
- **Safe Eyes:** <https://github.com/slgobinath/safeeyes>, commit
  `4637d80ae59ab1fc0d980431ebd95fe63a60d5df` (2026-10-13), file
  `safeeyes/config/safeeyes.json` (the English names of 13 short and 6 long
  breaks). **GPL-3.0-or-later**, like Froonty, by Gobinath Loganathan and
  the Safe Eyes contributors.

### What is here

- `ideas.json`, converted by `tools/import-break-ideas.py` (in Froonty's
  repository). The script reads both projects' files as text and keeps only
  the ideas its KEEP/DROP table names. A rerun on the same commits gives the
  same file, and a new or changed upstream idea stops the script until
  someone decides it.
  - `short`: 43 ideas (35 from Stretchly, 8 from Safe Eyes) for eye breaks
    and short pauses, one line each, at most 160 characters.
  - `long`: 10 ideas for movement breaks and long rests: 6 from Stretchly,
    with Stretchly's titles, and 4 from Safe Eyes, which have no title.
  - Every idea names its `source`.
- `IDEAS-LICENSE.md`: Stretchly's BSD-2-Clause notice in full, and Safe
  Eyes' licence.
- The texts are upstream's English with whitespace normalised. 16 have
  small fixes, each listed in the script's `FIXES` (upstream next to kept):
  a full stop on Safe Eyes' labels, a missing "a", "the" or "your", and "in
  your seat" for "at your seat".

### Left out: 53 of 106

Froonty's rule for these texts is the tab's own: reminders only, no health
claims. The script names the reason for each dropped idea.

- **Claims** (21, Stretchly): a health, productivity or research benefit
  ("Research studies suggest", "increases productivity", "burns calories",
  "helps your focus", "to get some relief").
- **Advice** (4, Stretchly): medical, dietary or exercise advice. These are
  natural light for the eyes, eating fruit, a minutes-per-minutes rule, and
  a coping technique offered for feeling overwhelmed.
- **Not at hand** (4, Stretchly): a stability ball or standing desk, a
  workout app, socks or a rubber ball, the commute.
- **Another author's text** (12, Stretchly): lines found word for word, or
  nearly, in pages that Stretchly's README credits. These pages are Stanford
  EH&S's microbreaks page, WebMD's carpal tunnel exercises, OnHealth's
  (WebMD's) eye exercises, Len Kravitz's University of New Mexico article
  on sitting, and Ron Padgett's poem "How to Be Perfect". Stretchly's licence
  cannot cover them. A few of the dropped claims are such text too.
- **Duplicates** (12: 5 Stretchly, 7 Safe Eyes): the same idea as a kept
  one, keeping the clearer wording. The script names the idea that was
  kept. Duplicates are looked for within each list, so a reminder can
  appear once in `short` and once in `long`.
- No idea was about drugs, alcohol or smoking.

### Not checked

- The kept Stretchly texts were compared only with those credited pages
  that could be fetched live or from the Wayback Machine on 2026-10-16. The
  archived copies may differ from the pages Stretchly used, and sources
  Stretchly does not credit were not searched. "Coffee break" takes Kravitz's
  idea in Stretchly's own words, so it is kept.
- Safe Eyes' texts were not checked against outside sources.
- The licences are taken as the projects declare them. Neither project was
  asked.
