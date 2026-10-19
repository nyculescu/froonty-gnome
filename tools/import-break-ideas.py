#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Converts Stretchly's and Safe Eyes' break ideas for the Break tab (one-off; not packed).

Usage: tools/import-break-ideas.py STRETCHLY_DIR SAFEEYES_DIR

STRETCHLY_DIR is a clone of https://github.com/hovancik/stretchly: its
app/utils/defaultMicrobreakIdeas.js and app/utils/defaultBreakIdeas.js are
read as text (never run). SAFEEYES_DIR is a clone of
https://github.com/slgobinath/safeeyes: the English names of short_breaks
and long_breaks in safeeyes/config/safeeyes.json. Writes
froonty@catalin/features/break/exercises/ideas.json, after checking that
Stretchly's LICENSE is still the one IDEAS-LICENSE.md quotes and that Safe
Eyes' pyproject.toml still says GPL-3.0-or-later.

Reproducible: every upstream idea needs a decision below (KEEP or a drop
reason), every decision must name an upstream idea, every duplicate must
name a kept idea, and every fix must be used; anything else stops the
script, so a new or changed upstream idea is decided by hand. Whitespace is
normalised; every other change of wording is in FIXES (upstream -> kept).
See features/break/exercises/README.md and IDEAS-LICENSE.md.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

# Drop reasons. The first four are Froonty's editorial rules (reminders
# only, no health claims: docs/features/break.md); THIRD_PARTY and
# DUPLICATE keep the list honest and short.
KEEP = "keep"
CLAIM = "claim"              # a health, productivity or research benefit
ADVICE = "advice"            # medical, dietary or exercise-prescription advice
NOT_AT_HAND = "not-at-hand"  # needs what a desk or an office does not have
SUBSTANCE = "substance"      # drugs, alcohol or smoking (none at these commits)
THIRD_PARTY = "third-party"  # another author's text, so not the project's to license
DUPLICATE = "duplicate"      # the same idea as the kept one named, which reads clearer
REASONS = {CLAIM, ADVICE, NOT_AT_HAND, SUBSTANCE, THIRD_PARTY, DUPLICATE}

# Pages Stretchly's README credits ("Humans and Tools") that hold the same
# words (checked 2026-10-16, archived copies where the page is gone).
STANFORD = ("Stanford EH&S, 'Ergonomic Microbreaks' "
            "(web.stanford.edu/dept/EHS/prod/general/ergo/microbreaks.html, 2015 archive)")
WEBMD = "WebMD, 'Exercises for Carpal Tunnel Syndrome' (webmd.com/pain-management/exercises-carpal-tunnel-syndrome)"
ONHEALTH = ("OnHealth (WebMD), 'Eye Exercises and Stretches' "
            "(onhealth.com/content/1/eye_exercises_and_stretches, 2020 archive)")
KRAVITZ = "Len Kravitz, UNM article on sitting (unm.edu/~lkravitz/Article folder/sittingUNM.html)"
PADGETT = "Ron Padgett, poem 'How to Be Perfect' (poetryfoundation.org/poems/57243)"
PAINSCIENCE = "PainScience, 'Microbreaking' (painscience.com/articles/microbreaking.php)"

