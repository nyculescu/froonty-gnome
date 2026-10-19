#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Runs every tools/unit/*.test.js with plain gjs (no GNOME Shell needed).
#
# Isolation: each run gets its own temporary root for TMPDIR and the XDG
# data, config, cache and runtime folders, so temporary folders and
# trashed test files (Gio puts them in $XDG_DATA_HOME/Trash when on the
# home file system) never reach the real ~/.local/share/Trash, and no test
# can touch the real ~/.config/systemd/user or Froonty's real folders. The
# root is deleted afterwards. The Python helpers' tests (test_*.py) run
# too.
#
# GTK tests (*.gtk.test.js: pages of the settings window) get a display of
# their own: a private Broadway server (GTK's HTML5 backend, from GTK's
# libgtk-4-bin; nothing shows on screen), its socket in a private runtime
# folder, so parallel runs never meet. No test sees the session's display.
#
# Parallel: the test files run JOBS at a time (default: half the logical
# CPUs), each in a root of its own (its own TMPDIR, XDG folders and, for GTK
# tests, Broadway server), so they cannot see each other's files. Each
# file's output is printed whole, in file order, as soon as it and every
# file before it are done. JOBS=1 runs them one after another. The GTK
# files, the slowest (fixed waits for the widgets), are split into
# GTK_SHARDS processes each (FROONTY_TEST_SHARD, test.js); GTK_SHARDS=1
# keeps each whole.
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
JOBS=${JOBS:-$(( $(nproc) / 2 > 0 ? $(nproc) / 2 : 1 ))}
GTK_SHARDS=${GTK_SHARDS:-4}
trap 'kill $(jobs -p) 2>/dev/null; wait 2>/dev/null; rm -rf "$ROOT"' EXIT
export GSETTINGS_BACKEND=memory
export FROONTY_UNIT_ISOLATED=1
# Dates and numbers read the same whatever the user's locale.
export LC_ALL=C.UTF-8

# A private root: TMPDIR, the XDG folders and Claude Code's config folder
# (so a default claudeSettingsFile() can never reach the real ~/.claude).
make_root() {
    local r=$1
    mkdir -p "$r/tmp" "$r/data" "$r/config" "$r/cache" "$r/claude"
    mkdir -m 700 "$r/runtime"
}

# Display :0 of the root's runtime folder listens on broadway1.socket there.
start_broadway() {
    local r=$1
    if [[ ! -x "$BROADWAYD" ]]; then
        echo "FAIL $BROADWAYD not found (GTK's libgtk-4-bin): the GTK tests need it"
        return 1
    fi
    # Its web server on a socket of the root too, not TCP port 8080 (shared by
    # every display :0, so parallel GTK tests would collide there).
    XDG_RUNTIME_DIR=$r/runtime "$BROADWAYD" --unixsocket="$r/runtime/broadway-http.socket" :0 \
        >"$r/broadway.log" 2>&1 &
    echo $! >"$r/broadway.pid"
    for _ in $(seq 50); do
        [[ -S "$r/runtime/broadway1.socket" ]] && return 0
        sleep 0.1
    done
    echo "FAIL gtk4-broadwayd did not start:"
    cat "$r/broadway.log"
    return 1
}

# Runs one test file (shard $3, i/n) in root $2; its output goes to $2/out,
# its status to $2/rc.
run_one() {
    local t=$1 r=$2 part=$3 rc=0
    make_root "$r"
    (
        export TMPDIR=$r/tmp XDG_DATA_HOME=$r/data XDG_CONFIG_HOME=$r/config XDG_CACHE_HOME=$r/cache \
            XDG_RUNTIME_DIR=$r/runtime CLAUDE_CONFIG_DIR=$r/claude
        unset DISPLAY WAYLAND_DISPLAY
        export FROONTY_TEST_SHARD=$part
        if [[ "$part" == 0/1 ]]; then
            echo "== $(basename "$t")"
        else
            echo "== $(basename "$t") [${part%/*} of ${part#*/}]"
        fi
        if [[ "$t" == *.gtk.test.js ]]; then
            start_broadway "$r" || exit 1
            GDK_BACKEND=broadway BROADWAY_DISPLAY=:0 GTK_A11Y=none GDK_DEBUG=no-portals "$GJS" -m "$t"
            rc=$?
            kill "$(cat "$r/broadway.pid")" 2>/dev/null
            exit $rc
        elif [[ "$t" == *.py ]]; then
            PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -q "$t"
        else
            "$GJS" -m "$t"
        fi
    ) >"$r/out" 2>&1 </dev/null || rc=$?
    # A file that failed to load or threw prints no FAIL line of its own.
    if (( rc != 0 )) && ! grep -q '^FAIL' "$r/out"; then
        echo "FAIL $(basename "$t"): exited with status $rc" >>"$r/out"
    fi
    echo $rc >"$r/rc"
}

TESTS=() PARTS=()
for t in "$HERE"/*.test.js "$HERE"/test_*.py; do
    n=1
    [[ "$t" == *.gtk.test.js ]] && n=$GTK_SHARDS
    for (( k = 0; k < n; k++ )); do
        TESTS+=("$t")
        PARTS+=("$k/$n")
    done
done
for i in "${!TESTS[@]}"; do
    while (( $(jobs -rp | wc -l) >= JOBS )); do
        wait -n
    done
    run_one "${TESTS[$i]}" "$ROOT/$i" "${PARTS[$i]}" &
done

status=0
for i in "${!TESTS[@]}"; do
    while [[ ! -e "$ROOT/$i/rc" ]]; do
        sleep 0.05
    done
    cat "$ROOT/$i/out"
    [[ "$(cat "$ROOT/$i/rc")" == 0 ]] || status=1
done
wait
exit $status
