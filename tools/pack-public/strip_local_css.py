# SPDX-License-Identifier: GPL-3.0-or-later
"""Remove working-tree-only blocks from a staged stylesheet.

A block is everything from a line starting with ``/* local:begin NAME`` to
the line ``/* local:end NAME */``, both included. Each NAME given must be
present exactly once; a missing, unbalanced or nested marker fails, so a
renamed or half-deleted block cannot slip into a public build.

Usage: strip_local_css.py STYLESHEET NAME...
"""

import re
import sys

BEGIN = re.compile(r"^/\* local:begin ([a-z0-9-]+)\b")
END = re.compile(r"^/\* local:end ([a-z0-9-]+) \*/\s*$")


def strip(text, names):
    """Return text without the named blocks; raise ValueError on bad markers."""
    out = []
    open_name = None
    seen = []
    for number, line in enumerate(text.splitlines(keepends=True), 1):
        begin = BEGIN.match(line)
        end = END.match(line)
        if begin:
            if open_name is not None:
                raise ValueError(f"line {number}: local:begin {begin.group(1)} inside {open_name}")
            open_name = begin.group(1)
            seen.append(open_name)
            continue
        if end:
            if end.group(1) != open_name:
                raise ValueError(f"line {number}: local:end {end.group(1)} without its begin")
            open_name = None
            continue
        if "local:begin" in line or "local:end" in line:
            raise ValueError(f"line {number}: malformed marker: {line.strip()}")
        if open_name is None:
            out.append(line)
        elif open_name not in names:
            raise ValueError(f"line {number}: unexpected local block {open_name}")
    if open_name is not None:
        raise ValueError(f"local:begin {open_name} is never closed")
    for name in names:
        if seen.count(name) != 1:
            raise ValueError(f"expected one local block {name}, found {seen.count(name)}")
    return "".join(out)


def main(argv):
    if len(argv) < 3:
        raise SystemExit(__doc__)
    path, names = argv[1], argv[2:]
    with open(path, encoding="utf-8") as f:
        text = f.read()
    try:
        stripped = strip(text, names)
    except ValueError as e:
        raise SystemExit(f"{path}: {e}")
    with open(path, "w", encoding="utf-8") as f:
        f.write(stripped)


if __name__ == "__main__":
    main(sys.argv)
