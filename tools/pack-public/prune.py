# SPDX-License-Identifier: GPL-3.0-or-later
"""Trim a staged extension to what the public build runs.

After strip_local.py took out the imports of localFeatures.js,
localPrefs.js, localCatalog.js and localFactories.js:

1. Modules: only those reachable from extension.js and prefs.js through
   relative imports stay; a feature folder left without any module goes
   whole (icons and data included), a kept one keeps its icons.
2. Schema: the keys of the features no longer there (PREFIXES) go.
3. Stylesheet: rules whose every selector names a removed feature's class
   go, with the comments right before them.
4. Checks: every settings key the remaining code names exists in the
   schema, none of the removed ones is named, and no class whose rules
   went is used by the remaining code.

Usage: prune.py STAGED_DIR
"""

import os
import re
import shutil
import sys
import xml.etree.ElementTree as ET

# Settings keys of the features the public build leaves out.
PREFIXES = (
    "media-", "claude-", "sysmon-", "clipboard-", "killprocess-",
    "break-", "posture-", "zerotier-", "writing-", "formulas-",
)
# Their CSS classes: each name and every class it begins with a dash
# (froonty-media matches .froonty-media and .froonty-media-title, not
# .froonty-mediax). Break's cue levels and the sit/stand button's look
# are theirs too; the cue itself (.froonty-pill-cue) is the core's.
CLASSES = (
    "froonty-media", "froonty-claude", "froonty-attention", "froonty-sysmon",
    "froonty-clipboard", "froonty-killprocess", "froonty-break", "froonty-posture",
    "froonty-zerotier", "froonty-writing", "froonty-ollama", "froonty-formulas",
    "froonty-panic-posture", "froonty-pill-cue-level", "froonty-pill-cue-posture",
)
CLASS = re.compile(r"\.(" + "|".join(map(re.escape, CLASSES)) + r")(?![A-Za-z0-9_])")
# Comments that mention them go too (a comment above a block of keys).
MENTIONS = tuple(f"features/{name}" for name in (
    "media", "claude", "sysmon", "clipboard", "killprocess", "break", "zerotier", "writing",
    "formulas",
)) + ("kill-process", "claude-attention", "local-only")
ROOTS = ("extension.js", "prefs.js")
SCHEMA = "schemas/org.gnome.shell.extensions.froonty.gschema.xml"

IMPORT = re.compile(r"""(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)['"](\.{1,2}/[^'"]+)['"]""", re.M)


def reachable(root):
    """Relative paths of the modules reachable from ROOTS."""
    seen = set()
    todo = list(ROOTS)
    while todo:
        rel = os.path.normpath(todo.pop())
        if rel in seen:
            continue
        path = os.path.join(root, rel)
        if not os.path.isfile(path):
            raise SystemExit(f"{rel}: imported but missing")
        seen.add(rel)
        with open(path, encoding="utf-8") as f:
            text = f.read()
        for spec in IMPORT.findall(text):
            todo.append(os.path.join(os.path.dirname(rel), spec))
    return seen


def prune_modules(root, keep):
    """Delete unreachable modules, then folders left without a module."""
    removed = []
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            rel = os.path.relpath(os.path.join(dirpath, name), root)
            if name.endswith(".js") and rel not in keep:
                os.remove(os.path.join(root, rel))
                removed.append(rel)
    # Bottom-up: a folder goes (with its icons or data) when the folder of
    # its feature (its first two path parts, e.g. features/notes) has no
    # module left, so a kept feature keeps its icons/; the top level and
    # schemas/ stay.
    for dirpath, _dirs, _files in sorted(os.walk(root), key=lambda w: -w[0].count(os.sep)):
        rel = os.path.relpath(dirpath, root)
        if dirpath == root or rel.startswith("schemas"):
            continue
        unit = os.path.join(root, *rel.split(os.sep)[:2])
        has_module = any(f.endswith(".js") for _d, _s, fs in os.walk(unit) for f in fs)
        if not has_module and os.path.isdir(dirpath):
            shutil.rmtree(dirpath)
            removed.append(os.path.relpath(dirpath, root) + "/")
    return removed


def prune_schema(root):
    """Remove the keys of features left out; return (kept, removed) names."""
    path = os.path.join(root, SCHEMA)
    parser = ET.XMLParser(target=ET.TreeBuilder(insert_comments=True))
    tree = ET.parse(path, parser)
    kept, removed = set(), set()
    for parent in tree.getroot().iter():
        for child in list(parent):
            if child.tag is ET.Comment:
                if any(m in (child.text or "") for m in MENTIONS):
                    parent.remove(child)
                continue
            if child.tag != "key":
                continue
            name = child.get("name", "")
            if name.startswith(PREFIXES):
                parent.remove(child)
                removed.add(name)
            else:
                kept.add(name)
    # The build ships no translations (describe.py drops it from metadata.json).
    tree.getroot().attrib.pop("gettext-domain", None)
    tree.write(path, encoding="UTF-8", xml_declaration=True)
    return kept, removed


