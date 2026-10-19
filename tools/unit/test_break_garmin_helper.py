# SPDX-License-Identifier: GPL-3.0-or-later
"""The Break tab's Garmin helper (froonty@catalin/features/break/garmin/helper.py)
with a fake python-garminconnect: what it prints, what it keeps on disk
(never the password, no activity data), its error names. Nothing reaches
Garmin. Run by tools/unit/run.sh (python3 -m unittest)."""

import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

HELPER = Path(__file__).resolve().parent.parent.parent / "froonty@catalin" / "features" / "break" / "garmin" / "helper.py"
PASSWORD = "correct horse battery staple"


def fake_library(activities=None, error=None, mfa=False):
    gc = types.ModuleType("garminconnect")

    class GarminConnectConnectionError(Exception):
        pass

    class GarminConnectTooManyRequestsError(Exception):
        pass

    class GarminConnectAuthenticationError(Exception):
        pass

    class Garmin:
        def __init__(self, email=None, password=None, prompt_mfa=None):
            self.password = password
            self.prompt_mfa = prompt_mfa
            self.full_name = "Test Person"

        def login(self, tokenstore):
            if error:
                raise error
            path = Path(tokenstore) / "garmin_tokens.json"
            if self.password is not None:
                if mfa and self.prompt_mfa() != "123456":
                    raise GarminConnectAuthenticationError("bad code")
                path.write_text(json.dumps({"di_refresh_token": "t"}))
            elif not path.is_file():
                raise GarminConnectAuthenticationError("no tokens")
            return None, None

        def get_activities_by_date(self, start, end):
            return activities or []

        def get_user_summary(self, day):
            return {"moderateIntensityMinutes": 20, "vigorousIntensityMinutes": 5}

    gc.Garmin = Garmin
    gc.GarminConnectConnectionError = GarminConnectConnectionError
    gc.GarminConnectTooManyRequestsError = GarminConnectTooManyRequestsError
    gc.GarminConnectAuthenticationError = GarminConnectAuthenticationError
    return gc


class HelperTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = os.environ.get("XDG_DATA_HOME")
        os.environ["XDG_DATA_HOME"] = self.tmp.name
        spec = importlib.util.spec_from_file_location("garmin_helper", HELPER)
        self.helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.helper)

    def tearDown(self):
        sys.modules.pop("garminconnect", None)
        if self.old is None:
            os.environ.pop("XDG_DATA_HOME", None)
        else:
            os.environ["XDG_DATA_HOME"] = self.old
        self.tmp.cleanup()

    def run_cmd(self, argv, stdin="", library=None):
        if library is not None:
            sys.modules["garminconnect"] = library
        out = io.StringIO()
        old_stdin = sys.stdin
        sys.stdin = io.StringIO(stdin)
        try:
            with contextlib.redirect_stdout(out):
                code = self.helper.main(["helper.py", *argv])
        finally:
            sys.stdin = old_stdin
        lines = [json.loads(line) for line in out.getvalue().splitlines() if line.strip()]
        return code, lines

    def all_files_text(self):
        text = ""
        for path in Path(self.tmp.name).rglob("*"):
            if path.is_file():
                text += path.read_text(errors="replace")
        return text

    def test_without_the_library_it_says_set_up(self):
        sys.modules["garminconnect"] = None  # import fails
        code, lines = self.run_cmd(["check"])
        self.assertEqual(code, 1)
        self.assertEqual(lines[-1]["error"], "setup")

    def test_sign_in_keeps_tokens_never_the_password(self):
        creds = json.dumps({"email": "a@b.c", "password": PASSWORD}) + "\n"
        code, lines = self.run_cmd(["login"], creds, fake_library())
        self.assertEqual(code, 0)
        self.assertTrue(lines[-1]["ok"])
        self.assertEqual(lines[-1]["name"], "Test Person")
        tokens = Path(self.tmp.name) / "froonty" / "garmin" / "tokens"
        self.assertTrue((tokens / "garmin_tokens.json").is_file())
        self.assertEqual(tokens.stat().st_mode & 0o777, 0o700)
        self.assertNotIn(PASSWORD, self.all_files_text())
        status = json.loads((Path(self.tmp.name) / "froonty" / "garmin" / "status.json").read_text())
        self.assertEqual(status["signedIn"], True)
        self.assertEqual((Path(self.tmp.name) / "froonty" / "garmin" / "status.json").stat().st_mode & 0o777, 0o600)

    def test_two_step_code_is_asked_on_stdout_and_read_from_stdin(self):
        stdin = json.dumps({"email": "a@b.c", "password": PASSWORD}) + "\n" + json.dumps({"mfa": "123456"}) + "\n"
        code, lines = self.run_cmd(["login"], stdin, fake_library(mfa=True))
        self.assertEqual(code, 0)
        self.assertEqual(lines[0], {"need": "mfa"})
        self.assertTrue(lines[-1]["ok"])

    def test_today_lists_activities_of_ten_minutes_or_more_and_keeps_no_data(self):
        activities = [
            {"activityId": 11, "activityName": "Gym", "startTimeGMT": "2026-10-16 15:00:00",
             "elapsedDuration": 3000, "activityType": {"typeKey": "strength_training"}},
            {"activityId": 12, "startTimeGMT": "2026-10-16 18:00:00", "duration": 300,
             "activityType": {"typeKey": "walking"}},
            {"activityId": 13, "startTimeGMT": "broken"},
        ]
        self.run_cmd(["login"], json.dumps({"email": "a", "password": "b"}) + "\n", fake_library())
        code, lines = self.run_cmd(["today", "2026-10-16"], library=fake_library(activities))
        self.assertEqual(code, 0)
        result = lines[-1]
        self.assertEqual([a["id"] for a in result["activities"]], ["11"])
        self.assertEqual(result["activities"][0]["type"], "strength_training")
        self.assertEqual(result["activities"][0]["start"], 1792162800000)
        self.assertEqual(result["intensity"], {"moderate": 20, "vigorous": 5})
        status = (Path(self.tmp.name) / "froonty" / "garmin" / "status.json").read_text()
        self.assertNotIn("strength_training", status)
        self.assertIn("Test Person", status, "the name is kept from the sign-in")

    def test_today_without_a_sign_in_is_auth(self):
        code, lines = self.run_cmd(["today", "2026-10-16"], library=fake_library())
        self.assertEqual(lines[-1]["error"], "auth")

    def test_error_names(self):
        gc = fake_library()
        self.assertEqual(self.helper.classify(gc, gc.GarminConnectTooManyRequestsError("x")), "blocked")
        self.assertEqual(self.helper.classify(gc, gc.GarminConnectAuthenticationError("x")), "auth")
        self.assertEqual(self.helper.classify(gc, gc.GarminConnectConnectionError("403 Forbidden")), "blocked")
        self.assertEqual(self.helper.classify(gc, gc.GarminConnectConnectionError("timed out")), "network")
        self.assertEqual(self.helper.classify(gc, ValueError("x")), "other")

    def test_logout_deletes_the_tokens(self):
        self.run_cmd(["login"], json.dumps({"email": "a", "password": "b"}) + "\n", fake_library())
        code, lines = self.run_cmd(["logout"])
        self.assertEqual(code, 0)
        self.assertFalse((Path(self.tmp.name) / "froonty" / "garmin" / "tokens").exists())
        self.assertEqual(lines[-1]["signedIn"], False)


if __name__ == "__main__":
    unittest.main()
