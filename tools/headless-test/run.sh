#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Runs Froonty's checks inside an isolated, headless GNOME Shell 50.
#
# Isolation: private D-Bus session bus, private XDG data/config/cache/runtime
# dirs and the keyfile GSettings backend. The real session, the real dconf
# database and ~/.local/share/gnome-shell/extensions are never touched.
#
# Usage: tools/headless-test/run.sh [--keep]   (--keep leaves the work dir)
# Env:   FROONTY_TEST_MODE=ubuntu  to run with Ubuntu's session mode

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
UUID=froonty@catalin
HELPER=unsafe-mode@froonty-test
# Ubuntu-specific: avoid tools shadowed by other PATH entries.
GNOME_SHELL=${GNOME_SHELL:-/usr/bin/gnome-shell}
GDBUS=${GDBUS:-/usr/bin/gdbus}
DBUS_RUN_SESSION=${DBUS_RUN_SESSION:-/usr/bin/dbus-run-session}

if [[ "${1:-}" == "--inner" ]]; then
    WORK=$2

    # A private PipeWire (in the private XDG_RUNTIME_DIR) with a virtual
    # speaker and microphone and no hardware, so the panic mute buttons can
    # be tested for real. The host's audio is not touched.
    # priority.session: WirePlumber 0.5 otherwise picks the speaker's
    # monitor as the default source.
    mkdir -p "$XDG_CONFIG_HOME/pipewire/pipewire.conf.d"
    cat >"$XDG_CONFIG_HOME/pipewire/pipewire.conf.d/froonty-test.conf" <<'CONF'
context.objects = [
    { factory = adapter args = { factory.name = support.null-audio-sink
        node.name = "froonty-test-speaker" node.description = "Test speaker"
        media.class = Audio/Sink object.linger = true audio.position = [ FL FR ] } }
    { factory = adapter args = { factory.name = support.null-audio-sink
        node.name = "froonty-test-mic" node.description = "Test microphone"
        media.class = Audio/Source/Virtual object.linger = true audio.position = [ MONO ]
        priority.session = 2000 } }
]
CONF
    # Never touch real hardware: without this, the private WirePlumber found
    # the host's sound card through ALSA (muting it could change the real
    # card's mixer). WirePlumber 0.5 reads SPA-JSON fragments from
    # wireplumber.conf.d and merges this override into the "main" profile;
    # it ignores the Lua fragments 0.4 used.
    mkdir -p "$XDG_CONFIG_HOME/wireplumber/wireplumber.conf.d"
    cat >"$XDG_CONFIG_HOME/wireplumber/wireplumber.conf.d/51-froonty-test.conf" <<'CONF'
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

    /usr/bin/pipewire >"$WORK/pipewire.log" 2>&1 &
    audio_pids=$!
    /usr/bin/wireplumber >"$WORK/wireplumber.log" 2>&1 &
    audio_pids="$audio_pids $!"
    /usr/bin/pipewire-pulse >"$WORK/pipewire-pulse.log" 2>&1 &
    audio_pids="$audio_pids $!"

    "$GNOME_SHELL" --headless --wayland --no-x11 \
        --wayland-display "$WAYLAND_DISPLAY" \
        --mode="${FROONTY_TEST_MODE:-user}" \
        --virtual-monitor 1920x1080 --virtual-monitor 1280x800 \
        >"$WORK/shell.log" 2>&1 &
    shell_pid=$!
    trap 'kill "$shell_pid" $audio_pids 2>/dev/null; wait "$shell_pid" 2>/dev/null || true' EXIT

    eval_js() {
        "$GDBUS" call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
            --timeout 900 --method org.gnome.Shell.Eval "$1"
    }

    ready=
    for _ in $(seq 120); do
        if [[ "$(eval_js "'!Main.layoutManager._startingUp'" 2>/dev/null)" == "(true, 'true')" ]]; then
            ready=1
            break
        fi
        sleep 0.5
    done
    if [[ -z "$ready" ]]; then
        echo "gnome-shell did not become ready; log follows" >&2
        cat "$WORK/shell.log" >&2
        exit 1
    fi

    eval_js "'Main.overview.hide()'" >/dev/null
    sleep 1

    eval_js "'import(\"file://$HERE/checks.js\").then(m => m.runAll(\"$WORK\")).then(r => { imports.gi.GLib.file_set_contents(\"$WORK/results.json\", JSON.stringify(r, null, 1)); return r.filter(x => !x.ok).length; })'"

    # Preferences smoke test: prefs.js runs in the separate, D-Bus activated
    # org.gnome.Shell.Extensions process; its stderr lands in eval.out.
    echo "== prefs"
    "$GDBUS" call --session --dest org.gnome.Shell.Extensions \
        --object-path /org/gnome/Shell/Extensions \
        --method org.gnome.Shell.Extensions.OpenExtensionPrefs "$UUID" '' '{}'
    sleep 5
    eval_js "'global.display.list_all_windows().map(w => w.title)'"
    eval_js "'(async () => { const s = imports.gi.Gio.File.new_for_path(\"$WORK/prefs.png\").replace(null, false, 0, null); await new Shell.Screenshot().screenshot(false, s); s.close(null); })()'" >/dev/null
    exit 0
