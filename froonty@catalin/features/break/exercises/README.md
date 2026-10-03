# Exercise pictures and texts: from Workrave

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

## What is here

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

## Left out

- The 6 exercises Workrave has commented out (wrist and lower arm desk
  stretch, relax the eyes, fist roll, move the shoulder blades, stretch your
  back, neck stretch), and the 3 pictures only they use (`fist-roll-1.png`,
  `fist-roll-2.png`, `wrist-lower-arm-desk-stretch-1.png`).
- Workrave's `.xcf` sources and its translations (`po/`).

Froonty's own words on the cards (how to stretch safely, "comfort only" for
the eye exercises) are Froonty's, not Workrave's.
