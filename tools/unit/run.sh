#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Runs every tools/unit/*.test.js with plain gjs (no GNOME Shell needed).
#
# Isolation: each run gets its own temporary root for TMPDIR and the XDG
# data, config, cache and runtime folders, so temporary folders and
# trashed test files (Gio puts them in $XDG_DATA_HOME/Trash when on the
# home file system) never reach the real ~/.local/share/Trash, and no test
# can touch the real ~/.config/systemd/user or Froonty's real folders. The
# root is deleted afterwards. Then the public build's leak-guard tests
# (tools/pack-public/test_pack_public.py) run too.
#
# GTK tests (*.gtk.test.js: pages of the settings window) get a display of
# their own: a private Broadway server (GTK's HTML5 backend, from GTK's
# libgtk-4-bin; nothing shows on screen), its socket in a private runtime
# folder, so parallel runs never meet.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GJS=${GJS:-/usr/bin/gjs}
BROADWAYD=${BROADWAYD:-/usr/bin/gtk4-broadwayd}

# Under ~/.cache, not /tmp: GLib refuses to trash on system internal mounts,
# and /tmp is one (a tmpfs on Ubuntu 26.04). On the home file system Gio
# trashes into the private $XDG_DATA_HOME/Trash below.
CACHE=${XDG_CACHE_HOME:-$HOME/.cache}
mkdir -p "$CACHE"
ROOT=$(mktemp -d -p "$CACHE" froonty-unit.XXXXXX)
broadway_pid=
trap '[[ -n "$broadway_pid" ]] && kill "$broadway_pid" 2>/dev/null; rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT/tmp" "$ROOT/data" "$ROOT/config" "$ROOT/cache" "$ROOT/claude"
mkdir -m 700 "$ROOT/runtime"
export TMPDIR=$ROOT/tmp
export XDG_DATA_HOME=$ROOT/data
export XDG_CONFIG_HOME=$ROOT/config
export XDG_CACHE_HOME=$ROOT/cache
export XDG_RUNTIME_DIR=$ROOT/runtime
# Claude Code's config folder: a private one, so a default
# claudeSettingsFile() can never reach the real ~/.claude.
export CLAUDE_CONFIG_DIR=$ROOT/claude
export GSETTINGS_BACKEND=memory
export FROONTY_UNIT_ISOLATED=1

# Display :0 of a private runtime folder listens on broadway1.socket there.
start_broadway() {
    [[ -n "$broadway_pid" ]] && return 0
    if [[ ! -x "$BROADWAYD" ]]; then
        echo "FAIL $BROADWAYD not found (GTK's libgtk-4-bin): the GTK tests need it"
        return 1
    fi
    mkdir -p -m 700 "$ROOT/runtime"
    XDG_RUNTIME_DIR=$ROOT/runtime "$BROADWAYD" :0 >"$ROOT/broadway.log" 2>&1 &
    broadway_pid=$!
    for _ in $(seq 50); do
        [[ -S "$ROOT/runtime/broadway1.socket" ]] && return 0
        sleep 0.1
    done
    echo "FAIL gtk4-broadwayd did not start:"
    cat "$ROOT/broadway.log"
    return 1
}

status=0
for t in "$HERE"/*.test.js; do
    echo "== $(basename "$t")"
    if [[ "$t" == *.gtk.test.js ]]; then
        start_broadway || { status=1; continue; }
        XDG_RUNTIME_DIR=$ROOT/runtime GDK_BACKEND=broadway BROADWAY_DISPLAY=:0 \
            GTK_A11Y=none GDK_DEBUG=no-portals "$GJS" -m "$t" || status=1
    else
        "$GJS" -m "$t" || status=1
    fi
done
echo "== test_pack_public.py"
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -q "$HERE/../pack-public/test_pack_public.py" || status=1
exit $status