fi

KEEP=
[[ "${1:-}" == "--keep" ]] && KEEP=1

make -C "$REPO" --no-print-directory schemas >/dev/null

# Short path on purpose: Wayland socket paths are limited to 108 bytes.
# Under ~/.cache, not /tmp: GLib refuses to trash on system internal mounts,
# and /tmp is one (a tmpfs on Ubuntu 26.04).
CACHE=${XDG_CACHE_HOME:-$HOME/.cache}
mkdir -p "$CACHE"
WORK=$(mktemp -d -p "$CACHE" froonty-test.XXXXXX)
system_bus_pid=
cleanup() {
    [[ -n "$system_bus_pid" ]] && kill "$system_bus_pid" 2>/dev/null
    [[ -z "$KEEP" ]] && rm -rf "$WORK"
    return 0
}
trap cleanup EXIT

export XDG_DATA_HOME=$WORK/data
export XDG_CONFIG_HOME=$WORK/config
export XDG_CACHE_HOME=$WORK/cache
export XDG_STATE_HOME=$WORK/state
export XDG_RUNTIME_DIR=$WORK/runtime
export GSETTINGS_BACKEND=keyfile
# Claude Code's config file (the Claude tab reads it): a private one.
export CLAUDE_CONFIG_DIR=$WORK/claude
# livenerf's README and chart (the Claude tab fetches them from GitHub):
# private files the checks write, so the Shell under test never goes online.
export FROONTY_LIVENERF_DIR=$WORK/livenerf
# Claude Code's /usage (the Claude tab runs it on open): a fake that logs
# its arguments and, when the checks left one, puts a new cache in place.
# Set always, so the Shell under test never finds the real Claude Code.
export FROONTY_CLAUDE_CODE=$WORK/fake-claude
# The Writing tab (working-tree only): every address and command it could
# reach is a fake or refused until the checks point it at their own local
# server. FROONTY_HEADLESS_TEST makes a missing one an error, so nothing
# can fall back to the real LanguageTool, Ollama, GitHub or systemd.
# A paid API key in the environment must be removed before Claude Code runs.
export FROONTY_HEADLESS_TEST=1
export ANTHROPIC_API_KEY=sk-froonty-test-not-a-key
export FROONTY_LANGUAGETOOL_URL=http://127.0.0.1:1/v2/check
export FROONTY_OLLAMA_URL=http://127.0.0.1:1
export FROONTY_OLLAMA_RELEASE_API=http://127.0.0.1:1/repos/ollama/ollama/releases/latest
export FROONTY_SYSTEMCTL=$WORK/fake-systemctl
# Stands in for /usr, /etc and /lib when the Writing tab looks for an Ollama
# of the user's own (empty: none installed), so the host's does not count.
export FROONTY_OLLAMA_SYSTEM_ROOT=$WORK/system-root
export WAYLAND_DISPLAY=wayland-froonty-test
# D-Bus activated GTK apps (the prefs window) inherit this environment;
# an X11 host session may force GDK_BACKEND=x11 and load X11-only modules.
export GDK_BACKEND=wayland
unset DISPLAY GTK_MODULES
# The Claude attention bar's checks run its hook script as Claude Code
# would; when this harness itself runs inside Claude Code (or VS Code),
# none of that session's variables may leak into them.
unset CLAUDE_CODE_ENTRYPOINT CLAUDE_PID CLAUDE_CODE_SESSION_ID CLAUDE_PROJECT_DIR CHROME_DESKTOP VSCODE_PID
mkdir -p "$XDG_DATA_HOME/gnome-shell/extensions" "$XDG_CONFIG_HOME/glib-2.0/settings" \
    "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$XDG_DATA_HOME/applications"
