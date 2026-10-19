# SPDX-License-Identifier: GPL-3.0-or-later
"""The Break tab's Garmin helper (docs/features/break.md, "Garmin").

Runs only in its own Python environment (a venv Settings → Break makes,
~/.local/share/froonty/garmin/venv), in a process of its own: never
inside GNOME Shell. It uses python-garminconnect (unofficial; Garmin may
block it at any time: then it says so and Froonty goes on without it).

    helper.py check            {"ok": true, "signedIn": bool, "library": "0.3.19"}
    helper.py login            stdin: {"email": ..., "password": ...} (one
                               line); when Garmin asks for a code it prints
                               {"need": "mfa"} and reads {"mfa": "123456"}
    helper.py today YYYY-MM-DD {"ok": true, "activities": [...], "intensity": {...}}
    helper.py logout           deletes the sign-in tokens

Every command prints one JSON line (a failure: {"ok": false, "error":
"auth" | "blocked" | "network" | "setup" | "other", "message": ...}) and
records it in status.json (no activity data, no account data but the
name shown in Settings).

Credentials: the password is used once, for the sign-in, and never
written anywhere. What the library keeps is its sign-in tokens,
garmin_tokens.json (0600) in tokens/ (0700), in the folder below: on this
computer only, outside any repository. Sign out deletes them.
"""

import datetime
import json
import os
import shutil
import sys
from pathlib import Path


def data_dir():
    base = os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    return Path(base) / "froonty" / "garmin"


TOKENS = data_dir() / "tokens"
STATUS = data_dir() / "status.json"
# An activity is a workout from this long (the Break tab's rule).
MIN_ACTIVITY_SECONDS = 10 * 60


def previous_status():
    try:
        return json.loads(STATUS.read_text())
    except (OSError, ValueError):
        return {}


def emit(result):
    """Prints `result` as one JSON line and records it (without data):
    whether it worked, whether signed in, the account's name (kept from
    the sign-in), when."""
    print(json.dumps(result), flush=True)
    status = {k: v for k, v in result.items() if k in ("ok", "error", "message", "name")}
    status["signedIn"] = signed_in()
    if "name" not in status and status["signedIn"]:
        name = previous_status().get("name")
        if isinstance(name, str):
            status["name"] = name
    status["at"] = datetime.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M")
    try:
        data_dir().mkdir(mode=0o700, parents=True, exist_ok=True)
        tmp = STATUS.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(status, f)
        os.replace(tmp, STATUS)
    except OSError:
        pass


def fail(error, message):
    emit({"ok": False, "error": error, "message": str(message)[:300]})
    return 1


def library():
    """The library, or None (the venv is not set up)."""
    try:
        import garminconnect
    except ImportError:
        return None
    return garminconnect


def classify(gc, error):
    """An exception of the library's → one of Froonty's error names."""
    if isinstance(error, gc.GarminConnectTooManyRequestsError):
        return "blocked"
    if isinstance(error, gc.GarminConnectAuthenticationError):
        return "auth"
    if isinstance(error, gc.GarminConnectConnectionError):
        text = str(error).lower()
        return "blocked" if ("403" in text or "cloudflare" in text or "429" in text) else "network"
    return "other"


def signed_in():
    return (TOKENS / "garmin_tokens.json").is_file()


def cmd_check(gc):
    try:
        from importlib.metadata import version
        lib = version("garminconnect")
    except Exception:
        lib = None
    emit({"ok": True, "signedIn": signed_in(), "library": lib})
    return 0


def cmd_login(gc):
    line = sys.stdin.readline()
    try:
        creds = json.loads(line)
        email, password = creds["email"], creds["password"]
    except (ValueError, KeyError, TypeError):
        return fail("other", "no email and password given")

    def prompt_mfa():
        print(json.dumps({"need": "mfa"}), flush=True)
        try:
            return str(json.loads(sys.stdin.readline())["mfa"]).strip()
        except (ValueError, KeyError, TypeError):
            return ""

    TOKENS.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(TOKENS, 0o700)
    client = gc.Garmin(email, password, prompt_mfa=prompt_mfa)
    del password, creds
    try:
        client.login(str(TOKENS))
    except Exception as e:  # the library's own, or the network's
        return fail(classify(gc, e), e)
    name = getattr(client, "full_name", None) or getattr(client, "display_name", None)
    emit({"ok": True, "signedIn": signed_in(), "name": name})
    return 0


def activity(a):
    """One of Garmin's activities → Froonty's {id, type, name, start, seconds}, or None."""
    try:
        start = datetime.datetime.strptime(a["startTimeGMT"], "%Y-%m-%d %H:%M:%S")
        start = start.replace(tzinfo=datetime.timezone.utc)
        seconds = float(a.get("elapsedDuration") or a.get("duration") or 0)
    except (KeyError, TypeError, ValueError):
        return None
    if seconds < MIN_ACTIVITY_SECONDS:
        return None
    return {
        "id": str(a.get("activityId")),
        "type": (a.get("activityType") or {}).get("typeKey") or "other",
        "name": str(a.get("activityName") or "")[:80],
        "start": int(start.timestamp() * 1000),
        "seconds": int(seconds),
    }


def cmd_today(gc, day):
    try:
        datetime.date.fromisoformat(day)
    except ValueError:
        return fail("other", "bad date")
    if not signed_in():
        return fail("auth", "not signed in")
    client = gc.Garmin()
    try:
        client.login(str(TOKENS))
        raw = client.get_activities_by_date(day, day) or []
        summary = client.get_user_summary(day) or {}
    except Exception as e:
        return fail(classify(gc, e), e)
    activities = [x for x in (activity(a) for a in raw if isinstance(a, dict)) if x]
    emit({
        "ok": True,
        "date": day,
        "activities": activities,
        "intensity": {
            "moderate": int(summary.get("moderateIntensityMinutes") or 0),
            "vigorous": int(summary.get("vigorousIntensityMinutes") or 0),
        },
    })
    return 0


def cmd_logout():
    shutil.rmtree(TOKENS, ignore_errors=True)
    emit({"ok": True, "signedIn": False})
    return 0


def main(argv):
    command = argv[1] if len(argv) > 1 else ""
    if command == "logout":
        return cmd_logout()
    gc = library()
    if gc is None:
        return fail("setup", "python-garminconnect is not installed in this environment")
    if command == "check":
        return cmd_check(gc)
    if command == "login":
        return cmd_login(gc)
    if command == "today" and len(argv) > 2:
        return cmd_today(gc, argv[2])
    return fail("other", f"unknown command {command!r}")


if __name__ == "__main__":
    sys.exit(main(sys.argv))
