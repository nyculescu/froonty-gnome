#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Converts Workrave's active exercises for the Break tab (one-off; not packed).

Usage: tools/import-workrave-exercises.py WORKRAVE_DIR

Reads WORKRAVE_DIR/ui/data/exercises/exercises.xml.in (a clone of
https://github.com/rcaelers/workrave) and writes
froonty@catalin/features/break/exercises/exercises.json, copying only the
pictures the active (not commented-out) exercises use, byte for byte.
Titles and descriptions stay Workrave's English text (whitespace
normalised). See features/break/exercises/README.md for the licence.
"""

import json
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

EXPECTED = [
    "Shoulder-arm stretch",
    "Finger stretch",
    "Neck tilt stretch",
    "Backward shoulder stretch",
    "Move the eyes",
    "Train focusing the eyes",
    "Look into the darkness",
    "Move the shoulders",
    "Move the shoulders up and down",
    "Turn your head",
]
EYES = {"Move the eyes", "Train focusing the eyes", "Look into the darkness"}
SOURCE_PATH = "ui/data/exercises/exercises.xml.in"


def slug(title):
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")


def main():
    workrave = Path(sys.argv[1]).resolve()
    out_dir = Path(__file__).resolve().parent.parent / "froonty@catalin/features/break/exercises"
    images_dir = out_dir / "images"
    source_dir = workrave / "ui/data/exercises"

    # ElementTree skips comments, so only the active exercises remain.
    root = ET.parse(workrave / SOURCE_PATH).getroot()
    exercises = []
    for node in root.findall("exercise"):
        title = node.findtext("title").strip()
        text = " ".join(node.findtext("description").split())
        sequence = node.find("sequence")
        frames = []
        for image in sequence.findall("image"):
            frame = {"image": image.get("src"), "seconds": int(image.get("duration"))}
            if image.get("mirrorx") == "yes":
                frame["mirror"] = True
            frames.append(frame)
        exercises.append({
            "id": slug(title),
            "title": title,
            "text": text,
            "kind": "eyes" if title in EYES else "stretch",
            "seconds": int(sequence.get("duration")),
            "frames": frames,
        })

    titles = [e["title"] for e in exercises]
    if titles != EXPECTED:
        raise SystemExit(f"unexpected exercises: {titles}")

    commit = subprocess.run(["git", "-C", str(workrave), "rev-parse", "HEAD"],
                            check=True, capture_output=True, text=True).stdout.strip()

    names = sorted({f["image"] for e in exercises for f in e["frames"]})
    for name in names:
        if not (source_dir / name).is_file():
            raise SystemExit(f"missing picture: {name}")
    if images_dir.exists():
        shutil.rmtree(images_dir)
    images_dir.mkdir(parents=True)
    for name in names:
        shutil.copyfile(source_dir / name, images_dir / name)

    data = {
        "format": 1,
        "source": {
            "project": "Workrave",
            "url": "https://github.com/rcaelers/workrave",
            "commit": commit,
            "path": SOURCE_PATH,
            "license": "GPL-3.0-or-later",
        },
        "exercises": exercises,
    }
    (out_dir / "exercises.json").write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n")
    print(f"{len(exercises)} exercises, {len(names)} pictures, commit {commit}")


if __name__ == "__main__":
    main()
