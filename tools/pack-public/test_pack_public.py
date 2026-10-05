# SPDX-License-Identifier: GPL-3.0-or-later
"""Tests for the public build's leak guard (check_zip.py), marker stripping
(strip_local.py) and CSS pruning (prune.py), plus one real
`tools/pack-public.sh` run into a temporary folder.
Run: python3 -m unittest tools/pack-public/test_pack_public.py
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))


def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, f"{name}.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


check_zip = load("check_zip")
strip_local = load("strip_local")
prune = load("prune")


class CheckZipTest(unittest.TestCase):
    def make_zip(self, extra=None, replace=None):
        folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, folder, True)
        path = os.path.join(folder, "froonty@catalin.shell-extension.zip")
        files = {
            "metadata.json": b"{}",
            "extension.js": b"export default class {}",
            "stylesheet.css": b".froonty-pill {}\n",
        }
        files.update({name: b"<svg/>" for name in check_zip.REQUIRED if name.endswith(".svg")})
        files.update(replace or {})
        files.update(extra or {})
        with zipfile.ZipFile(path, "w") as archive:
            for name, data in files.items():
                archive.writestr(name, data)
        return path

    def test_clean_zip_passes(self):
        path = self.make_zip()
        self.assertEqual(check_zip.problems(path), [])
        check_zip.main(["check_zip.py", path])
        self.assertTrue(os.path.exists(path))

    def assert_fails(self, path, needle):
        found = check_zip.problems(path)
        self.assertTrue(any(needle in line for line in found), found)
        with self.assertRaises(SystemExit):
            check_zip.main(["check_zip.py", path])
        self.assertFalse(os.path.exists(path), "a leaking zip is deleted")

    def test_local_file(self):
        self.assert_fails(self.make_zip({"features/writing/x.js": b"x"}), "local-only file")

    def test_local_module(self):
        path = self.make_zip({"features/localFeatures.js": b"export const LOCAL_FEATURES = [];"})
        self.assert_fails(path, "lists local-only features")

    def test_missing_icon(self):
        path = self.make_zip()
        other = os.path.join(os.path.dirname(path), "other.zip")
        icon = "features/notes/icons/froonty-fold-up-symbolic.svg"
        with zipfile.ZipFile(path) as source, zipfile.ZipFile(other, "w") as target:
            for name in source.namelist():
                if name != icon:
                    target.writestr(name, source.read(name))
        self.assert_fails(other, f"{icon}: missing")

    def test_long_line(self):
        self.assert_fails(self.make_zip({"schemas/x.gschema.xml": b"<a>" + b"x" * 200 + b"</a>\n"}),
                          "over 200")

    def test_brand_in_comment(self):
        self.assert_fails(self.make_zip({"ui/x.js": b"// the Claude attention bar\n"}), "Claude")

    def test_service_address_in_code(self):
        self.assert_fails(self.make_zip({"ui/x.js": b"const u = 'https://api.languagetool.org/v2';"}),
                          "api.languagetool.org")

    def test_mathjax_file(self):
        self.assert_fails(self.make_zip({"third_party/mathjax/src/mjs/mathjax.js": b"export {};"}),
                          "local-only file")

    def test_formulas_traces(self):
        self.assert_fails(self.make_zip({"features/formulas/index.js": b"x"}), "local-only file")
        self.assert_fails(self.make_zip({"schemas/gschemas.compiled": b"\0formulas-enabled\0"}),
                          "formulas-enabled")
        self.assert_fails(self.make_zip(replace={"stylesheet.css": b".froonty-formulas-flow { }"}),
                          "froonty-formulas")
        self.assert_fails(self.make_zip({"ui/x.js": b"// drawn by MathJax\n"}), "MathJax")

    def test_writing_css(self):
        self.assert_fails(self.make_zip(replace={"stylesheet.css": b".froonty-writing { }"}),
                          "froonty-writing")

    def test_key_in_binary(self):
        self.assert_fails(self.make_zip({"schemas/gschemas.compiled": b"\0\1writing-enabled\0"}),
                          "writing-enabled")

    def test_missing_metadata(self):
        path = self.make_zip()
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
        other = os.path.join(os.path.dirname(path), "other.zip")
        with zipfile.ZipFile(path) as source, zipfile.ZipFile(other, "w") as target:
            for name in names:
                if name != "metadata.json":
                    target.writestr(name, source.read(name))
        self.assert_fails(other, "metadata.json: missing")


class StripLocalTest(unittest.TestCase):
    CSS = (".a {}\n"
           "/* local:begin zerotier (local) */\n.froonty-zerotier {}\n/* local:end zerotier */\n"
           ".b {}\n"
           "/* local:begin writing (local) */\n.froonty-writing {}\n/* local:end writing */\n")

    JS = ("import a from './a.js';\n"
          "// local:begin local-features (local)\nimport {L} from './localFeatures.js';\n// local:end local-features\n"
          "export const X = [\n    a,\n    // local:begin local-features\n    ...L,\n    // local:end local-features\n];\n")

    def test_strips_both(self):
        self.assertEqual(strip_local.strip(self.CSS, ["zerotier", "writing"]), ".a {}\n.b {}\n")

    def test_strips_js_blocks(self):
        self.assertEqual(strip_local.strip(self.JS, ["local-features"], several=True),
                         "import a from './a.js';\nexport const X = [\n    a,\n];\n")
        with self.assertRaises(ValueError):
            strip_local.strip(self.JS, ["local-features"])
        with self.assertRaises(ValueError):
            strip_local.strip("const a = 1;\n", ["local-features"], several=True)

    def test_unbalanced(self):
        for broken in (self.CSS.replace("/* local:end writing */\n", ""),
                       self.CSS.replace("/* local:begin zerotier (local) */\n", ""),
                       self.CSS.replace("/* local:end zerotier */\n", "/* local:end writing */\n")):
            with self.assertRaises(ValueError):
                strip_local.strip(broken, ["zerotier", "writing"])

    def test_nested_and_missing(self):
        nested = "/* local:begin writing */\n/* local:begin zerotier */\n/* local:end zerotier */\n/* local:end writing */\n"
        with self.assertRaises(ValueError):
            strip_local.strip(nested, ["zerotier", "writing"])
        with self.assertRaises(ValueError):
            strip_local.strip(".a {}\n", ["writing"])


class PruneCssTest(unittest.TestCase):
    def test_removed_rule(self):
        for selector in (".froonty-claude {", ".froonty-media-title {", ".froonty-break,\n.froonty-sysmon {",
                         ".froonty-formulas-symbol {",
                         ".froonty-pill-cue-level-2,\n.froonty-pill-cue-posture {",
                         ".froonty-panic-button.froonty-panic-posture:checked {"):
            self.assertTrue(prune.removed_rule(selector + " }"), selector)
        for selector in (".froonty-pill-cue {", ".froonty-pill-cue-text {", ".froonty-mediax {",
                         ".froonty-claude, .froonty-pill {", ".froonty-panic-button {"):
            self.assertFalse(prune.removed_rule(selector + " }"), selector)

    def test_kept_feature_keeps_its_icons(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        for rel in ("extension.js", "features/notes/index.js", "features/notes/icons/a.svg",
                    "features/break/index.js", "features/break/icons/b.svg"):
            os.makedirs(os.path.dirname(os.path.join(root, rel)), exist_ok=True)
            with open(os.path.join(root, rel), "w") as f:
                f.write("")
        prune.prune_modules(root, {"extension.js", "features/notes/index.js"})
        self.assertTrue(os.path.exists(os.path.join(root, "features/notes/icons/a.svg")))
        self.assertFalse(os.path.exists(os.path.join(root, "features/break")))


def archive_text(path, name):
    with zipfile.ZipFile(path) as archive:
        return archive.read(name).decode()


class PackTest(unittest.TestCase):
    def test_pack_public(self):
        out = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, out, True)
        env = dict(os.environ, PACK_OUT_DIR=out)
        # As the Makefile's SOURCE_DIRS: third_party holds the fetched MathJax.
        dirs = sorted(d for d in os.listdir(os.path.join(ROOT, "froonty@catalin"))
                      if os.path.isdir(os.path.join(ROOT, "froonty@catalin", d))
                      and d not in ("schemas", "third_party"))
        result = subprocess.run(["bash", os.path.join(ROOT, "tools", "pack-public.sh"), "froonty@catalin", *dirs],
                                cwd=ROOT, env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        path = os.path.join(out, "froonty@catalin.shell-extension.zip")
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            schema = archive.read("schemas/org.gnome.shell.extensions.froonty.gschema.xml")
            css = archive.read("stylesheet.css")
        self.assertFalse([n for n in names if n.startswith((
            "features/writing", "features/zerotier", "features/media", "features/claude",
            "features/sysmon", "features/clipboard", "features/killprocess", "features/break"))])
        self.assertIn("features/notes/index.js", names)
        # The Formulas tab and its renderer, fetched or not, stay out.
        self.assertFalse([n for n in names if n.startswith(("features/formulas", "third_party"))])
        self.assertFalse([n for n in names if "mathjax" in n.lower()])
        # The Calendar and Notifications tabs are gone; the message tray
        # modules only the local Claude attention bar imports stay out.
        self.assertFalse([n for n in names if n.startswith(("features/calendar", "features/notifications"))])
        self.assertNotIn("shell/messageTray.js", names)
        self.assertNotIn("shell/notificationStore.js", names)
        # The clipboard switcher's input method adapter, local like its tab.
        self.assertNotIn("shell/inputMethod.js", names)
        self.assertNotIn(b"froonty-clipboard-switcher", css)
        self.assertNotIn(b'name="clipboard-switcher-', schema)
        self.assertIn("LICENSE", names)
        self.assertNotIn("panic/camera.js", names)
        self.assertNotIn("features/localFeatures.js", names)
        self.assertIn("features/notes/icons/froonty-fold-up-symbolic.svg", names)
        self.assertNotIn(b"gettext-domain", schema)
        self.assertNotIn(b".froonty-claude", css)
        self.assertNotIn(b"froonty-pill-cue-level", css)
        self.assertIn(b".froonty-pill-cue ", css)
        # Every module of the package parses, without the stripped lines.
        unpacked = os.path.join(out, "x")
        with zipfile.ZipFile(path) as archive:
            archive.extractall(unpacked)
        parse = subprocess.run(["gjs", "-m", os.path.join(ROOT, "tools", "unit", "modules-parse.test.js")],
                               env=dict(os.environ, FROONTY_PARSE_ROOT=unpacked),
                               capture_output=True, text=True)
        self.assertEqual(parse.returncode, 0, parse.stdout + parse.stderr)
        metadata = json.loads(archive_text(path, "metadata.json"))
        self.assertNotIn("gettext-domain", metadata)
        self.assertNotIn("Clipboard", metadata["description"])
        self.assertNotIn(b'name="claude-', schema)
        self.assertNotIn(b"froonty-media-", css)
        self.assertNotIn(b'name="writing-', schema)
        self.assertNotIn(b'name="zerotier-', schema)
        self.assertNotIn(b'name="formulas-', schema)
        self.assertNotIn(b"froonty-formulas", css)
        self.assertNotIn(b'name="calendar-', schema)
        self.assertNotIn(b'name="notifications-', schema)
        self.assertNotIn(b"local-only", schema)
        self.assertNotIn(b"froonty-writing", css)
        self.assertIn(b"froonty-pill", css)


if __name__ == "__main__":
    unittest.main()
