#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Try Froonty in a GNOME Shell 50 running in a window on your desktop
# (gnome-shell --devkit; needs the mutter-dev-bin package), isolated from
# your session as the headless tests are: its own D-Bus buses, settings
# (keyfile backend), data, cache and runtime folders, and its own PipeWire
# with a virtual speaker and microphone (no sound hardware). Your real
# settings, notes, calendars, extensions, drives and phones are not seen.
# Claude Code's folder is a private one, and the Claude tab's CLI is a
# stand-in, so nothing reaches your Claude account.
#
# The sandbox lives in ~/.cache/froonty-devkit and is kept between runs
# (your test notes, settings, …). Close the window to stop.
#
# Usage: tools/devkit.sh [--reset] [--public]
#          --reset   start from an empty sandbox
#          --public  run the `make pack` build (what extensions.gnome.org gets)
#                    instead of the working tree
#        tools/devkit.sh run COMMAND…   run a command inside the running
#                    sandbox, e.g. tools/devkit.sh run notify-send Hello World

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
UUID=froonty@catalin
SANDBOX=${FROONTY_DEVKIT_DIR:-$HOME/.cache/froonty-devkit}
GNOME_SHELL=${GNOME_SHELL:-/usr/bin/gnome-shell}
NESTED_DISPLAY=wayland-froonty-devkit

if [[ "${1:-}" == "run" ]]; then
    shift
    [[ -f "$SANDBOX/env" ]] || { echo "the devkit is not running" >&2; exit 1; }
    # shellcheck disable=SC1091
    set -a; . "$SANDBOX/env"; set +a
    exec "$@"
fi

if [[ "${1:-}" == "--inner" ]]; then
    # Inside the sandbox's own session bus.
    nice -n 10 /usr/bin/pipewire >"$SANDBOX/pipewire.log" 2>&1 &
    audio="$!"
    nice -n 10 /usr/bin/wireplumber >"$SANDBOX/wireplumber.log" 2>&1 &
    audio="$audio $!"
    nice -n 10 /usr/bin/pipewire-pulse >"$SANDBOX/pipewire-pulse.log" 2>&1 &
    audio="$audio $!"
    shell=
    # Ctrl+C or a kill: the devkit window first (the Shell's child), then
    # the Shell and the sandbox's PipeWire.
    trap '[[ -n "$shell" ]] && { pkill -P "$shell" -f mutter-devkit; kill "$shell"; wait "$shell"; } 2>/dev/null
        kill $audio 2>/dev/null; rm -f "$SANDBOX/env"' EXIT
    trap 'exit 130' INT TERM
    sleep 1

    # The devkit window draws on your desktop (wayland-host); apps the
    # sandbox starts (the settings window, notify-send's sender) belong in
    # the nested Shell.
    nice -n 10 "$GNOME_SHELL" --devkit --wayland-display "$NESTED_DISPLAY" \
        >"$SANDBOX/shell.log" 2>&1 &
    shell=$!
    for _ in $(seq 100); do
        [[ -S "$XDG_RUNTIME_DIR/$NESTED_DISPLAY" ]] && break
        sleep 0.2
    done
    /usr/bin/dbus-update-activation-environment WAYLAND_DISPLAY="$NESTED_DISPLAY" GDK_BACKEND=wayland
    {
        echo "DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS"
        echo "DBUS_SYSTEM_BUS_ADDRESS=$DBUS_SYSTEM_BUS_ADDRESS"
        for name in XDG_DATA_HOME XDG_CONFIG_HOME XDG_CACHE_HOME XDG_STATE_HOME XDG_RUNTIME_DIR \
            GSETTINGS_BACKEND CLAUDE_CONFIG_DIR FROONTY_CLAUDE_CODE GIO_USE_VOLUME_MONITOR; do
            echo "$name=${!name}"
        done
        echo "WAYLAND_DISPLAY=$NESTED_DISPLAY"
        echo "GDK_BACKEND=wayland"
        echo "FROONTY_DEVKIT_PID=$$"
    } >"$SANDBOX/env"
    echo "Froonty devkit running (close its window to stop). Log: $SANDBOX/shell.log"
    wait "$shell" || true
    exit 0
fi

[[ -x /usr/libexec/mutter-devkit ]] ||
    { echo "gnome-shell --devkit needs mutter-devkit: sudo apt install mutter-dev-bin" >&2; exit 1; }
[[ -n "${WAYLAND_DISPLAY:-}" ]] ||
    { echo "run this from a Wayland session (WAYLAND_DISPLAY is not set)" >&2; exit 1; }
if [[ -e "$SANDBOX/env" ]]; then
    running=$(sed -n 's/^FROONTY_DEVKIT_PID=//p' "$SANDBOX/env")
    if [[ -n "$running" ]] && kill -0 "$running" 2>/dev/null; then
        echo "a devkit is already running ($SANDBOX)" >&2
        exit 1
    fi
    rm -f "$SANDBOX/env"
fi

RESET= PUBLIC=
for arg in "$@"; do
    case "$arg" in
    --reset) RESET=1 ;;
    --public) PUBLIC=1 ;;
    *) echo "unknown option $arg" >&2; exit 2 ;;
    esac
done
[[ -n "$RESET" ]] && rm -rf "$SANDBOX"

