# SPDX-License-Identifier: GPL-3.0-or-later
"""Remove working-tree-only blocks from a staged stylesheet or module.

A block is everything from a line starting with ``/* local:begin NAME``
(CSS) or ``// local:begin NAME`` (JavaScript, indented or not) to the line
``/* local:end NAME */`` or ``// local:end NAME``, both included. Each NAME
given must be present exactly once (with --several: at least once); a
missing, unbalanced or nested marker fails, so a renamed or half-deleted
block cannot slip into a public build.

Usage: strip_local.py [--several] FILE NAME...
"""

import re
import sys

BEGIN = re.compile(r"^\s*(?:/\*|//) local:begin ([a-z0-9-]+)\b")
END = re.compile(r"^\s*(?:/\* local:end ([a-z0-9-]+) \*/|// local:end ([a-z0-9-]+))\s*$")


def strip(text, names, several=False):
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
            name = end.group(1) or end.group(2)
            if name != open_name:
                raise ValueError(f"line {number}: local:end {name} without its begin")
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
        count = seen.count(name)
        if count < 1 or (count > 1 and not several):
            raise ValueError(f"expected {'a' if several else 'one'} local block {name}, found {count}")
    return "".join(out)


def main(argv):
    several = "--several" in argv
    args = [a for a in argv[1:] if a != "--several"]
    if len(args) < 2:
        raise SystemExit(__doc__)
    path, names = args[0], args[1:]
    with open(path, encoding="utf-8") as f:
        text = f.read()
    try:
        stripped = strip(text, names, several)
    except ValueError as e:
        raise SystemExit(f"{path}: {e}")
    with open(path, "w", encoding="utf-8") as f:
        f.write(stripped)


if __name__ == "__main__":
    main(sys.argv)