def css_segments(text):
    """Split a stylesheet into ('comment'|'rule'|'space', text) segments."""
    out, i = [], 0
    while i < len(text):
        if text.startswith("/*", i):
            j = text.index("*/", i) + 2
            out.append(("comment", text[i:j]))
        elif text[i].isspace():
            j = i
            while j < len(text) and text[j].isspace():
                j += 1
            out.append(("space", text[i:j]))
        else:
            j = text.index("}", i) + 1
            out.append(("rule", text[i:j]))
        i = j
    return out


def removed_rule(rule):
    selectors = rule.split("{", 1)[0].split(",")
    return all(CLASS.search(sel) for sel in selectors)


def prune_css(root):
    path = os.path.join(root, "stylesheet.css")
    with open(path, encoding="utf-8") as f:
        segments = css_segments(f.read())
    drop = [False] * len(segments)
    for n, (kind, text) in enumerate(segments):
        if kind == "rule" and removed_rule(text):
            drop[n] = True
            # The comments (and spaces) right before it describe it.
            k = n - 1
            while k >= 0 and segments[k][0] in ("comment", "space"):
                if segments[k][0] == "space" and segments[k][1].count("\n") > 1:
                    break
                drop[k] = True
                k -= 1
    for n, (kind, text) in enumerate(segments):
        if kind == "comment" and any(m in text for m in MENTIONS):
            drop[n] = True
    # A comment followed only by dropped rules or the end (a section
    # header, "End of …") goes too.
    for n, (kind, text) in enumerate(segments):
        if kind == "comment" and not drop[n] and any(c in text for c in ("End of",)):
            prev = [segments[k] for k in range(n) if segments[k][0] == "rule"]
            if prev and removed_rule(prev[-1][1]):
                drop[n] = True
    text = "".join(t for n, (_k, t) in enumerate(segments) if not drop[n])
    text = re.sub(r"\n{3,}", "\n\n", text)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    # The classes only dropped rules styled.
    def classes(keep):
        return {c for n, (kind, t) in enumerate(segments) if kind == "rule" and drop[n] != keep
                for c in CSS_CLASS.findall(t.split("{", 1)[0])}
    return classes(False) - classes(True)


CSS_CLASS = re.compile(r"\.(froonty-[A-Za-z0-9_-]+)")


def check_classes(root, dropped):
    """Kept modules that name a class whose rules went."""
    problems = []
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if not name.endswith(".js"):
                continue
            path = os.path.join(dirpath, name)
            with open(path, encoding="utf-8") as f:
                text = f.read()
            for cls in dropped:
                if re.search(rf"(?<![A-Za-z0-9_-]){re.escape(cls)}(?![A-Za-z0-9_-])", text):
                    problems.append(f"{os.path.relpath(path, root)}: uses the removed class {cls}")
    return sorted(problems)


KEY_CALL = re.compile(
    r"""(?:get|set)_(?:boolean|int|uint|string|strv|value|enum|double)\(\s*['"]([a-z0-9-]+)['"]"""
    r"""|changed::([a-z0-9-]+)|Key:\s*['"]([a-z0-9-]+)['"]|Keys?\s*=\s*['"]([a-z0-9-]+)['"]"""
    r"""|enabledKey:\s*['"]([a-z0-9-]+)['"]|(?:width|height):\s*['"]([a-z0-9-]+)['"]""")


def check_keys(root, removed):
    problems = []
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if not name.endswith(".js"):
                continue
            path = os.path.join(dirpath, name)
            with open(path, encoding="utf-8") as f:
                text = f.read()
            rel = os.path.relpath(path, root)
            for match in KEY_CALL.finditer(text):
                key = next(g for g in match.groups() if g)
                # Other schemas' keys (GNOME's own) are read too.
                if key in removed:
                    problems.append(f"{rel}: uses the removed key {key}")
            for key in removed:
                if re.search(rf"['\"`]{re.escape(key)}['\"`]", text):
                    problems.append(f"{rel}: names the removed key {key}")
    return sorted(set(problems))


def main():
    root = sys.argv[1]
    keep = reachable(root)
    removed_files = prune_modules(root, keep)
    _kept, removed = prune_schema(root)
    dropped_classes = prune_css(root)
    problems = check_keys(root, removed)
    if problems:
        print("\n".join(problems), file=sys.stderr)
        raise SystemExit("the public build still uses keys of features it leaves out")
    problems = check_classes(root, dropped_classes)
    if problems:
        print("\n".join(problems), file=sys.stderr)
        raise SystemExit("the public build still uses CSS classes whose rules it left out")
    print(f"public build: {len(keep)} modules, {len(removed_files)} files or folders "
          f"and {len(removed)} settings keys left out")


if __name__ == "__main__":
    main()