mkdir -m 700 "$XDG_RUNTIME_DIR"
mkdir -p "$CLAUDE_CONFIG_DIR" "$FROONTY_OLLAMA_SYSTEM_ROOT"
# Apps the attention bar's checks pose as: the Claude app (its desktop id,
# so it shadows a real one in /usr/share) and a web browser. When GNOME
# opens one (a click on its notification), /bin/true is all that runs.
cat >"$XDG_DATA_HOME/applications/com.anthropic.Claude.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Claude
Exec=/bin/true
NoDisplay=true
EOF
cat >"$XDG_DATA_HOME/applications/froonty-test-browser.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Test Browser
Exec=/bin/true
Categories=Network;WebBrowser;
NoDisplay=true
EOF
# A terminal or VS Code with several windows: testWindows.js, a GTK app
# with this id, which the checks start themselves.
cat >"$XDG_DATA_HOME/applications/org.froonty.TestWindows.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Test Windows
Exec=/bin/true
NoDisplay=true
EOF
cat >"$FROONTY_CLAUDE_CODE" <<'EOF'
#!/bin/sh
# The Writing tab's calls (before the Claude tab's /usage log, which they
# must not touch): --version, auth status, project purge, and a run.
W="$CLAUDE_CONFIG_DIR/writing"
case "$1" in
--version) echo "2.1.287 (Claude Code)"; exit 0 ;;
auth)
    mkdir -p "$W"; echo "$*" >>"$W/auth.log"
    if [ -f "$W/auth.json" ]; then cat "$W/auth.json"
    else echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}'; fi
    exit "$(cat "$W/auth.exit" 2>/dev/null || echo 0)" ;;
project)
    mkdir -p "$W"; echo "$*" >>"$W/purge.log"
    echo "No Claude Code project state found"; exit 1 ;;
esac
for arg in "$@"; do
    if [ "$arg" = "--output-format=json" ]; then
        mkdir -p "$W"
        for a in "$@"; do printf '%s\0' "$a"; done >"$W/run.argv"
        pwd >"$W/run.cwd"
        env >"$W/run.env"
        echo $$ >"$W/run.pid"
        [ -f "$W/hang" ] && exec sleep 300
        cat >"$W/run.stdin"
        if [ -f "$W/reply.json" ]; then cat "$W/reply.json"
        else echo '{"type":"result","subtype":"success","is_error":false,"result":"Fake rewrite."}'; fi
        exit 0
    fi
done
echo "$*" >>"$CLAUDE_CONFIG_DIR/runs.log"
[ -f "$CLAUDE_CONFIG_DIR/next.json" ] && mv "$CLAUDE_CONFIG_DIR/next.json" "$CLAUDE_CONFIG_DIR/.claude.json"
exit 0
EOF
chmod +x "$FROONTY_CLAUDE_CODE"
cat >"$FROONTY_SYSTEMCTL" <<'EOF'
#!/bin/sh
echo "$*" >>"$CLAUDE_CONFIG_DIR/systemctl.log"
exit 0
EOF
chmod +x "$FROONTY_SYSTEMCTL"