# Stretchly's microbreak ideas, in its order: upstream text -> decision.
STRETCHLY_SHORT = {
    "Go grab a glass of water.": KEEP,
    "Slowly look all the way left, then right.": KEEP,
    "Slowly look all the way up, then down.": KEEP,
    "Close your eyes and take few deep breaths.": (DUPLICATE, "Take five slow, deep breaths."),
    "Close your eyes and relax.": KEEP,
    "Stretch your legs.": KEEP,
    "Stretch your arms.": KEEP,
    "Is your sitting posture correct?": (DUPLICATE, "Check your posture and sit back comfortably."),
    "Slowly turn head to side and hold for 10 seconds.": (THIRD_PARTY, STANFORD),
    "Slowly tilt head to side and hold for 5-10 seconds.": (THIRD_PARTY, STANFORD),
    "Stand from your chair and stretch.": KEEP,
    # Stanford's "at least 20 feet away", changed to 20 meters.
    "Refocus your eyes on an object at least 20 meters away.": (DUPLICATE, "Focus on a point in the far distance."),
    "Take a moment to think about something you appreciate.": KEEP,
    "Take a moment to smile at being alive.": KEEP,
    # "truly ergonomic"; PainScience's sentence too.
    "A truly ergonomic workstation is one that you regularly push away from.": (CLAIM, PAINSCIENCE),
    "Close your eyes and count your breaths.": KEEP,
    "Close your eyes and name the things you hear.": KEEP,
    "Place your fingertips on your shoulders. Roll your shoulders forward for 10 seconds, then backward.": KEEP,
    "Raise your right arm, stretch it over your head to the left, and hold for 10 seconds. "
    "Repeat on the other side.": KEEP,
    "With your right hand, grab each finger of your left hand in turn and squeeze. Repeat on the other side.": KEEP,
    "Stand up and do a lunge. Hold for 10 seconds, then do the other leg.": KEEP,
    "Close your eyes and simply notice whatever arises in current moment, without judgement.": KEEP,
    # 20-20-20 is Froonty's own eye-break line already.
    "Focus every 20 minutes for 20 seconds on an object at 20 feet distance.":
        (DUPLICATE, "Focus on a point in the far distance."),
    "If you need help, ask for it.": (THIRD_PARTY, PADGETT),
    "Do one thing at a time.": (THIRD_PARTY, PADGETT),
    "Is your attention spent wisely?": KEEP,
    "Change your sitting posture.": KEEP,
    # Eye-health advice; OnHealth's "Expose eyes to natural light" too.
    "Expose your eyes to natural light.": (ADVICE, ONHEALTH),
    "With your eyes closed, slowly and gently raise your eyes to the ceiling and back down to the floor.":
        (THIRD_PARTY, ONHEALTH),
    "With your eyes closed, slowly and gently move your eyes to the left, then slowly to the right.":
        (THIRD_PARTY, ONHEALTH),
    # "to get some relief"; WebMD's words too.
    "Shake your hands out to get some relief.": (CLAIM, WEBMD),
    "One at a time, touch the tip of each finger to the tip of your thumb so they make an O-shape.":
        (THIRD_PARTY, WEBMD),
    "Make a fist and then slide your fingers up until they point toward the ceiling, "
    "like you're telling someone to stop.": (THIRD_PARTY, WEBMD),
    "Make a fist and then fan your fingers out and stretch them as far as you can.": KEEP,
    "Sit tall, arms hanging at your sides, and slowly rotate neck in one direction in a large circle.": KEEP,
    "Stand tall and slowly tilt your head toward the shoulder using the same hand until you feel a stretch.":
        (DUPLICATE, "Tilt your head to one side, then to the other side, and then gently tilt it forward "
                    "and backward."),
    "Stand tall with your arms by your side. Squeeze your shoulder blades together and hold.": KEEP,
    "Stand tall with your arms raised along your shoulders. Move hands slightly behind your back, "
    "hold for a second and return.": KEEP,
    "Sit on the edge of your chair, twist your torso to one side and hold for 10-15 seconds. "
    "Repeat on the other side.": KEEP,
    "Stand up and put one foot on a nearby object, like a chair or step stool. Keep your knee bent and "
    "hold for 10-15 seconds. Repeat with the other foot.": KEEP,
    "Stand with your feet shoulder-width apart, lower your body down as if you were sitting back into "
    "a chair, then stand back up. Repeat several times.": KEEP,
    "Stand with your back and hands on a wall, then slowly move your arms up and down as if you were "
    "making snow angels.": KEEP,
    "Stand facing a wall and place your hands on it, then do several push-ups.": KEEP,
    "Sit on the edge of your chair and extend one leg straight out in front of you, holding for "
    "10-15 seconds. Repeat with the other leg.": KEEP,
    "Stand facing a wall, put one foot back and the other foot forward, then lean into the wall. "
    "Repeat with the other leg.": KEEP,
    "Hold one arm straight up, then use the other arm to gently push the elbow of the first arm towards "
    "your head. Hold for 10-15 seconds. Repeat with the other arm.": KEEP,
    "Tilt your head to one side, then to the other side, and then gently tilt it forward and backward.": KEEP,
    "Reach one arm across your chest, hold onto the elbow with the other hand, and gently pull it in "
    "towards your chest. Repeat with the other arm.": KEEP,
    "Stand up, put one foot on a nearby object, like a chair or step stool, and reach down to touch your "
    "toes. Repeat with the other leg.": KEEP,
    "Stand in a doorway and place one arm on each side of the doorway, then gently lean forward until "
    "you feel a stretch in your chest.": KEEP,
    "Sit on the edge of a chair or on the floor, and place the soles of your feet together, gently "
    "pressing down with your elbows to stretch your inner thighs.": KEEP,
}

