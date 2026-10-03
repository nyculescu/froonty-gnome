# Feature: Break

> **Not medical advice.** The Break tab gives reminders only. Its timings
> are guidance or Froonty's own conventions, mostly based on expert opinion
> or weak evidence (see [Evidence](#evidence)). If you have pain, an injury,
> circulation problems or another condition, ask a clinician.

Status: **first iteration, implemented**, 2026-10-02. Public (in `make
pack` output). **Off by default.** GNOME Shell 50 only.

GNOME's own break reminders (Settings → Wellbeing), shown and driven from
the island: a cue on the collapsed pill when a break is near or due, and a
tab with Take, Delay and Skip, the next breaks, an exercise card, a
sit/stand tracker and today's totals.

## What GNOME does and what Froonty adds

GNOME Shell 48 added a break engine (`misc/breakManager.js`, available as
`Main.breakManager`). It times **eye breaks** (default every 20 min, for
20 s) and **movement breaks** (every 30 min, for 5 min) from real keyboard
and pointer activity, and can dim or lock the screen and play a sound. It
is off until the user turns it on (`org.gnome.desktop.break-reminders
selected-breaks`). Froonty does **not** time breaks itself (DESIGN.md §2,
"never duplicate"):

| GNOME (reused) | Froonty (added) |
|---|---|
| Break timing, Take/Delay/Skip, dimming, locking, the sound | The pill's cue, the Break tab, urgency levels 0-4, a suggested length |
| `org.gnome.desktop.break-reminders`, the keys Settings → Wellbeing uses (some only Froonty's settings show) | Exercise cards (Workrave's pictures), the sit/stand tracker, a daily record |
| Mutter's idle monitor | A ledger of when you were at the computer or away (no keys, no counts, no app names) |

The tab never turns GNOME's breaks on by itself: while they are off it
shows one offer, **"Turn on eye and movement breaks"**, which writes
`selected-breaks` on the click. Settings → Break has a switch per type.

## Who reminds: the island, not GNOME's notifications

With **"Remind me in the island instead of GNOME's notifications"** on
(the default, `break-pill-reminders`), GNOME keeps timing, and its own
break notifications are off while the island is shown. GNOME has one clean
switch for that: its per-app notification setting for the Wellbeing panel,

    org.gnome.desktop.notifications.application  enable = false
    at /org/gnome/desktop/notifications/application/gnome-wellbeing-panel/

Verified in a headless GNOME Shell 50.1: it hides every break notification
(no banner, no list entry, no unread dot) and leaves the engine alone.
GNOME's per-type `notify*` keys alone do **not** hide them (a "notify off"
break is still listed, at low urgency). Froonty also turns off a type's
`countdown` ("Break in N s" overlay), only if it is on.

- **When:** only while the Break tab is on, the pill reminders are on, the
  cue is not "Off", GNOME's breaks are on, and the island exists. Waiting at
  login, or with "Show island" off, GNOME reminds.
- **Restored exactly:** Froonty records each key it changed in
  `break-gnome-saved` (its earlier value, or "none", and the value Froonty
  set). It gives them back when any of those conditions ends, and when
  Froonty is turned off. A key the user changed since is left alone.
- **Under the lock screen it stays off** (DESIGN.md §2, principle 5's second
  exception): GNOME disables extensions on every lock, and restoring there
  would put break notifications on the lock screen and make them flicker on
  every unlock.
- **Caveat:** GNOME's daily screen-time limit alerts use the same switch;
  the tab and Settings say so when that limit is on.
- **Locked by an administrator:** nothing is written, and the tab says you
  may be reminded twice.
- **If Froonty is removed while it is not running** (so it cannot restore),
  GNOME Settings has no switch for this; run:

      gsettings reset org.gnome.desktop.notifications.application:/org/gnome/desktop/notifications/application/gnome-wellbeing-panel/ enable

## The pill's cue

The island **never opens by itself** and never takes the keyboard: a cue
appears after the time, and a click on the pill opens the Break tab.

| Level | When (first match) | Cue, "Icon" (default) | "Icon and minutes" |
|---|---|---|---|
| 4 Urgent (Froonty's rule) | a break overdue by a whole interval, or 2 h at the screen without a 15-min pause | wide orange badge with "!" | "+31m", or "2h" |
| 3 Overdue | overdue 60 s or more; or due after 2 skips or delays in a row (Froonty's rule) | round yellow badge | "+3m" |
| 2 Due | due, under 60 s | bare white icon | "now" |
| posture | time to stand up or sit down | stand or sit pictogram | (icon only) |
| 1 Soon | due within 2 min (for eye breaks this is Froonty's: GNOME's eye "soon" notice is off by default) | icon in a ring | "2m" |
| 0 Fine | otherwise | nothing | dim icon, "25m" |

- **Never colour alone:** each level has its own shape, and the pill's
  accessible name says it ("Movement break overdue by 3 minutes").
- **Due comes from GNOME's times, not its state:** GNOME reports `IN_BREAK`
  while you type after an interrupted break, and `IDLE` while you work with
  a break still owed (verified in GNOME Shell 50.1).
- The pill widens only when the cue does not fit; the time stays centred
  (an invisible twin of the cue on the other side).

## Take, Delay and Skip

The buttons call GNOME's own methods, and only the ones that work now are
shown (GNOME 50.1's real behaviour, verified in a headless Shell):

| GNOME's state while a break is due | Take | Delay | Skip |
|---|---|---|---|
| Due (`BREAK_DUE`) | yes | yes* | yes |
| Back early from a break (`IN_BREAK`), or working with a break owed (`IDLE`) | no | yes* | yes |
| Due under 1 s ago (GNOME lags 0.2-0.9 s) | no | yes* | yes |
| Nothing due, or GNOME's breaks off | no | no | no |

- **Take** only asks GNOME to dim (or lock, if that is on); the break counts
  once you have been away for its whole length in one go. GNOME times it
  from when it was due. Take collapses the island.
- **Delay** moves each due type by its `delay-seconds`. *Hidden once a break
  is overdue by more than that, and optionally after `break-max-delays` in a
  row (GNOME's own notification, when GNOME reminds, keeps its button).
- **Skip** ends every due type now ("Skip both" when both are due). In
  GNOME's own notifications a due break has no Skip button: closing the
  notification skips it.
- A break counts as **taken** when GNOME credits it: one unbroken away of at
  least the break's length (GNOME measures from 10 s before its idle watch
  fires). A pause shorter than that, even after GNOME's own "break
  finished", is not a break.
- Skips and delays made in GNOME's notification (when GNOME reminds) are
  recognised from GNOME's times and counted too.

## Suggested length (a labelled heuristic)

- Eyes: GNOME's length; after 2 skipped or delayed eye breaks in a row, "or
  take a movement break instead".
- Movement: GNOME's length, plus time owed from skipped movement breaks only
  with `break-make-up-time` on (off by default), at most doubling it.
- Long rest: 15 min ("Froonty's rule, after the AOA's 15 min after 2 h;
  expert opinion").
- Froonty never rewrites GNOME's length; it only suggests.

## Exercises

Workrave's 10 active exercises: 7 stretches and 3 eye exercises
(`features/break/exercises/`, with an attribution README).

- A **stretch card** shows when a movement break is soon or due ("Another"
  goes to the next of the 7; the next one also comes after a movement break
  is taken), or on "Show a stretch".
- When an **eye break** is due: "Look at something at least 6 m (20 ft) away
  for 20 s, and blink", with the 3 eye exercises folded away, labelled
  "comfort only" (no good evidence they prevent eye problems).
- **Still pictures**, all in one row with their times ("10 s, other side"
  for a mirrored one). No frame timer: an animation would need a DESIGN
  §2.2 exception (a per-frame one-shot timer only while the card is on
  screen, with Workrave's fixed frame times as the reason for having no
  setting).
- Each card has Froonty's own safety line ("Stretch gently to mild tension,
  hold still about 10-20 s, don't bounce. Repeat a few times each side.
  Stop if anything hurts."), a paraphrase, not CCOHS's or the NHS's text
  (CCOHS allows no excerpts without approval). Settings → Break links to
  both. Eye cards say "Comfort only" instead of the stretching advice.
- **Licence:** the pictures and texts are Workrave's (copyright the Workrave
  authors), treated as **GPL-3.0-or-later**. That is an inference: Workrave's
  `COPYING` is GPLv3, its source headers say "or (at your option) any later
  version", and its `LICENSES.md` lists no exception for them; the authors
  may be asked. Only the 18 pictures the active exercises use are shipped
  (234,482 bytes), byte-identical; no unused picture, `.xcf` or translation.

## Sit/stand (a desk with a manual lever)

- **Input:** a Sitting/Standing switch in the tab, and the optional panic
  button **"Sitting or standing"** (Settings → Panic buttons).
- **Standing counts only while you use the computer**, from the same ledger.
  An away of 2 min or more restarts the switch reminder; an hour away and
  you are "sitting" again.
- **Target:** 2 h a day by default (`posture-target-minutes`), the minimum.
  **Build-up** (on by default, can be switched off): +15 min after you met
  the target on 4 of your last 5 working days (an hour or more at the
  computer), at most once a week, up to 4 h. It never steps down by itself;
  Settings → Break → "Reset build-up" does.
- **"Just the minimum today"** in the tab keeps today at 2 h, whatever the
  build-up ("bare minimum"); such days do not count toward a step.
- **Reminders** (a cue, once, until you switch, choose "Not now" or step
  away): stand after 45 min sitting, sit after 15 min standing; no "stand
  up" once today's target is met, so it never pushes past the minimum.
- Next to the target: "2 h is a starting minimum from a 2015 expert
  statement; light walking counts." Settings adds the evidence caveats.

## History and storage

- **Today:** time at the computer, the longest stretch without a real
  break, breaks taken, skipped and delayed per type, long rests, standing
  against the target. **Last 7 days** fold out; **"Forget history…"** asks
  first, then deletes the history and today's totals (posture and the
  build-up stay).
- **Files**, under `~/.local/share/froonty/break/` (0700), each 0600, written
  atomically through one queue:
  - `state.json` (about 3 KB): when it was saved, GNOME Shell's process id,
    GNOME's last break ends, the ledger (accounted-until, stretch start,
    screen time since the last long rest, an idle period open at the time),
    skip/delay streaks and owed time, the posture, the build-up's last step,
    the exercise index, today's record;
  - `history.json`: one record per day with any activity, newest first,
    kept `break-history-days` (98, GNOME's own 14 weeks).
- **Why a file:** GNOME disables extensions on every screen lock, and the
  day's totals must survive reboots. A lock is counted as away; in the same
  Shell process, a break GNOME credited while the screen was locked is
  counted as taken. After a new login GNOME restarts its own counting.
- Nothing else is recorded: no keys, no input counts, no app names.

## Settings (Settings → Break)

| Key | Default | |
|---|---|---|
| `break-enabled` | false | The tab, and the tracking behind it |
| `break-pill-reminders` | true | Remind in the island instead of GNOME's notifications |
| `break-pill-cue` | `icon` | `off`, `icon`, `icon-and-time` |
| `break-escalate-after-skips` | 2 | Overdue at once after this many skips or delays in a row (0 never) |
| `break-max-delays` | 0 | Delays in a row before the tab hides Delay (0 no limit) |
| `break-make-up-time` | false | Owed movement time in the suggested length |
| `break-long-rest`, `-after-minutes`, `-minutes` | true, 120, 15 | The long rest |
| `break-exercises` | true | Exercise cards |
| `break-history-days` | 98 | Days of history |
| `break-width`, `break-height` | 440, 480 | The island's size while the tab is shown |
| `posture-enabled` | false | The sit/stand tracker |
| `posture-target-minutes` | 120 | The daily minimum |
| `posture-buildup`, `-step-minutes`, `-ceiling-minutes` | true, 15, 240 | The build-up |
| `posture-reminders`, `posture-sit-minutes`, `posture-stand-minutes` | true, 45, 15 | Switch reminders |
| `break-gnome-saved`, `posture-buildup-target` | | Internal: what Froonty changed in GNOME; where the build-up is |

GNOME's own keys, per type, in fold-outs: every (min), length, delay by,
dim the screen, lock the screen, sound when a break ends; and a button to
open Settings → Wellbeing. Settings → Break writes them only when a row is
changed.

## Rules it follows

- **GNOME settings written, all on the user's click or consent:**
  `selected-breaks` (the offer, the Settings switches); the per-type keys
  (Settings); the Wellbeing `enable` and the per-type `countdown` (the
  reminders choice above, restored as described).
- **Private Shell APIs** (DESIGN.md §6.3): `Main.breakManager` (its getters,
  methods and six signals) and its private `_breakLastEnd` map (each type's
  last break end; the public API gives only the earliest next break).
  Without the map the tab shows only "Next break: … at …".
- **Watches:** one 10 s uninhibitable Mutter idle watch (GNOME's own rule),
  plus one one-shot active watch while idle. GNOME's engine never says when
  an idle period starts, hence Froonty's own watch (DESIGN.md §2.1).
- **Timers:** at most one one-shot timer (DESIGN.md §2.2), armed at the next
  moment something shown changes by itself: 2 min before a break, at it,
  60 s and one interval after it, the 2-h long-rest crossing, the posture
  reminder, midnight. GNOME emits nothing at those moments; they come from
  the user's own settings, so there is no interval to configure. The top
  bar's WallClock minute tick is followed only to spot a suspend that did
  not lock.
- **Files:** the two 0600 files above.
- **Not used:** no network, no subprocess, no notification of Froonty's
  own, no Shell code patched, no CRITICAL urgency.
- **Third-party content:** Workrave's GPL-3.0-or-later pictures and texts,
  with a README.
- **No health claims** (Froonty's policy, not a review rule); "not medical
  advice" in the tab, Settings and here.
- Kept small and explainable (the review guidelines reject AI-generated
  code that is not understood).

## Code

| File | |
|---|---|
| `shell/breakManager.js` | The only place reading `Main.breakManager` |
| `shell/breakEngine.js` | Wrapper over GNOME's BreakManager (Shell-free): signals, `read()`, delay/skip/take, own-action marker |
| `features/break/engine.js` | Pure rules: levels, actions, suggested length, classifying GNOME's time changes, the next boundary, the cue |
| `features/break/ledger.js` | Pure: at the computer or away, day totals, midnights, suspend drift, history |
| `features/break/plan.js` | Pure: the standing target and its build-up |
| `features/break/words.js` | Every user-facing string for levels, actions, cue and status |
| `features/break/service.js` | The service: GNOME's engine, the ledger, posture, plan, store; one timer |
| `features/break/shared.js` | One service per Shell, wired to Mutter, the WallClock and GLib; the pill cue source |
| `features/break/gnomeSettings.js`, `takeover.js` | GNOME's settings; GNOME's notifications off and back |
| `features/break/store.js`, `core/privateFile.js` | The two files |
| `features/break/exercises.js`, `card.js`, `exercises/` | Workrave's exercises; the card |
| `features/break/view.js`, `prefs.js`, `index.js`, `icons.js` | The tab, Settings → Break, the descriptor, the pictograms |
| `panic/sitStand.js` | The "Sitting or standing" panic button |
| `ui/island.js`, `ui/collapsedView.js` | The pill's cue (any feature with a `pillCue`) |
| `tools/import-workrave-exercises.py` | The one-off converter (not packed) |

## Tests

- **Unit** (`make unit`, plain gjs): `break-gnome.test.js` runs GNOME's
  real BreakManager, extracted from the installed Shell at test time
  (`tools/unit/gnomeBreakManager.js`; nothing of GNOME's is committed), on a
  fake clock and idle monitor, through the scenarios the prototype recorded
  in a real Shell: Take/Delay/Skip with nothing due, Delay when due and when
  too late, input during a break, working while GNOME says IDLE, short and
  long pauses, a break falling due while away, settings changes, both types
  at once, a late stop, Delay after an interrupted break, both kinds of
  skip, both orders of Mutter's watches, a lock gap in the same and a new
  Shell, and the fallback without the private map. Plus pure tests of the
  rules, the ledger, the plan, the takeover (in-memory GSettings, asserted),
  the store and the exercises.
- **Headless** (`testBreak` in `tools/headless-test/checks.js`, both session
  modes): off by default; the offer; GNOME's breaks turned on through it; a
  due cue with no expansion and no grab, the time still centred, no GNOME
  notification or dot; the pill opening the tab; Delay, Skip, escalation to
  level 3; Take dimming and a 12 s away counted; the sit/stand switch by
  pointer and keyboard; the panic button; the state file's modes; a lock
  keeping GNOME's notifications off and the counts; turning Froonty, the
  island and the reminders off giving GNOME's notifications back (and the
  dots); the exercise card with a pixel check of the mirrored picture; the
  tab's layout at 440 × 480. The lifecycle test cycles Froonty 25 times with
  the tab on and compares handler counts on `Main.breakManager` and the
  Wellbeing switch.

## Evidence

As collected for the proposal (2026-10-02) and corrected by its review;
the links are those recorded there. The sources were not all re-read for
this note, so the certainty column is that review's reading; check a
source before relying on a figure.

| Claim | How Froonty uses it | Source | Certainty |
|---|---|---|---|
| Sit less; any activity helps; no evidence-based break schedule | The overall message; "no proven number" | WHO guidelines, Bull et al., *BJSM* 2020 | Strong recommendation (moderate certainty for mortality); "insufficient evidence" on break frequency and length |
| Work-break schedules for musculoskeletal symptoms | No injury-prevention claim | Cochrane, Luger et al. 2025, DOI 10.1002/14651858.CD012886.pub3: 9 RCTs, 626 workers; no trial of break length | Very low |
| Short walks lower blood glucose after meals | Movement-break context | Dunstan et al., *Diabetes Care* 2012 (n=19, overweight or obese adults aged 45-65); Duran et al., *MSSE* 2023 (n=11; all four schedules lowered systolic pressure, only 5 min every 30 min lowered glucose); Loh et al., *Sports Med* 2020 (meta-analysis of acute lab trials) | Weak (single trials); Loh: not graded, acute lab trials |
| Long unbroken sitting and mortality | Context only | Diaz et al., *Ann Intern Med* 2017 (n=7,985) | Observational |
| Micro-breaks help a little | Short breaks are worth it | Albulescu et al., *PLOS ONE* 2022 | Weak to moderate, small effects |
| About 5 min an hour away from the screen | Framing of movement breaks | OSHA computer workstations eTool; HSE ("5 to 10 minutes every hour is better than 20 minutes every 2 hours", given as an example; no legal requirement); CCOHS | Expert opinion |
| 20-20-20 for the eyes | The eye-break line | AOA; AAO "What Is Eye Strain?" (2023) | Expert opinion |
| 15 min after 2 h | Level 4, the long rest | AOA | Expert opinion |
| Treatments for computer eye strain | No eye-health claim; "comfort only" | Singh et al., *Ophthalmology* 2022 (abstract only) | Low |
| Standing: at least 2 h a day, eventually 4 h (standing and light activity) | The 2 h minimum; the 4 h ceiling | Buckley et al., *BJSM* 2015, expert statement (grades B-C; D for the discomfort advice). One author had commercial links to sit-stand desks, not declared at first (University of Sydney news, 2017); Chau et al., "Overselling Sit-Stand Desks", *Health Communication* 2018 (seen only as a listing) | Expert statement, with a conflict of interest |
| Sit-stand desks reduce sitting | "Less sitting", not "healthier" | Cochrane, Shrestha et al. 2018: about 100 min/day (95% CI 84-116) up to 3 months, 57 min (95% CI 15-99) at 3-12 months | Low |
| Too much standing has costs | Caveats next to the target | Ahmadi et al., *IJE* 2024 (UK Biobank, n=83,013, mean age 61, wrist accelerometer, total daily standing: more than 2 h/day linked with more orthostatic circulatory disease; applying it to desk standing is an extrapolation); Coenen et al., *BJSM* 2018 (more than 4 h/workday of occupational standing and low-back symptoms, OR 1.31; 45 of 50 studies cross-sectional; standing occupations, not desk users; "tentative"); Baker et al., *Ergonomics* 2018 (n=20, lab) | Observational / tentative / weak |
| How often to switch | 45/15 default | CCOHS sit/stand desks ("alternate your position as needed"); Cornell 20-8-2 (cites no study) | Expert opinion |
| How to stretch safely | The card's own safety line (paraphrased) | CCOHS office stretching; NHS sitting exercises (a routine for people who have not exercised for a while, at least twice a week; not desk micro-breaks) | Guidance |
| Stretching prevents problems | Not claimed | da Costa & Vieira 2008; Hecker & Hess 2003; Chen et al., *Phys Ther* 2018 (strengthening, people with neck pain) | Weak; moderate for strengthening |
| When a break is "urgent" | Levels 3-4 are labelled Froonty's rules | No source defines it | None |

Links: WHO <https://pmc.ncbi.nlm.nih.gov/articles/PMC7719906/>; Buckley
<https://europepmc.org/article/MED/26034192>; Shrestha
<https://www.cochrane.org/CD010912/OCCHEALTH_workplace-interventions-reducing-sitting-work>;
Ahmadi <https://europepmc.org/article/MED/39412356>; Coenen
<https://europepmc.org/article/MED/27884862>; AOA
<https://www.aoa.org/healthy-eyes/eye-and-vision-conditions/computer-vision-syndrome>;
HSE <https://www.hse.gov.uk/msd/dse/work-routine.htm>; OSHA
<https://www.osha.gov/etools/computer-workstations/work-process>; CCOHS
<https://www.ccohs.ca/oshanswers/ergonomics/office/stretching.html> and
<https://www.ccohs.ca/oshanswers/ergonomics/office/sit_stand_desk.html>; NHS
<https://www.nhs.uk/live-well/exercise/strength-and-flexibility-exercises/sitting-exercises/>;
University of Sydney
<https://www.sydney.edu.au/news-opinion/news/2017/09/19/how-the-media-oversold-standing-desks-as-a-fix-for-inactivity-at.html>.

## Limits of this iteration

- **Input is activity.** A video or a call with no input counts as away,
  as it does for GNOME (both watches ignore "keep awake" inhibitors).
- `Main.breakManager` and its private map are GNOME internals; GNOME 51 may
  change them (the tab then falls back to the next break only, or says
  GNOME's breaks are not available).
- If Froonty is removed or fails to load while it has GNOME's notifications
  off, nothing restores them: use the `gsettings reset` line above.
- When GNOME reminds, a skip made by closing GNOME's notification while
  GNOME is in its "IDLE while working" state could be counted as taken.
- Not verified on a real (non-headless) lock, suspend or logout; that
  extensions are disabled with `Main.sessionMode.isLocked` true comes from
  reading GNOME's code, and the headless test simulates it.
- That St draws a mirrored picture (`scale_x = -1`) correctly is checked by
  pixels in the headless test.
- `org.gnome.Settings-wellbeing-symbolic` (the tab's icon) may be missing
  outside Ubuntu; `alarm-symbolic` stands in.
