# Feature: Break

> **Not medical advice.** The Break tab gives reminders only. Its timings
> are guidance or Froonty's own conventions, mostly based on expert opinion
> or weak evidence (see [Evidence](#evidence)). If you have pain, an injury,
> circulation problems or another condition, ask a clinician.

Status: **first iteration, implemented**, 2026-10-02; **second iteration**
(busy, pause and working hours, media, move bar and workout days, a
pause in typing, skip limit and reasons, moving pictures, routines, drawn
eye and breathing exercises, ideas, a 14-week chart), 2026-10-16, branch
`break-v2`, not yet tried on a real session. **Off by default.** GNOME
Shell 50 only.

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
| `org.gnome.desktop.break-reminders`, the keys Settings → Wellbeing uses (some only Froonty's settings show) | Exercise cards and guided routines (moving pictures), eye and breathing exercises drawn by Froonty, break ideas, the sit/stand tracker, a daily record and a 14-week chart |
| Mutter's idle monitor | A ledger of when you were at the computer or away (no keys, no counts, no app names) |
| An idle watch that ignores "keep awake" (a call or a video counts as a break) | Busy: calls, videos, presentations and full-screen windows count as time at the computer, and hold the cue |
| On or off, nothing else | Pause (30 min, 1 h, 2 h, until tomorrow) and working hours, by turning GNOME's breaks off and back on |

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
| move bar | 60 min at the computer without moving, then a segment more every 15 min | move pictogram and one red block per segment | the same |
| 1 Soon | due within 2 min (for eye breaks this is Froonty's: GNOME's eye "soon" notice is off by default); or due while you type, until a pause (Froonty's rule) | icon in a ring | "2m" |
| 0 Fine | otherwise | nothing | dim icon, "25m" |

- **Never colour alone:** each level has its own shape, and the pill's
  accessible name says it ("Movement break overdue by 3 minutes").
- **Due comes from GNOME's times, not its state:** GNOME reports `IN_BREAK`
  while you type after an interrupted break, and `IDLE` while you work with
  a break still owed (verified in GNOME Shell 50.1).
- The pill widens only when the cue does not fit; the time stays centred
  (an invisible twin of the cue on the other side).
- **No cue** while paused or outside working hours, and while busy (a
  call, screen sharing, a full-screen window, Do Not Disturb) until
  `break-busy-grace-minutes` after.

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
  with `break-make-up-time` on (off by default), at most doubling it. After
  a workout today: "a 3 min walk" (workout days, below).
- Long rest: 15 min ("Froonty's rule, after the AOA's 15 min after 2 h;
  expert opinion").
- Froonty never rewrites GNOME's length; it only suggests.

## Busy

GNOME's idle watch ignores "keep awake" requests, so a call or a video
with no typing counts as a break, and a break that falls due while you
type in a meeting dims the screen when you stop for 10 s. With "Notice
when you are busy" (`break-busy`, on), Froonty follows five signals
(`shell/busySignals.js`; each can be turned off in `break-busy-signals`):

| Signal | How it is seen (events, no polling) | Present | Holds the cue |
|---|---|---|---|
| A full-screen window | `global.display` `in-fullscreen-changed`, `get_monitor_in_fullscreen()` | yes | yes |
| Screen sharing or recording | The remote access controller's handles, as GNOME's indicators follow them (only those that start while Froonty runs) | yes | yes |
| Microphone in use (a call) | The Shell's mixer (`ui/status/volume.js` `getMixerControl()`): an app records, with GNOME's own exceptions | yes | yes |
| Do Not Disturb (not chosen by default) | `org.gnome.desktop.notifications show-banners` off | no (you may have left) | yes |
| An app keeps the screen awake (a video) | `org.gnome.SessionManager` idle inhibitors (flag 8), `InhibitorAdded` / `InhibitorRemoved`; the tab names the app | yes | no |

- **Present:** no input still counts as time at the computer: the ledger
  opens no away, the longest stretch, the long rest and the move bar go
  on, and the day's "busy without typing" time grows. When the signal ends
  with still no input, an away starts then.
- **Breaks GNOME credits meanwhile** are counted as "busy", not taken.
- **Holds the cue:** no cue on the pill while busy, and for
  `break-busy-grace-minutes` (2) after; the tab says why. Do Not Disturb
  is not chosen by default: someone who keeps it on would get no cue.
- **Hold GNOME's dimming and locking** (`break-busy-hold-gnome`, on): in a
  call, while sharing the screen, or full screen while an app keeps the
  screen awake (a video, a presentation), each type's "Dim the screen" and
  "Lock the screen" are off, and given back as they were when that ends
  (recorded in `break-gnome-saved`, entries `hold/<type>/<key>`; turning
  the tab or Froonty off gives them back too; a value changed meanwhile
  stays). GNOME dims or locks as soon as its state changes, before any
  handler of Froonty's could delay the break, so its own settings are
  held instead. A break due during the call stays due: the cue shows it
  (perhaps overdue) after the grace. Not for Do Not Disturb or any
  full-screen window: someone who keeps those on all day would never be
  reminded.
- A video's wake lock (Brave: "Video Wake Lock") makes no difference to the
  cue: a cue on the pill does not interrupt it.
- Not used: the camera (Froonty keeps it off), app lists, MPRIS (music is
  not busy).

## Pause and working hours

- **Pause** (`break-pause-button`, on): 30 min, 1 h, 2 h or until tomorrow
  (the next working hours, or 06:00). **Working hours**
  (`break-work-hours`, off: it needs your hours; days, from, to): outside
  them breaks are paused the same way; "Remind me anyway" lifts it until
  they start again.
- GNOME's engine has no pause: Froonty turns GNOME's selected breaks off
  and gives back exactly what was there at the end (GNOME then starts each
  interval afresh). It records first, in `break-gnome-saved` (entry
  `breaks/selected`), what it changed.
- Ends at its time (the service's one timer), on Resume, when the Break
  tab or Froonty is turned off (but not under the lock screen), and when
  breaks are turned back on in Settings → Wellbeing (the user's, left
  alone). While paused: no break, posture or move cue; screen time is still
  counted. GNOME's Wellbeing notifications come back meanwhile (the
  takeover follows GNOME's selected breaks).

## A pause in typing

With `break-natural-pause` (on), a break that falls due while you type is
shown at your first pause of 2 s (a Mutter idle watch, only while one
waits), or after `break-natural-pause-max-seconds` (60) at the latest
(Sane Break's idea; Safe Eyes, RSIBreak). Until then the cue stays at
"soon". Only Froonty's cue waits: GNOME's own times are unchanged.

## Skip limit and reasons

- `break-max-skips` (3): the tab hides Skip after that many skips in a row
  of a type (a break taken resets it; delays neither add nor reset). As
  with Delay, GNOME's own notification (when GNOME reminds) keeps its way.
- `break-skip-reasons` (on): after Skip or Delay in the tab, one tap says
  why: a meeting, a deadline, in the flow, other (or ✕). Counted per day;
  nothing else is recorded.

## Move bar and workout days

- **Move bar** (`break-move-goal`, on), as a Garmin watch's: after 60 min
  at the computer without moving (`break-move-after-minutes`), a cue with
  one segment, and one more every 15 min (`break-move-step-minutes`), five
  at most. An away of 2 min or more clears it ("a short walk of a couple
  of minutes", Garmin's manual). Its rank on the pill is below posture and
  above "soon". The Today section counts the hours with 30 min or more at
  the computer and how many of them you moved in.
- **Workout days** (`break-workout`, on; a heuristic, not medical advice):
  "I worked out…" in Today (30 min to 1 h 30), or "Yes" when the tab asks
  after an away of 45 min to 4 h. That day:
  - the standing target is the minimum (not stepping the build-up) and the
    workout counts toward it, up to 1 h ("upright time": Buckley's target
    is standing and light activity);
  - after the workout, the move bar waits 1.5 times as long and a movement
    break suggests a 3 min walk;
  - eye breaks and the long rest are unchanged; nothing is eased after
    10 h at the computer.
- **Why not more:** exercise lowers the long-term risk of a lot of sitting
  but does not erase it (Ekelund 2016: about 60-75 min/day of moderate
  activity; Ekelund 2020: 30-40 min/day attenuates; WHO 2020: limit
  sitting and be active), and those are habitual doses, not one session. A
  later workout does not undo what sitting before it did (lab trials of
  post-meal glucose and leg arteries), though exercise before sitting
  blunts some effects for a few hours, and breaks added on top still help
  (Wheeler 2019, 2020). Eye strain is about the viewing itself. Garmin,
  Apple and Fitbit keep exercise and hourly movement as separate goals.
  See Evidence.
- **Garmin's workouts** can be read too (below, off by default).

## Garmin (optional)

`break-garmin` (off): today's activities of 20 min or more from Garmin
Connect count as workouts, with "I worked out" still there; Garmin's
intensity minutes show in Today; an activity covering a long away answers
"Was that a workout?". Garmin offers individuals no API, so this uses
**python-garminconnect** (MIT, unofficial, pinned at 0.3.19), which
Garmin has blocked at times (new logins, spring 2026).

- **Isolated, always:** the helper (`garmin/helper.py`) runs in a process
  of its own (`garminRun.js`), with the Python of its own environment (a
  venv in `~/.local/share/froonty/garmin/venv`, Python's isolated mode
  `-I`), a short fixed environment (no `PYTHON*` or `LD_*` variables; the
  proxies pass through), that folder as its working folder, and a time
  limit (60 s; SIGTERM, then SIGKILL). Nothing of it is loaded into GNOME
  Shell; it prints one JSON line. Any failure (Garmin refusing it, no
  network, no venv) is an answer like `{"ok": false, "error": "blocked"}`:
  the tab says so in Today, retries later (6 h after a refusal, 15 min
  after a network error), and everything else goes on.
- **Credentials stay on this computer:** the password goes to the helper
  on its stdin, once, at the sign-in, and is never written anywhere. What
  is kept is the library's sign-in tokens, `tokens/garmin_tokens.json`
  (0600, in a 0700 folder; the library refuses symlinked paths), and
  `status.json` (whether it worked, signed in, the account's name, when;
  no activity data): all under `~/.local/share/froonty/garmin`, outside
  the repository (`.gitignore` also ignores any `garmin_tokens*.json`).
  "Sign out" deletes the tokens; "Remove" deletes the whole folder.
  Garmin can still use the tokens until they expire (the library cannot
  revoke them).
- **When:** only on events, never on a timer: at login and unlock (the
  service starts), back from an away of 20 min or more, when the Break tab
  comes on screen, and when the setting is turned on; at most every 15 min
  (5 after an away). Activities reach Garmin Connect after the watch syncs
  with the phone, so a workout may show only at the next of those.
- **Set-up, all on a click in Settings → Break → Garmin:** "Set up" makes
  the venv (`python3 -m venv`; Debian and Ubuntu need `python3-venv`) and
  installs the pinned library from PyPI (the only download); "Sign in…"
  asks for the email and password, and Garmin's code with two-step
  verification; "Sign out"; "Remove".
- **What is read:** today's activities (Garmin's id, type, start, length;
  no route, no heart rate, no names kept) and the day's moderate and
  vigorous intensity minutes. Kept in the day record like the rest
  (`state.json`, `history.json`).

## Pause media on Take now

`break-pause-media` (on): Take now pauses every player that is playing
(the Media tab's shared service, as the "Pause all media" panic button
does) and plays again only those, if still paused, at the first input
after an away that began after the Take. What it paused is kept in
`ctx.memory` (plain data), so a Take that locks the screen still plays
them again after the unlock. The Media service is held only meanwhile.

## Exercises

`features/break/exercises/catalog.json` lists 41 moves in Froonty's own
words: 30 stretches and moves (neck, shoulders, arms, chest, back,
wrists, legs, walking, water), 8 eye exercises and 2 breathing exercises,
each tagged seated or standing, discreet or not, with a body region and a
time ("30 s", "40 s, each side").

- **Pictures** (exercises/README.md), in this order:
  1. **WorkoutLabs'** colour line drawings, fetched to this computer by
     `tools/fetch-break-art.py` (`make break-art`; `make install` fetches
     them when missing) into `third_party/break-art/` (git-ignored; all
     rights reserved by WorkoutLabs). Animations become their
     2-3 poses (1.12 s each), stills with several poses are cut apart (3 s
     each); square PNGs on white. 30 of the 31 moves that have one; the
     drawings come from four series, so the person changes between moves.
  2. **Drawn by Froonty** (`drawn.js`): the eye and breathing exercises.
  3. **Workrave's** pictures (below), the fallback without the fetch.
- **Moving** (`break-animate`, on): a picture's frames fade one into the
  next (`player.js`), only while the card is on screen and GNOME's
  Animations switch is on (otherwise its first frame).
- **One card** when a movement break is soon or due, a long rest is due,
  or on "Show a stretch": standing moves first when you stand, only
  discreet ones during a call or a screen share, not the ones shown
  lately (the last 8, in the state file), a new body region first.
  "Another" shows the next.
- **Guided routine** (`break-routines`, on): "Start a routine (5 moves,
  4 min)": a movement break starts by getting up (a walk, marching, sit to
  stand…) and fills about 80 % of GNOME's movement length; a long rest
  starts with a walk and water and ends with breathing. One card at a
  time with a bar filling over the move's time, Pause, Next, Stop; it
  pauses when the island closes.
- **Eyes** (`break-eye-exercises`, on): when an eye break is due, "Look far
  away" for its length (a drawn eye looking at a horizon, a bar emptying),
  and "Eye exercises (comfort only)": follow the dot (a figure eight, a
  circle, up and down, left and right), near and far, blinking, palming.
- **Breathing** (`break-breathing`, on; `break-breathing-pattern`: box
  4-4-4-4, or slow 5-5): a circle grows as you breathe in and shrinks as
  you breathe out, with "Breathe in · 3". From the eye exercises, "Breathe"
  when nothing is due, and at the end of a long-rest routine.
- **Safety lines** are Froonty's own: stretches "Stretch gently to mild
  tension, hold still about 10-20 s, don't bounce…"; moves "Move gently…";
  eyes and breathing "Comfort only" (and "stop if you feel dizzy").
- **Workrave's** 10 exercises (the fallback): their pictures and texts are
  Workrave's (copyright the Workrave authors), treated as
  **GPL-3.0-or-later** (an inference: Workrave's `COPYING` is GPLv3, its
  headers say "or later", its `LICENSES.md` lists no exception). Only the
  18 pictures they use are shipped, byte-identical.

## Break ideas

`break-ideas` (on): one line under the exercise, "Idea: …", with "Another
idea": a short one for eye breaks and quiet moments, a long one for
movement breaks and long rests. 53 of 106 ideas from Stretchly
(BSD-2-Clause, notice in `exercises/IDEAS-LICENSE.md`) and Safe Eyes
(GPL-3.0-or-later), chosen by `tools/import-break-ideas.py`: no claims, no
advice, nothing not at hand, no text Stretchly took from other authors
(exercises/README.md).

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
  against the target; the hours you moved in, time busy without typing,
  breaks GNOME counted during a call or a video, why you skipped, a
  workout. **Last 7
  days** fold out; **"Forget history…"** asks first, then deletes the
  history and today's totals (posture and the build-up stay).
- **14 weeks** (`break-chart`, on) fold out: a calendar chart (weeks in
  columns, Monday at the top) of breaks taken, time at the computer,
  longest stretch, standing, or hours moved in (`break-chart-metric`), one
  colour in five strengths, no good/bad colours; a day's totals on click
  or with the arrow keys (`chart.js`, `chartData.js`).
- **Files**, under `~/.local/share/froonty/break/` (0700), each 0600, written
  atomically through one queue:
  - `state.json` (about 4 KB): when it was saved, GNOME Shell's process id,
    GNOME's last break ends, the ledger (accounted-until, stretch start,
    screen time since the last long rest and since the last move, an idle
    period open at the time), skip/delay streaks and owed time, the
    posture, the build-up's last step, the exercise and idea indexes and
    the moves shown lately, the last long away (to ask about a workout),
    today's record (also per hour at the computer and moved in, busy time,
    breaks GNOME credited while busy, skip reasons, workouts), the pause
    last applied (so breaks turned back on meanwhile stay on);
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
| `break-busy`, `-signals`, `-grace-minutes`, `-hold-gnome` | true, all but Do Not Disturb, 2, true | Busy |
| `break-pause-button` | true | Pause in the tab |
| `break-work-hours`, `-days`, `-start`, `-end` | false, Mon-Fri, 540, 1080 | Working hours (minutes after midnight) |
| `break-pause-media` | true | Pause media on Take now |
| `break-move-goal`, `-after-minutes`, `-step-minutes` | true, 60, 15 | The move bar |
| `break-workout` | true | Workout days |
| `break-garmin` | false | Read workouts from Garmin Connect (the helper, set up and signed in from Settings) |
| `break-natural-pause`, `-max-seconds` | true, 60 | Due at a pause in typing |
| `break-max-skips` | 3 | Skips in a row before the tab hides Skip (0 no limit) |
| `break-skip-reasons` | true | Ask why after a skip or delay |
| `break-animate`, `break-routines` | true, true | Moving pictures, guided routines |
| `break-eye-exercises`, `break-breathing`, `-pattern` | true, true, `box` | Drawn eye and breathing exercises |
| `break-ideas` | true | Break ideas |
| `break-chart`, `-metric` | true, `kept` | The 14-week chart |
| `break-gnome-saved`, `posture-buildup-target` | | Internal: what Froonty changed in GNOME (Wellbeing, countdowns, a pause); where the build-up is |
| `break-paused-until`, `break-work-override-until` | 0, 0 | Internal: a pause's end; "Remind me anyway" until (Unix seconds) |

GNOME's own keys, per type, in fold-outs: every (min), length, delay by,
dim the screen, lock the screen, sound when a break ends; and a button to
open Settings → Wellbeing. Settings → Break writes them only when a row is
changed.

## Rules it follows

- **GNOME settings written, all on the user's click or consent:**
  `selected-breaks` (the offer, the Settings switches; a pause and working
  hours, recorded and restored as described); the per-type keys
  (Settings); the Wellbeing `enable` and the per-type `countdown` (the
  reminders choice above, restored as described); while busy, the
  per-type `fade-screen` and `lock-screen` (`break-busy-hold-gnome`, the
  user's choice, restored as described).
- **Private Shell APIs** (DESIGN.md §6.3): `Main.breakManager` (its getters,
  methods and six signals) and its private `_breakLastEnd` map (each type's
  last break end; the public API gives only the earliest next break).
  Without the map the tab shows only "Next break: … at …".
- **Watches:** one 10 s uninhibitable Mutter idle watch (GNOME's own rule),
  plus one one-shot active watch while idle. GNOME's engine never says when
  an idle period starts, hence Froonty's own watch (DESIGN.md §2.1). While
  a due break waits for a pause in typing, one 2 s idle watch.
- **Busy signals** (while `break-busy` is on): `global.display`
  `in-fullscreen-changed`; the remote access controller's `new-handle` and
  each handle's `stopped`; the Shell's mixer `stream-added`,
  `stream-removed`, `state-changed`; `show-banners`; the session manager's
  `InhibitorAdded` / `InhibitorRemoved` (D-Bus), with one `GetInhibitors`
  and three calls per new inhibitor (its app, reason and flags), async.
- **Timers:** at most one one-shot timer (DESIGN.md §2.2), armed at the next
  moment something shown changes by itself: 2 min before a break, at it,
  60 s and one interval after it, the 2-h long-rest crossing, the posture
  reminder, the move bar's next segment, a pause's or working hours' end,
  the end of a held cue's grace, the latest a due cue waits for a pause in
  typing, midnight. GNOME emits nothing at those moments; they come from
  the user's own settings, so there is no interval to configure. The top
  bar's WallClock minute tick is followed only to spot a suspend that did
  not lock.
- **Animations** (DESIGN.md §2.2): Clutter transitions only, no GLib
  timer: a picture's frames (each its own time), a routine's bar (each
  move's time; it starts the next move), the drawn exercises' motion. Only
  while on screen; the pictures and drawings only while GNOME's Animations
  switch is on.
- **Files:** the two 0600 files above.
- **Not used:** no network in the Shell (the pictures are fetched by `make
  break-art`; Garmin is read by the helper, a process of its own, only with
  `break-garmin` on), no subprocess but that helper, no notification of
  Froonty's own, no Shell code patched, no CRITICAL urgency, no camera.
- **Third-party content:** Workrave's GPL-3.0-or-later pictures and texts;
  Stretchly's (BSD-2-Clause) and Safe Eyes' (GPL-3.0-or-later) break ideas;
  each with a README or licence file. WorkoutLabs' pictures are fetched to
  the user's computer only, never in the repository or the package.
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
| `features/break/exercises.js`, `exercises/` | The catalog, the fetched art's index, Workrave's exercises; the break ideas' data |
| `features/break/card.js`, `player.js`, `routine.js`, `drawn.js`, `drawnKinds.js` | A card; moving frames; a guided routine; the drawn eye and breathing exercises |
| `features/break/routines.js` | Pure: which moves, in which order, for a card or a routine |
| `features/break/busy.js`, `shell/busySignals.js` | Pure: what the busy signals mean; the signals themselves |
| `features/break/pause.js` | Pause and working hours: the rules, GNOME's selected breaks off and back |
| `features/break/mediaHold.js` | Pause media on Take now (the Media tab's shared service) |
| `features/break/ideas.js` | The break ideas |
| `features/break/chart.js`, `chartData.js` | The 14-week chart; its cells (pure) |
| `features/break/view.js`, `prefs.js`, `index.js`, `icons.js` | The tab, Settings → Break, the descriptor, the pictograms |
| `tools/fetch-break-art.py`, `tools/break-art/workoutlabs.json` | Fetches WorkoutLabs' pictures (`make break-art`) |
| `tools/import-break-ideas.py` | The one-off ideas converter |
| `features/break/garmin/helper.py`, `garminRun.js`, `garminData.js`, `garminPrefs.js` | The Garmin helper (its own venv and process); running it; its readings in the day (pure); Settings → Break → Garmin |
| `panic/sitStand.js` | The "Sitting or standing" panic button |
| `ui/island.js`, `ui/collapsedView.js` | The pill's cue (any feature with a `pillCue`) |
| `tools/import-workrave-exercises.py` | The one-off converter |

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
  the store and the exercises. Second iteration: `break-busy.test.js`
  (which signals mean what), `break-pause.test.js` (working hours, pause
  states, GNOME's breaks off and exactly back, the takeover's record kept,
  the keeper; with the service running: the tab or Froonty turned off
  during a pause, breaks turned on in Settings meanwhile, a pause's end;
  GNOME's dimming and locking held and given back), `break-routines.test.js` (the catalog and its picture
  sources, discreet and standing picks, recent moves, routines),
  `break-chart.test.js`, `break-ideas.test.js`, `break-garmin.test.js`
  (which activities count, when Garmin is asked, the backoff, a reading in
  the service, with a fake helper), `test_break_garmin_helper.py` (the
  helper with a fake library: the password never on disk, the tokens'
  modes, the code's round trip, no activity data in the status, error
  names), and new cases in the
  engine (paused, waiting for a pause in typing, the skip limit, a held
  cue, the move bar, the busy classification, the workout walk) and
  ledger tests (hours, moves, the workout question).
- **Headless** (`testBreak` in `tools/headless-test/checks.js`, both session
  modes): off by default; the offer; GNOME's breaks turned on through it; a
  due cue with no expansion and no grab, the time still centred, no GNOME
  notification or dot; the pill opening the tab; Delay, Skip, escalation to
  level 3; Take dimming and a 12 s away counted; the sit/stand switch by
  pointer and keyboard; the panic button; the state file's modes; a lock
  keeping GNOME's notifications off and the counts; turning Froonty, the
  island and the reminders off giving GNOME's notifications back (and the
  dots); the exercise card (the catalog's first seated move, its picture
  drawn, moving when it has frames); a drawn eye exercise moving; Pause 30
  min and Resume (GNOME's breaks off, recorded, exactly back); outside
  working hours and "Remind me anyway"; the 14-week chart; the tab's
  layout at 440 × 480. The lifecycle test cycles Froonty 25 times with
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
| Exercise lowers the long-term risk of a lot of sitting, but does not erase it | Workout days ease, never turn off | Ekelund et al., *Lancet* 2016, DOI 10.1016/S0140-6736(16)30370-1 (about 60-75 min/day of moderate activity removed the excess mortality of sitting over 8 h/day; not of TV over 5 h/day; self-report, 1 million people); Ekelund et al., *BJSM* 2020, DOI 10.1136/bjsports-2020-103270 (30-40 min/day "attenuated, although not completely eliminated"; accelerometers, 44,370 people aged 40+); Ajufo et al., *JACC* 2025, DOI 10.1016/j.jacc.2024.10.065 (risk over about 10.6 h/day sedentary persisted in the guideline-active) | Moderate (observational) |
| Exercise before sitting blunts some of its acute effects for hours; breaks on top still help; a later workout cannot undo what came before | After a workout: the move bar waits longer and a short walk is suggested; before it, nothing changes | Morishima et al., *Clin Sci* 2017 (45 min cycling prevented the leg-artery drop over 3 h sitting; 15 young adults); Wheeler et al., *Hypertension* 2019 and *IJBNPA* 2020 (morning walk plus 3-min breaks every 30 min: further insulin and blood-pressure benefit; 67 older adults); Peddie et al., *AJCN* 2013 (breaks beat one 30-min walk for glucose and insulin; 70 adults) | Low-moderate (acute lab trials) |
| Standing adds little for active people; long static standing has costs | The workout counts toward the standing target (capped at 1 h) | Katzmarzyk, *MSSE* 2014 (standing linked to lower mortality only in the inactive; self-report); Ahmadi et al., *IJE* 2024; Buffey et al., *Sports Med* 2022 (standing breaks weaker than walking breaks) | Low |
| Trackers keep exercise and hourly movement apart | The move bar is not cleared by a logged workout | Garmin's manuals (move bar after 1 h, a segment every 15 min, cleared by "a short walk (at least a couple of minutes)"); Fitbit's help ("Even if you meet daily exercise guidelines, extended sitting can impact your health") | Documentation |
| 20-20-20 is about the viewing itself | Eye breaks are never eased | AOA computer vision syndrome page; AAO (blink rate 5-7/min at screens) | Expert opinion |

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

- **Input is activity**, unless busy: with "Notice when you are busy" a
  call, a video, a share or a full-screen window keeps you present; without
  it, or for anything those signals miss, no input counts as away, as it
  does for GNOME.
- **Busy signals:** screen sharing that began before Froonty was enabled
  (an unlock) is not seen; an app that holds a wake lock all day keeps you
  "watching" (turn that signal off). Not tried on a real call yet.
- **Pause and working hours** turn GNOME's breaks off: Settings →
  Wellbeing shows them off meanwhile. If Froonty is removed or fails to
  load while paused, nothing turns them back on: switch them on in
  Settings → Wellbeing.
- **The pictures** (WorkoutLabs) are fetched by hand (`make break-art`);
  the four drawing series change the person between moves; one move has
  no WorkoutLabs picture. Not seen in a real Shell yet: the frame fades,
  the drawn exercises, the routine's bar, the chart.
- **Workout days** are entered by hand, or read from Garmin with
  `break-garmin`: an unofficial library Garmin may block (then only by
  hand), not tried against a real account by Froonty's tests.
- **Holding GNOME's dimming and locking** writes GNOME's per-type
  settings: Settings → Wellbeing shows them off during a call. If Froonty
  is removed or fails to load meanwhile, switch them back on there.
- **Pause media on Take now, then a lock:** the players are played again
  when the Break tab is next built (the hub builds a tab when it is first
  opened), not at the unlock itself.
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
- That St draws a mirrored picture (`scale_x = -1`) correctly was checked
  by pixels in the first iteration's headless test (only Workrave's
  fallback pictures are mirrored now).
- `org.gnome.Settings-wellbeing-symbolic` (the tab's icon) may be missing
  outside Ubuntu; `alarm-symbolic` stands in.
