# SPDX-License-Identifier: GPL-3.0-or-later
"""Fail a public build that contains any working-tree-only feature.

Checks the packed zip: no file of a local-only feature, none of the four
modules that list them, the files the kept tabs need, none of the local
features' telltale strings in any file (code, CSS, compiled schema), and
no code, CSS or schema line longer than EGO's review limit. On failure
every hit is printed and the zip is deleted, so `make pack` cannot leave
a leaking archive.

Usage: check_zip.py ZIP
"""

import os
import sys
import zipfile

LOCAL_DIRS = (
    "features/writing/", "features/zerotier/", "features/media/", "features/claude/",
    "features/sysmon/", "features/clipboard/", "features/killprocess/", "features/break/",
)
# extensions.gnome.org's review guidelines: at most 200 characters a line.
MAX_LINE = 200
# The modules that list them (strip_local.py takes out their imports).
LOCAL_MODULES = (
    "features/localFeatures.js", "features/localPrefs.js",
    "panic/localCatalog.js", "panic/localFactories.js",
)
REQUIRED = (
    "metadata.json", "extension.js",
    # Bundled icons the kept tabs load by path (prune.py keeps them).
    "features/calendar/icons/hicolor/scalable/actions/froonty-calendar-symbolic.svg",
    "features/notes/icons/froonty-fold-up-symbolic.svg",
    "features/notes/icons/froonty-fold-down-symbolic.svg",
)
BANNED = (
    b"features/writing",
    b"features/zerotier",
    b"writing-enabled",
    b"froonty-writing",
    b"froonty-ollama",
    b"api.languagetool.org",
    b"127.0.0.1:11434",
    b"FROONTY_OLLAMA",
    b"zerotier-enabled",
    b"froonty-zerotier",
    b"features/media",
    b"features/claude",
    b"features/sysmon",
    b"features/clipboard",
    b"features/killprocess",
    b"features/break",
    b"media-enabled",
    b"claude-enabled",
    b"claude-attention",
    b"sysmon-enabled",
    b"clipboard-enabled",
    b"killprocess-enabled",
    b"break-enabled",
    b"froonty-claude-symbolic",
    b"froonty-btop-symbolic",
    b"statusline",
    # The left-out features' CSS classes and names, in code and comments
    # alike (the published package names no third-party brand).
    b"froonty-claude",
    b"froonty-attention",
    b"froonty-sysmon",
    b"froonty-clipboard",
    b"froonty-killprocess",
    b"froonty-break",
    b"froonty-panic-posture",
    b"froonty-pill-cue-level",
    b"kill-process",
    b"Kill Process",
    b"Claude",
    b"Clipboard tab",
    b"Media's",
    b"camera.js",
    b"localFeatures",
    b"localPrefs",
    b"localCatalog",
    b"localFactories",
    b"local:begin",
    b"local:end",
)


def problems(zip_path):
    """Every reason the zip is not a clean public build."""
    found = []
    with zipfile.ZipFile(zip_path) as archive:
        names = archive.namelist()
        for name in names:
            if name.startswith(LOCAL_DIRS):
                found.append(f"{name}: a local-only file")
        for name in REQUIRED:
            if name not in names:
                found.append(f"{name}: missing")
        for name in LOCAL_MODULES:
            if name in names:
                found.append(f"{name}: lists local-only features")
        for name in names:
            if name.endswith("/"):
                continue
            data = archive.read(name)
            for word in BANNED:
                if word in data:
                    found.append(f"{name}: contains {word.decode()}")
            if name.endswith((".js", ".css", ".xml")):
                for number, line in enumerate(data.decode("utf-8").splitlines(), 1):
                    if len(line) > MAX_LINE:
                        found.append(f"{name}:{number}: {len(line)} characters, over {MAX_LINE}")
    return found


def main(argv):
    if len(argv) != 2:
        raise SystemExit(__doc__)
    zip_path = argv[1]
    found = problems(zip_path)
    if found:
        for line in found:
            print(f"check_zip: {line}", file=sys.stderr)
        os.remove(zip_path)
        raise SystemExit(f"check_zip: {zip_path} leaks local-only features; deleted it")
    print(f"check_zip: {os.path.basename(zip_path)} has no local-only feature")


if __name__ == "__main__":
    main(sys.argv)