# Media tab: apps for the fake players (fake-mpris.js) to name, one music
# player and one browser, never shown in the app grid.
mkdir -p "$XDG_DATA_HOME/applications"
printf '[Desktop Entry]\nType=Application\nName=Test Music\nExec=true\nNoDisplay=true\nCategories=Audio;Player;\n' \
    >"$XDG_DATA_HOME/applications/froonty-test-music.desktop"
printf '[Desktop Entry]\nType=Application\nName=Test Browser\nExec=true\nNoDisplay=true\nCategories=Network;WebBrowser;\n' \
    >"$XDG_DATA_HOME/applications/froonty-test-browser.desktop"
# lrclib.net (Media lyrics, only when allowed): a closed local port, so the
# Shell under test never goes online; the checks point it at a fake.
export FROONTY_LRCLIB_URL=http://127.0.0.1:9/api/get

ln -s "$REPO/$UUID" "$XDG_DATA_HOME/gnome-shell/extensions/$UUID"
ln -s "$HERE/$HELPER" "$XDG_DATA_HOME/gnome-shell/extensions/$HELPER"

cat >"$XDG_CONFIG_HOME/glib-2.0/settings/keyfile" <<EOF
[org/gnome/shell]
enabled-extensions=['$HELPER', '$UUID']
disable-user-extensions=false
welcome-dialog-last-shown-version='999'
EOF

# A private, empty "system" bus: without it the test shell would talk to the
# real logind (and watch the real session's Lock/Unlock signals) and call
# GDM's RegisterSession.
/usr/bin/dbus-daemon --session --nofork --address="unix:path=$WORK/system_bus" \
    >"$WORK/system_bus.log" 2>&1 &
system_bus_pid=$!
export DBUS_SYSTEM_BUS_ADDRESS=unix:path=$WORK/system_bus
sleep 0.3

"$DBUS_RUN_SESSION" -- "$0" --inner "$WORK" >"$WORK/eval.out" 2>&1 || true

# Non-zero exit when a check fails, no results come back (e.g. the checks
# module did not load), or the Shell logged Froonty errors, so `make test`
# cannot report success by accident.
status=0

echo "== results"
if [[ -f "$WORK/results.json" ]]; then
    /usr/bin/gjs -c "
        const [, bytes] = imports.gi.GLib.file_get_contents('$WORK/results.json');
        const results = JSON.parse(new TextDecoder().decode(bytes));
        for (const r of results)
            print((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.detail && (!r.ok || r.detail.startsWith('note:')) ? '\n     ' + r.detail : ''));
        const failed = results.filter(r => !r.ok).length;
        print('\n' + (results.length - failed) + '/' + results.length + ' passed');
        if (failed)
            imports.system.exit(1);
    " || status=1
else
    echo "no results; eval output:"
    tail -n 20 "$WORK/eval.out"
    status=1
fi

echo
echo "== prefs (windows open after OpenExtensionPrefs; must include \"Froonty\")"
sed -n '/^== prefs/,$p' "$WORK/eval.out" | grep -E "^\(true" || echo "(no answer)"
grep -n -E "org.gnome.Shell.Extensions.*(WARNING|CRITICAL|failed)|JS ERROR" "$WORK/eval.out" \
    || echo "(no prefs warnings)"

echo
echo "== shell log lines mentioning froonty, JS errors or criticals"
# Only up to shutdown: at exit, GJS reports other code's handlers that fire
# during GC sweeping (e.g. DING's windows being unmanaged); not Froonty's.
sed '/Shutting down GNOME Shell/q' "$WORK/shell.log" |
    grep -n -i -E "froonty|JS ERROR|JS WARNING|Gjs-CRITICAL|already disposed|TypeError|ReferenceError" |
    grep -v -i -E "unsafe-mode@froonty-test|Using Wayland display name" && status=1 || echo "(none)"

echo
echo "screenshots and logs: $WORK$([[ -z "$KEEP" ]] && echo ' (deleted on exit; pass --keep to keep)')"
exit $status