# Stretchly's break ideas, in its order: upstream title -> decision.
STRETCHLY_LONG = {
    "Not alone": (CLAIM, "Taking breaks together increases productivity."),
    "Step away": (CLAIM, "your brain can figure things out by itself"),
    "Microbreaks": (CLAIM, "help lower the exposure to ergonomic injury risk; " + STANFORD),
    "Meditation": (CLAIM, "Research studies suggest ... help improve general health"),
    "Blink": (CLAIM, "refresh the tear film"),
    "Ergonomics": (CLAIM, "can cause health problems"),
    "Move": KEEP,
    "Change": (NOT_AT_HAND, "a stability ball or a standing desk"),
    "Notice": (CLAIM, "It is a sign that you need to take a break."),
    "Tech": KEEP,
    "Metabolism": (CLAIM, "Emerging research shows ... risk of metabolic syndrome"),
    "Active Meetings": (CLAIM, "Walking not only burns calories"),
    "Fruit": (ADVICE, "eat some fruit (dietary)"),
    "Bathrooms": (THIRD_PARTY, KRAVITZ),
    "Coffee break": KEEP,  # Kravitz's idea, Stretchly's own wording.
    "Colleagues": (THIRD_PARTY, KRAVITZ),
    "Learning": (CLAIM, "NIH researchers found"),
    "Exercise": (CLAIM, "Evidence suggests ... dramatic health benefits"),
    "Repeat": (CLAIM, "to better fight effects of prolonged sitting"),
    "Wrist and forearm": KEEP,
    "Back stretching": KEEP,
    "Mobilize": (ADVICE, "an unsourced rule (one minute per thirty); " + PAINSCIENCE),
    "7 Minute Workout": (NOT_AT_HAND, "a full-body workout and an app"),
    "Pulse": (CLAIM, "improved cardiovascular health; " + PADGETT),
    "Take the stairs": (CLAIM, "Studies have shown ... burns more calories"),
    "Make art": (CLAIM, "Art therapy is known to have great mental health benefits"),
    "Declutter": (CLAIM, "A clean space helps your focus"),
    "Lunch outside": (CLAIM, "decreased stress and anxiety"),
    "Public transport": (NOT_AT_HAND, "the commute, not a break at the desk"),
    "Yawning": (CLAIM, "produces tears to help moisten and lubricate the eyes; " + ONHEALTH),
    "Focus change": (THIRD_PARTY, ONHEALTH),
    "Palming": (THIRD_PARTY, ONHEALTH),
    "Hand squeezes": (NOT_AT_HAND, "balled-up socks or a rubber ball; " + WEBMD),
    "Slow Breathing": (CLAIM, "Emerging research suggests ... health and longevity"),
    "Imaginative visualization": KEEP,
    "Overwhelmed?": (ADVICE, "a coping technique offered for feeling overwhelmed"),
}

# Safe Eyes' short_breaks names, in its order: upstream name -> decision.
SAFEEYES_SHORT = {
    "Gently close your eyes": (DUPLICATE, "Close your eyes and relax."),
    "Take five slow, deep breaths": KEEP,
    "Rotate your eyes in clockwise direction": KEEP,
    "Relax your shoulders and drop them away from your ears": KEEP,
    "Blink your eyes": KEEP,
    "Stretch your neck gently from side to side":
        (DUPLICATE, "Tilt your head to one side, then to the other side, and then gently tilt it forward "
                    "and backward."),
    "Roll your eyes a few times to each side": (DUPLICATE, "Slowly look all the way left, then right."),
    "Check your posture and sit back comfortably": KEEP,
    "Rotate your eyes in counterclockwise direction": (DUPLICATE, "Rotate your eyes in a clockwise direction."),
    "Unclench your jaw and relax your face": KEEP,
    "Focus on a point in the far distance": KEEP,
    "Stretch your wrists and fingers": KEEP,
    "Have some water": (DUPLICATE, "Go grab a glass of water."),
}

# Safe Eyes' long_breaks names (no title; kept as untitled long ideas).
SAFEEYES_LONG = {
    "Stand up and stretch your back and legs": KEEP,
    "Lean back at your seat and relax": KEEP,
    "Walk around and refill your water": KEEP,
    "Walk for a while": (DUPLICATE, "How about taking a no-tech walk?"),
    "Step away from the screen and do a short mobility stretch":
        (DUPLICATE, "Stand up and stretch your back and legs."),
    "Rest your eyes and focus on distant objects": KEEP,
}