HOST_WAYLAND=$WAYLAND_DISPLAY
[[ "$HOST_WAYLAND" == /* ]] || HOST_WAYLAND=$XDG_RUNTIME_DIR/$HOST_WAYLAND

export XDG_DATA_HOME=$SANDBOX/data
export XDG_CONFIG_HOME=$SANDBOX/config
export XDG_CACHE_HOME=$SANDBOX/cache
export XDG_STATE_HOME=$SANDBOX/state
export XDG_RUNTIME_DIR=$SANDBOX/runtime
export GSETTINGS_BACKEND=keyfile
# Your drives and phones stay out of the sandbox's Shell.
export GIO_USE_VOLUME_MONITOR=unix
export CLAUDE_CONFIG_DIR=$SANDBOX/claude
export FROONTY_CLAUDE_CODE=$SANDBOX/claude-stand-in
unset DISPLAY GTK_MODULES CLAUDE_CODE_ENTRYPOINT CLAUDE_PID CLAUDE_CODE_SESSION_ID \
    CLAUDE_PROJECT_DIR VSCODE_PID

mkdir -p "$XDG_DATA_HOME/gnome-shell/extensions" "$XDG_CONFIG_HOME/glib-2.0/settings" \
    "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$CLAUDE_CONFIG_DIR" \
    "$XDG_CONFIG_HOME/pipewire/pipewire.conf.d" "$XDG_CONFIG_HOME/wireplumber/wireplumber.conf.d"
rm -rf "$XDG_RUNTIME_DIR"
mkdir -m 700 "$XDG_RUNTIME_DIR"
ln -s "$HOST_WAYLAND" "$XDG_RUNTIME_DIR/wayland-host"
export WAYLAND_DISPLAY=wayland-host

printf '#!/bin/sh\nexit 0\n' >"$FROONTY_CLAUDE_CODE"
chmod +x "$FROONTY_CLAUDE_CODE"

# A virtual speaker and microphone for the panic mute buttons; PipeWire
# never sees your sound card, camera or Bluetooth.
cat >"$XDG_CONFIG_HOME/pipewire/pipewire.conf.d/froonty-devkit.conf" <<'CONF'
context.objects = [
    { factory = adapter args = { factory.name = support.null-audio-sink
        node.name = "froonty-devkit-speaker" node.description = "Devkit speaker"
        media.class = Audio/Sink object.linger = true audio.position = [ FL FR ] } }
    { factory = adapter args = { factory.name = support.null-audio-sink
        node.name = "froonty-devkit-mic" node.description = "Devkit microphone"
        media.class = Audio/Source/Virtual object.linger = true audio.position = [ MONO ]
        priority.session = 2000 } }
]
CONF
cat >"$XDG_CONFIG_HOME/wireplumber/wireplumber.conf.d/51-froonty-devkit.conf" <<'CONF'
wireplumber.profiles = {
  main = {
    hardware.audio = disabled
    hardware.bluetooth = disabled
    hardware.video-capture = disabled
    monitor.alsa = disabled
    monitor.alsa-midi = disabled
    monitor.bluez = disabled
    monitor.bluez-midi = disabled
    monitor.v4l2 = disabled
    monitor.libcamera = disabled
  }
}
CONF

EXTENSION="$XDG_DATA_HOME/gnome-shell/extensions/$UUID"
rm -rf "$EXTENSION"
if [[ -n "$PUBLIC" ]]; then
    PACK=$SANDBOX/pack
    rm -rf "$PACK"
    mkdir -p "$PACK/zip" "$EXTENSION"
    PACK_OUT_DIR=$PACK/zip make -C "$REPO" --no-print-directory pack
    (cd "$EXTENSION" && unzip -q "$PACK/zip/$UUID.shell-extension.zip")
    /usr/bin/glib-compile-schemas --strict "$EXTENSION/schemas"
else
    make -C "$REPO" --no-print-directory schemas >/dev/null
    ln -s "$REPO/$UUID" "$EXTENSION"
fi

# First run only: Froonty on, GNOME's welcome tour off. Later runs keep
# what you changed in the sandbox.
KEYFILE=$XDG_CONFIG_HOME/glib-2.0/settings/keyfile
if [[ ! -f "$KEYFILE" ]]; then
    cat >"$KEYFILE" <<EOF
[org/gnome/shell]
enabled-extensions=['$UUID']
disable-user-extensions=false
welcome-dialog-last-shown-version='999'
EOF
fi

# A private, empty system bus: no real logind, GDM or NetworkManager.
/usr/bin/dbus-daemon --session --nofork --address="unix:path=$SANDBOX/system_bus" \
    >"$SANDBOX/system_bus.log" 2>&1 &
system_bus=$!
trap 'kill "$system_bus" 2>/dev/null; rm -f "$SANDBOX/env" "$SANDBOX/system_bus"' EXIT
export DBUS_SYSTEM_BUS_ADDRESS=unix:path=$SANDBOX/system_bus
sleep 0.3

# The session bus and its services log to session.log, not your terminal.
/usr/bin/dbus-run-session -- "$0" --inner 2>>"$SANDBOX/session.log" &
inner=$!
trap 'kill "$inner" 2>/dev/null; wait "$inner" 2>/dev/null; kill "$system_bus" 2>/dev/null
    rm -f "$SANDBOX/env" "$SANDBOX/system_bus"' EXIT
trap 'exit 130' INT TERM
wait "$inner"
