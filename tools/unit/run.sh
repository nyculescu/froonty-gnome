#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Runs every tools/unit/*.test.js with plain gjs (no GNOME Shell needed).
#
# Isolation: each run gets its own temporary root for TMPDIR and
# XDG_DATA_HOME, so temporary folders and trashed test files (Gio puts
# them in $XDG_DATA_HOME/Trash when on the home file system) never reach
# the real ~/.local/share/Trash. The root is deleted afterwards.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GJS=${GJS:-/usr/bin/gjs}

# Under ~/.cache, not /tmp: GLib refuses to trash on system internal mounts,
# and /tmp is one (a tmpfs on Ubuntu 26.04). On the home file system Gio
# trashes into the private $XDG_DATA_HOME/Trash below.
CACHE=${XDG_CACHE_HOME:-$HOME/.cache}
mkdir -p "$CACHE"
ROOT=$(mktemp -d -p "$CACHE" froonty-unit.XXXXXX)
trap 'rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT/tmp" "$ROOT/data"
export TMPDIR=$ROOT/tmp
export XDG_DATA_HOME=$ROOT/data
export GSETTINGS_BACKEND=memory
export FROONTY_UNIT_ISOLATED=1

status=0
for t in "$HERE"/*.test.js; do
    echo "== $(basename "$t")"
    "$GJS" -m "$t" || status=1
done
exit $status