# Every change of wording besides whitespace: upstream -> kept.
FIXES = {
    "Stand from your chair and stretch.": "Stand up from your chair and stretch.",
    "Close your eyes and simply notice whatever arises in current moment, without judgement.":
        "Close your eyes and simply notice whatever arises in the current moment, without judgement.",
    "Sit tall, arms hanging at your sides, and slowly rotate neck in one direction in a large circle.":
        "Sit tall, arms hanging at your sides, and slowly rotate your neck in one direction in a large circle.",
    "Going on coffee break? Consider doing a 5-minute walk every time you go for one.":
        "Going on a coffee break? Consider doing a 5-minute walk every time you go for one.",
    # Safe Eyes' names are labels: a full stop, as Stretchly's sentences have.
    "Take five slow, deep breaths": "Take five slow, deep breaths.",
    "Rotate your eyes in clockwise direction": "Rotate your eyes in a clockwise direction.",
    "Relax your shoulders and drop them away from your ears":
        "Relax your shoulders and drop them away from your ears.",
    "Blink your eyes": "Blink your eyes.",
    "Check your posture and sit back comfortably": "Check your posture and sit back comfortably.",
    "Unclench your jaw and relax your face": "Unclench your jaw and relax your face.",
    "Focus on a point in the far distance": "Focus on a point in the far distance.",
    "Stretch your wrists and fingers": "Stretch your wrists and fingers.",
    "Stand up and stretch your back and legs": "Stand up and stretch your back and legs.",
    "Lean back at your seat and relax": "Lean back in your seat and relax.",
    "Walk around and refill your water": "Walk around and refill your water.",
    "Rest your eyes and focus on distant objects": "Rest your eyes and focus on distant objects.",
}

STRETCHLY = {
    "id": "stretchly",
    "project": "Stretchly",
    "url": "https://github.com/hovancik/stretchly",
    "files": ["app/utils/defaultMicrobreakIdeas.js", "app/utils/defaultBreakIdeas.js"],
    "license": "BSD-2-Clause",
    "copyright": "Copyright (c) 2016-, Jan Hovancik",
}
SAFEEYES = {
    "id": "safeeyes",
    "project": "Safe Eyes",
    "url": "https://github.com/slgobinath/safeeyes",
    "files": ["safeeyes/config/safeeyes.json"],
    "license": "GPL-3.0-or-later",
    "copyright": "Copyright (C) Gobinath Loganathan and the Safe Eyes contributors",
}

JS_STRING = r"'(?:[^'\\\n]|\\.)*'"
JS_ENTRY = re.compile(r"\{\s*data:\s*(?P<data>" + JS_STRING + r"|\[\s*" + JS_STRING + r"\s*,\s*" + JS_STRING
                      + r"\s*\])\s*,\s*enabled:\s*(?P<enabled>true|false)\s*\}")
JS_ESCAPES = {"'": "'", '"': '"', "\\": "\\", "n": "\n", "t": "\t"}


def normal(text):
    return " ".join(text.split())


def js_string(literal):
    """The value of a single-quoted JS string literal with simple escapes."""
    def unescape(m):
        if m.group(1) not in JS_ESCAPES:
            raise SystemExit(f"unexpected escape in {literal}")
        return JS_ESCAPES[m.group(1)]
    return re.sub(r"\\(.)", unescape, literal[1:-1])


def js_ideas(path):
    """The enabled entries of `export default [{data: ..., enabled: ...}, ...]`, read as text."""
    source = path.read_text(encoding="utf-8")
    body = re.fullmatch(r"\s*export default \[(.*)\]\s*", source, flags=re.S)
    if not body:
        raise SystemExit(f"{path}: not an `export default [...]` list")
    entries, end = [], 0
    for m in JS_ENTRY.finditer(body.group(1)):
        if body.group(1)[end:m.start()].strip() not in ("", ","):
            raise SystemExit(f"{path}: unexpected text before {m.group(0)[:60]}")
        end = m.end()
        if m.group("enabled") == "true":
            entries.append([normal(js_string(s)) for s in re.findall(JS_STRING, m.group("data"))])
    if body.group(1)[end:].strip() not in ("", ","):
        raise SystemExit(f"{path}: unexpected text at the end")
    return entries


def git(directory, *args):
    return subprocess.run(["git", "-c", "core.fsmonitor=false", "-C", str(directory), *args],
                          check=True, capture_output=True, text=True).stdout.strip()


def pinned(directory, source):
    """`source` with the clone's commit, once its files are the commit's."""
    if git(directory, "status", "--porcelain", "--", *source["files"]):
        raise SystemExit(f"{directory}: {source['files']} differ from the commit")
    out = {}
    for key, value in source.items():
        out[key] = value
        if key == "url":
            out["commit"] = git(directory, "rev-parse", "HEAD")
    return out


