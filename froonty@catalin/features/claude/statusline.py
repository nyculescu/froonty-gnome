#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Froonty's Claude Code status line (docs/features/claude.md).
#
# Claude Code runs this after each reply, with the session's details as
# JSON on stdin (code.claude.com/docs/en/statusline). Its `rate_limits`
# (Session and Weekly, for Claude plans) are saved for Froonty's Claude
# tab; nothing else is kept. Prints the line Claude Code shows:
#
#   Fable · Session 13% · Weekly 33%
#
# Files: $XDG_CACHE_HOME/froonty/claude-status-line.json (~/.cache when
# unset), the same path the Shell side reads (features/claude/service.js).

import json
import os
import sys
import tempfile
import time


def cache_file():
    base = os.environ.get('XDG_CACHE_HOME') or os.path.join(os.path.expanduser('~'), '.cache')
    return os.path.join(base, 'froonty', 'claude-status-line.json')


def is_newer(fresh, old):
    """Whether `fresh` is a newer reading of a window than `old`.

    Claude Code also re-runs the status line of an idle session, with the
    numbers it got at its last reply, perhaps hours ago. So a later window
    wins, an earlier one loses, and within one window the higher use wins
    (use only grows until the window resets). Same rule as Froonty's
    isNewerReading (usage.js).
    """
    def num(window, key):
        value = window.get(key) if isinstance(window, dict) else None
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None

    if num(fresh, 'used_percentage') is None:
        return False
    if num(old, 'used_percentage') is None:
        return True
    fresh_reset, old_reset = num(fresh, 'resets_at'), num(old, 'resets_at')
    if fresh_reset is not None and old_reset is not None and fresh_reset != old_reset:
        return fresh_reset > old_reset
    return num(fresh, 'used_percentage') > num(old, 'used_percentage')


def merged(rate_limits, path):
    """The saved windows with this session's newer ones in place, or None
    when this session has nothing newer (then the file is left as is)."""
    try:
        with open(path) as f:
            old = json.load(f).get('rate_limits')
    except (OSError, ValueError, AttributeError):
        old = None
    if not isinstance(old, dict):
        old = {}
    result = dict(old)
    changed = False
    for key, window in rate_limits.items():
        if is_newer(window, old.get(key)):
            result[key] = window
            changed = True
    return result if changed else None


def save(rate_limits):
    path = cache_file()
    rate_limits = merged(rate_limits, path)
    if rate_limits is None:
        return
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    data = {'writtenAtMs': int(time.time() * 1000), 'rate_limits': rate_limits}
    # A whole new file renamed onto the old one: Froonty never reads half.
    fd, temp = tempfile.mkstemp(dir=os.path.dirname(path), prefix='.claude-status-line.')
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(data, f)
        os.replace(temp, path)
    except BaseException:
        os.unlink(temp)
        raise


def percent(window):
    value = window.get('used_percentage') if isinstance(window, dict) else None
    return f'{round(value)}%' if isinstance(value, (int, float)) else None


def main():
    try:
        status = json.load(sys.stdin)
    except ValueError:
        status = {}
    if not isinstance(status, dict):
        status = {}

    # Absent until the session's first reply, and without a Claude plan.
    rate_limits = status.get('rate_limits')
    parts = []
    if isinstance(rate_limits, dict) and rate_limits:
        try:
            save(rate_limits)
        except OSError as e:
            print(f'Froonty: cannot save Claude usage: {e}', file=sys.stderr)
        for key, name in (('five_hour', 'Session'), ('seven_day', 'Weekly')):
            value = percent(rate_limits.get(key))
            if value:
                parts.append(f'{name} {value}')

    model = status.get('model')
    if isinstance(model, dict) and isinstance(model.get('display_name'), str):
        parts.insert(0, model['display_name'])
    print(' · '.join(parts))


if __name__ == '__main__':
    main()
