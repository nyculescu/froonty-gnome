# SPDX-License-Identifier: GPL-3.0-or-later
"""Fail a public build that contains any working-tree-only feature.

Checks the packed zip: no file of a local-only feature, the two stub
modules byte for byte, and none of the local features' telltale strings
in any file (code, CSS, compiled schema). On failure every hit is printed
and the zip is deleted, so `make pack` cannot leave a leaking archive.

Usage: check_zip.py ZIP STUBS_DIR
"""

import os
import sys
import zipfile

LOCAL_DIRS = ("features/writing/", "features/zerotier/")
STUBS = ("features/localFeatures.js", "features/localPrefs.js")
REQUIRED = ("metadata.json", "extension.js")
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
)


def problems(zip_path, stubs_dir):
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
        for name in STUBS:
            stub = os.path.join(stubs_dir, os.path.basename(name))
            with open(stub, "rb") as f:
                expected = f.read()
            if name not in names:
                found.append(f"{name}: missing")
            elif archive.read(name) != expected:
                found.append(f"{name}: not the public stub ({stub})")
        for name in names:
            if name.endswith("/"):
                continue
            data = archive.read(name)
            for word in BANNED:
                if word in data:
                    found.append(f"{name}: contains {word.decode()}")
    return found


def main(argv):
    if len(argv) != 3:
        raise SystemExit(__doc__)
    zip_path, stubs_dir = argv[1], argv[2]
    found = problems(zip_path, stubs_dir)
    if found:
        for line in found:
            print(f"check_zip: {line}", file=sys.stderr)
        os.remove(zip_path)
        raise SystemExit(f"check_zip: {zip_path} leaks local-only features; deleted it")
    print(f"check_zip: {os.path.basename(zip_path)} has no local-only feature")


if __name__ == "__main__":
    main(sys.argv)