def decide(table, upstream, label):
    """The kept keys of `upstream`, after checking `table` decides exactly these."""
    if list(table) != upstream:
        new = [k for k in upstream if k not in table]
        gone = [k for k in table if k not in upstream]
        raise SystemExit(f"{label}: undecided {new}, not upstream {gone} (or a different order)")
    for key, decision in table.items():
        if decision != KEEP and (not isinstance(decision, tuple) or decision[0] not in REASONS):
            raise SystemExit(f"{label}: bad decision for {key!r}")
    return [k for k, d in table.items() if d == KEEP]


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    stretchly, safeeyes = (Path(a).resolve() for a in sys.argv[1:])
    out_dir = Path(__file__).resolve().parent.parent / "froonty@catalin/features/break/exercises"

    licence = (stretchly / "LICENSE").read_text(encoding="utf-8")
    if licence.splitlines()[0] != STRETCHLY["copyright"]:
        raise SystemExit(f"Stretchly's copyright line changed: {licence.splitlines()[0]}")
    if normal(licence) not in normal((out_dir / "IDEAS-LICENSE.md").read_text(encoding="utf-8")):
        raise SystemExit("IDEAS-LICENSE.md does not hold Stretchly's LICENSE verbatim")
    if 'license = {text = "GPL-3.0-or-later"}' not in (safeeyes / "pyproject.toml").read_text(encoding="utf-8"):
        raise SystemExit("Safe Eyes' licence changed (pyproject.toml)")

    micro = js_ideas(stretchly / STRETCHLY["files"][0])
    breaks = js_ideas(stretchly / STRETCHLY["files"][1])
    if any(len(e) != 1 for e in micro) or any(len(e) != 2 for e in breaks):
        raise SystemExit("Stretchly: unexpected entry shape")
    micro = [e[0] for e in micro]
    texts = dict(breaks)
    if len(texts) != len(breaks):
        raise SystemExit("Stretchly: two break ideas share a title")
    config = json.loads((safeeyes / SAFEEYES["files"][0]).read_text(encoding="utf-8"))
    se_short = [normal(b["name"]) for b in config["short_breaks"]]
    se_long = [normal(b["name"]) for b in config["long_breaks"]]

    used = set()

    def fix(text):
        if text in FIXES:
            used.add(text)
            return FIXES[text]
        return text

    short = [{"text": fix(t), "source": "stretchly"} for t in decide(STRETCHLY_SHORT, micro, "Stretchly short")]
    short += [{"text": fix(t), "source": "safeeyes"} for t in decide(SAFEEYES_SHORT, se_short, "Safe Eyes short")]
    long = [{"title": fix(t), "text": fix(texts[t]), "source": "stretchly"}
            for t in decide(STRETCHLY_LONG, [b[0] for b in breaks], "Stretchly long")]
    long += [{"text": fix(t), "source": "safeeyes"} for t in decide(SAFEEYES_LONG, se_long, "Safe Eyes long")]

    if used != set(FIXES):
        raise SystemExit(f"fixes not used: {sorted(set(FIXES) - used)}")
    kept = {e["text"] for e in short + long}
    if len(kept) != len(short) + len(long):
        raise SystemExit("the same text kept twice")
    for table in (STRETCHLY_SHORT, STRETCHLY_LONG, SAFEEYES_SHORT, SAFEEYES_LONG):
        for key, decision in table.items():
            if decision != KEEP and decision[0] == DUPLICATE and decision[1] not in kept:
                raise SystemExit(f"{key!r} duplicates {decision[1]!r}, which is not kept")

    data = {
        "format": 1,
        "sources": [pinned(stretchly, STRETCHLY), pinned(safeeyes, SAFEEYES)],
        "short": short,
        "long": long,
    }
    (out_dir / "ideas.json").write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    for source in data["sources"]:
        tables = (STRETCHLY_SHORT, STRETCHLY_LONG) if source["id"] == "stretchly" else (SAFEEYES_SHORT, SAFEEYES_LONG)
        dropped = {}
        for table in tables:
            for decision in table.values():
                if decision != KEEP:
                    dropped[decision[0]] = dropped.get(decision[0], 0) + 1
        print(f"{source['project']} {source['commit']}: "
              f"{sum(e['source'] == source['id'] for e in short)} short, "
              f"{sum(e['source'] == source['id'] for e in long)} long kept; dropped {dropped}")


if __name__ == "__main__":
    main()
