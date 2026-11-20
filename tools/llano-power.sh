#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# The llano pad around log-out, shutdown, restart and sleep, for
# llano-session.service (the user's session), llano-off.service and
# llano-sleep.service (the system, as root).
#   llano-power.sh off MARKER        the pad off; MARKER notes that it was on
#   llano-power.sh restore MARKER    back on at 300 rpm if MARKER is there
#   llano-power.sh sleep-off SAVED   the pad off; SAVED keeps its speed and control
#   llano-power.sh wake SAVED        back to that speed and control
# $LLANO is llano.py's path. Never fails, so a missing pad holds nothing up.
set -u
cmd=$1
marker=$2
llano() { /usr/bin/python3 "$LLANO" "$@"; }

case $cmd in
off)
    status=$(llano status 2>/dev/null) || exit 0
    case $status in
    *"pad off"*)
        # Already off (or locked off): llano.py off would flash it on first.
        ;;
    *)
        dir=$(dirname "$marker")
        # As root, never make the user's folder: llano.py could not write there then.
        [ -d "$dir" ] || [ "$(id -u)" = 0 ] || mkdir -p "$dir"
        [ -d "$dir" ] && : >"$marker"
        llano off >/dev/null 2>&1
        ;;
    esac
    ;;
restore)
    [ -e "$marker" ] || exit 0
    rm -f "$marker"
    llano rpm 300 >/dev/null 2>&1
    ;;
sleep-off)
    status=$(llano status 2>/dev/null) || exit 0
    case $status in *"pad off"*) exit 0 ;; esac
    # "speed 20% (software control)" -> "20 software"
    saved=$(printf '%s\n' "$status" | sed -n 's/.*speed \([0-9]*\)% (\([a-z]*\) control).*/\1 \2/p')
    [ -n "$saved" ] || exit 0
    mkdir -p "$(dirname "$marker")"
    printf '%s\n' "$saved" >"$marker"
    llano off >/dev/null 2>&1
    ;;
wake)
    [ -e "$marker" ] || exit 0
    read -r speed control <"$marker"
    rm -f "$marker"
    # The pad may come back on USB a moment after the computer wakes.
    for _ in 1 2 3 4 5; do
        llano status >/dev/null 2>&1 && break
        sleep 1
    done
    llano speed "$speed" >/dev/null 2>&1 || exit 0
    [ "$control" = pad ] && llano release >/dev/null 2>&1
    ;;
esac
exit 0
