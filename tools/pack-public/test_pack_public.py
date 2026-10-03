# SPDX-License-Identifier: GPL-3.0-or-later
"""Tests for the public build's leak guard (check_zip.py) and CSS stripping
(strip_local_css.py), plus one real `tools/pack-public.sh` run into a
temporary folder. Run: python3 -m unittest tools/pack-public/test_pack_public.py
"""

import importlib.util
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
strip_local_css = load("strip_local_css")


def stub(name):
    with open(os.path.join(HERE, name), "rb") as f:
        return f.read()


class CheckZipTest(unittest.TestCase):
    def make_zip(self, extra=None, replace=None):
        folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, folder, True)
        path = os.path.join(folder, "froonty@catalin.shell-extension.zip")
        files = {
            "metadata.json": b"{}",
            "extension.js": b"export default class {}",
            "features/localFeatures.js": stub("localFeatures.js"),
            "features/localPrefs.js": stub("localPrefs.js"),
            "stylesheet.css": b".froonty-pill {}\n",
        }
        files.update(replace or {})
        files.update(extra or {})
        with zipfile.ZipFile(path, "w") as archive:
            for name, data in files.items():
                archive.writestr(name, data)
        return path

    def test_clean_zip_passes(self):
        path = self.make_zip()
        self.assertEqual(check_zip.problems(path, HERE), [])
        check_zip.main(["check_zip.py", path, HERE])
        self.assertTrue(os.path.exists(path))

    def assert_fails(self, path, needle):
        found = check_zip.problems(path, HERE)
        self.assertTrue(any(needle in line for line in found), found)
        with self.assertRaises(SystemExit):
            check_zip.main(["check_zip.py", path, HERE])
        self.assertFalse(os.path.exists(path), "a leaking zip is deleted")

    def test_local_file(self):
        self.assert_fails(self.make_zip({"features/writing/x.js": b"x"}), "local-only file")

    def test_changed_stub(self):
        path = self.make_zip(replace={"features/localFeatures.js": b"import w from './writing/index.js';"})
        self.assert_fails(path, "not the public stub")

    def test_service_address_in_code(self):
        self.assert_fails(self.make_zip({"ui/x.js": b"const u = 'https://api.languagetool.org/v2';"}),
                          "api.languagetool.org")

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


class StripCssTest(unittest.TestCase):
    CSS = (".a {}\n"
           "/* local:begin zerotier (local) */\n.froonty-zerotier {}\n/* local:end zerotier */\n"
           ".b {}\n"
           "/* local:begin writing (local) */\n.froonty-writing {}\n/* local:end writing */\n")

    def test_strips_both(self):
        self.assertEqual(strip_local_css.strip(self.CSS, ["zerotier", "writing"]), ".a {}\n.b {}\n")

    def test_unbalanced(self):
        for broken in (self.CSS.replace("/* local:end writing */\n", ""),
                       self.CSS.replace("/* local:begin zerotier (local) */\n", ""),
                       self.CSS.replace("/* local:end zerotier */\n", "/* local:end writing */\n")):
            with self.assertRaises(ValueError):
                strip_local_css.strip(broken, ["zerotier", "writing"])

    def test_nested_and_missing(self):
        nested = "/* local:begin writing */\n/* local:begin zerotier */\n/* local:end zerotier */\n/* local:end writing */\n"
        with self.assertRaises(ValueError):
            strip_local_css.strip(nested, ["zerotier", "writing"])
        with self.assertRaises(ValueError):
            strip_local_css.strip(".a {}\n", ["writing"])


class PackTest(unittest.TestCase):
    def test_pack_public(self):
        out = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, out, True)
        env = dict(os.environ, PACK_OUT_DIR=out)
        dirs = sorted(d for d in os.listdir(os.path.join(ROOT, "froonty@catalin"))
                      if os.path.isdir(os.path.join(ROOT, "froonty@catalin", d)) and d != "schemas")
        result = subprocess.run(["bash", os.path.join(ROOT, "tools", "pack-public.sh"), "froonty@catalin", *dirs],
                                cwd=ROOT, env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        path = os.path.join(out, "froonty@catalin.shell-extension.zip")
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            schema = archive.read("schemas/org.gnome.shell.extensions.froonty.gschema.xml")
            css = archive.read("stylesheet.css")
        self.assertFalse([n for n in names if n.startswith(("features/writing", "features/zerotier"))])
        self.assertNotIn(b'name="writing-', schema)
        self.assertNotIn(b'name="zerotier-', schema)
        self.assertNotIn(b"local-only", schema)
        self.assertNotIn(b"froonty-writing", css)
        self.assertIn(b"froonty-pill", css)


if __name__ == "__main__":
    unittest.main()
