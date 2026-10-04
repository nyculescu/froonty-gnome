#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Fetch the Formulas tab's math renderer, MathJax, into the working tree.

Usage: fetch-mathjax.py [EXTENSION_DIR]   (default: froonty@catalin)

Downloads four official packages from the npm registry, pinned below by
version and sha512 integrity (the registry's own `dist.integrity`), and
unpacks what the renderer needs into EXTENSION_DIR/third_party/mathjax/
(git-ignored; `make install` copies it, `make pack` leaves it out):

    src/                          @mathjax/src: the TeX input, SVG output
    mathjax-newcm-font/           its default font, SVG parts only
    mathjax-mhchem-font-extension/  the arrows of \\ce
    mhchemparser/                 \\ce's parser

Only the modules the renderer imports, and what they import in turn, are
kept, plus the font's lazily loaded parts (svg/dynamic) and MathJax's
named-entity tables: no source maps, type files, other outputs, menus or
speech. GJS has no package resolver, so bare and `#alias` imports are
rewritten to relative paths; an import that cannot be resolved fails the
fetch. Each package keeps its package.json (its licence, Apache-2.0) and
its LICENSE file where it has one.

Idempotent: a complete tree with the pinned versions is left alone. The
new tree is built beside the old one and swapped in only once complete.
Nothing is fetched at runtime.
"""

import base64
import hashlib
import json
import os
import posixpath
import re
import shutil
import sys
import tarfile
import tempfile
import urllib.request

REGISTRY = "https://registry.npmjs.org"
# name, version, sha512 integrity, folder in third_party/mathjax.
PACKAGES = (
    ("@mathjax/src", "4.1.3",
     "sha512-rIrWquuBSoJuoMBdC/1qD+AUHTorlccPicoVy6P2xbUgnuDBpCcpbHtOAsB8L3hdCHtNBg92lF8e3Fz+pkcQbw==",
     "src"),
    ("@mathjax/mathjax-newcm-font", "4.1.3",
     "sha512-gzAB3dFHilHX1l5x2xUqRL+1jDQt3Fyza1DkEMVXWC4E8SvsGdlgEza47HYi2WhVcgfkvf4zgUGzuhbq3Pjlew==",
     "mathjax-newcm-font"),
    ("@mathjax/mathjax-mhchem-font-extension", "4.1.3",
     "sha512-WFx0IooitEJq1TXc9V941o8eaZdICSPn8FpsIBDdhkMhb0if61jCvk6vtQN84dlLnNEorK011NfpirMkHYygSQ==",
     "mathjax-mhchem-font-extension"),
    ("mhchemparser", "4.2.1",
     "sha512-kYmyrCirqJf3zZ9t/0wGgRZ4/ZJw//VwaRVGA75C4nhE60vtnIzhl9J9ndkX/h6hxSN7pjg/cE0VxbnNM+bnDQ==",
     "mhchemparser"),
)

# What features/formulas/renderer/mathjax.js imports, relative to
# third_party/mathjax (keep both lists in step).
TEX_PACKAGES = (
    "base/BaseConfiguration", "ams/AmsConfiguration", "newcommand/NewcommandConfiguration",
    "mhchem/MhchemConfiguration",
    "physics/PhysicsConfiguration", "braket/BraketConfiguration", "cancel/CancelConfiguration",
    "cases/CasesConfiguration", "mathtools/MathtoolsConfiguration",
    "boldsymbol/BoldsymbolConfiguration", "upgreek/UpgreekConfiguration",
    "textmacros/TextMacrosConfiguration", "gensymb/GensymbConfiguration",
    "units/UnitsConfiguration", "color/ColorConfiguration",
)
ROOTS = (
    "src/mjs/mathjax.js", "src/mjs/input/tex.js", "src/mjs/output/svg.js",
    "src/mjs/adaptors/liteAdaptor.js", "src/mjs/handlers/html.js",
    "mathjax-newcm-font/mjs/svg.js", "mathjax-mhchem-font-extension/mjs/svg.js",
) + tuple(f"src/mjs/input/tex/{name}.js" for name in TEX_PACKAGES)
# Loaded on demand through mathjax.asyncLoad: every module in these folders.
LAZY_DIRS = ("mathjax-newcm-font/mjs/svg/dynamic", "src/mjs/util/entities")

# Bare and aliased import prefixes → folders here (src's package.json
# "imports" for #default-font and #mhchem; the fonts import @mathjax/src).
ALIASES = (
    ("#default-font/", "mathjax-newcm-font/mjs/"),
    ("#mhchem/", "mhchemparser/esm/"),
    ("@mathjax/src/mjs/", "src/mjs/"),
)
LICENSE_FILES = ("LICENSE", "LICENSE.txt", "NOTICE", "NOTICE.txt")
STAMP = "fetched.json"

# Static imports and re-exports (tsc's output: one per statement, the
# specifier in single quotes), side-effect imports and literal import().
IMPORT = re.compile(
    r"""(\b(?:import|export)\s[^;'"]*?\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*)'([^']+)'""",
    re.M)


def stamp_data():
    return {"packages": {name: version for name, version, _i, _d in PACKAGES},
            "roots": list(ROOTS)}


def up_to_date(target):
    try:
        with open(os.path.join(target, STAMP), encoding="utf-8") as f:
            return json.load(f) == stamp_data()
    except (OSError, ValueError):
        return False


def download(name, version, integrity, folder):
    """The verified tarball's bytes."""
    base = name.split("/")[-1]
    url = f"{REGISTRY}/{name}/-/{base}-{version}.tgz"
    print(f"fetch-mathjax: {name}@{version}")
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read()
    algorithm, expected = integrity.split("-", 1)
    actual = base64.b64encode(hashlib.new(algorithm, data).digest()).decode()
    if actual != expected:
        raise SystemExit(f"fetch-mathjax: {url}: integrity mismatch (got {algorithm}-{actual})")
    return data


def unpack(data, dest):
    """Extract a package tarball's package/ folder into dest."""
    path = os.path.join(dest, "package.tgz")
    with open(path, "wb") as f:
        f.write(data)
    with tarfile.open(path) as archive:
        # The "data" filter refuses links, absolute paths and paths that
        # leave dest.
        archive.extractall(dest, filter="data")
    os.remove(path)
    return os.path.join(dest, "package")


def resolve(rel, spec):
    """The package-relative path an import of rel names, or None."""
    for prefix, folder in ALIASES:
        if spec.startswith(prefix):
            return posixpath.normpath(folder + spec[len(prefix):])
    if spec.startswith("."):
        return posixpath.normpath(posixpath.join(posixpath.dirname(rel), spec))
    return None


def closure(read, have):
    """Every module reachable from ROOTS and LAZY_DIRS, with its imports."""
    todo = list(ROOTS) + sorted(p for p in have if p.endswith(".js")
                                and posixpath.dirname(p) in LAZY_DIRS)
    seen = {}
    while todo:
        rel = todo.pop()
        if rel in seen:
            continue
        if rel not in have:
            raise SystemExit(f"fetch-mathjax: {rel} is imported but not in the packages")
        text = read(rel)
        imports = []
        for match in IMPORT.finditer(text):
            target = resolve(rel, match.group(2))
            if target is None:
                raise SystemExit(f"fetch-mathjax: {rel} imports {match.group(2)!r}, "
                                 "which this renderer does not provide")
            imports.append(target)
            todo.append(target)
        seen[rel] = imports
    return seen


def rewrite(rel, text):
    """text with every aliased import made relative to rel."""
    def relative(match):
        spec = match.group(2)
        for prefix, folder in ALIASES:
            if spec.startswith(prefix):
                path = posixpath.relpath(folder + spec[len(prefix):], posixpath.dirname(rel))
                spec = path if path.startswith(".") else "./" + path
                break
        return f"{match.group(1)}'{spec}'"
    return IMPORT.sub(relative, text)


def build(work, target):
    unpacked = {}
    for name, version, integrity, folder in PACKAGES:
        dest = os.path.join(work, "unpacked", folder)
        os.makedirs(dest)
        unpacked[folder] = unpack(download(name, version, integrity, folder), dest)

    have = set()
    for folder, root in unpacked.items():
        for dirpath, _dirs, files in os.walk(root):
            for file in files:
                rel = os.path.relpath(os.path.join(dirpath, file), root).replace(os.sep, "/")
                have.add(f"{folder}/{rel}")

    def source(rel):
        folder, rest = rel.split("/", 1)
        return os.path.join(unpacked[folder], *rest.split("/"))

    def read(rel):
        with open(source(rel), encoding="utf-8") as f:
            return f.read()

    modules = closure(read, have)
    staged = os.path.join(work, "mathjax")
    for rel in sorted(modules):
        out = os.path.join(staged, *rel.split("/"))
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "w", encoding="utf-8") as f:
            f.write(rewrite(rel, read(rel)))
    for folder, root in unpacked.items():
        for name in ("package.json",) + LICENSE_FILES:
            if os.path.isfile(os.path.join(root, name)):
                shutil.copyfile(os.path.join(root, name), os.path.join(staged, folder, name))
    with open(os.path.join(staged, STAMP), "w", encoding="utf-8") as f:
        json.dump(stamp_data(), f, indent=2)
        f.write("\n")

    # Swapped in only once complete: an interrupted fetch leaves the old
    # tree (or none), never half a one.
    old = target + ".old"
    shutil.rmtree(old, ignore_errors=True)
    if os.path.exists(target):
        os.rename(target, old)
    shutil.move(staged, target)
    shutil.rmtree(old, ignore_errors=True)
    size = sum(os.path.getsize(os.path.join(d, f)) for d, _s, fs in os.walk(target) for f in fs)
    print(f"fetch-mathjax: {len(modules)} modules, {size / 1e6:.1f} MB in {target}")


def main(argv):
    extension = argv[1] if len(argv) > 1 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "froonty@catalin")
    target = os.path.join(extension, "third_party", "mathjax")
    if up_to_date(target):
        print(f"fetch-mathjax: {target} is up to date")
        return
    os.makedirs(os.path.dirname(target), exist_ok=True)
    work = tempfile.mkdtemp(prefix=".mathjax-fetch.", dir=os.path.dirname(target))
    try:
        build(work, target)
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main(sys.argv)
