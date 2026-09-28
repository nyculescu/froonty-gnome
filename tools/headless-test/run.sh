#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Runs Froonty's checks inside an isolated, headless GNOME Shell 46.
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

    "$GNOME_SHELL" --headless --wayland --no-x11 \
        --wayland-display "$WAYLAND_DISPLAY" \
        --mode="${FROONTY_TEST_MODE:-user}" \
        --virtual-monitor 1920x1080 --virtual-monitor 1280x800 \
        >"$WORK/shell.log" 2>&1 &
    shell_pid=$!
    trap 'kill "$shell_pid" 2>/dev/null; wait "$shell_pid" 2>/dev/null || true' EXIT

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
WORK=$(mktemp -d -t froonty-test.XXXXXX)
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
export WAYLAND_DISPLAY=wayland-froonty-test
# D-Bus activated GTK apps (the prefs window) inherit this environment;
# an X11 host session may force GDK_BACKEND=x11 and load X11-only modules.
export GDK_BACKEND=wayland
unset DISPLAY GTK_MODULES
mkdir -p "$XDG_DATA_HOME/gnome-shell/extensions" "$XDG_CONFIG_HOME/glib-2.0/settings" \
    "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
mkdir -m 700 "$XDG_RUNTIME_DIR"

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

echo "== results"
if [[ -f "$WORK/results.json" ]]; then
    /usr/bin/gjs -c "
        const [, bytes] = imports.gi.GLib.file_get_contents('$WORK/results.json');
        const results = JSON.parse(new TextDecoder().decode(bytes));
        for (const r of results)
            print((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.detail && (!r.ok || r.detail.startsWith('note:')) ? '\n     ' + r.detail : ''));
        const failed = results.filter(r => !r.ok).length;
        print('\n' + (results.length - failed) + '/' + results.length + ' passed');
    "
else
    echo "no results; eval output:"
    tail -n 20 "$WORK/eval.out"
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
    grep -v -i -E "unsafe-mode@froonty-test|Using Wayland display name" || echo "(none)"

echo
echo "screenshots and logs: $WORK$([[ -z "$KEEP" ]] && echo ' (deleted on exit; pass --keep to keep)')"
