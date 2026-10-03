#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Build the published extension without local-only feature implementations
# (ZeroTier, Writing): their code, settings keys and CSS are removed from a
# staged copy, and the packed zip is checked for leftovers (check_zip.py
# deletes it and fails the build on any).
#
# PACK_OUT_DIR: where the zip goes (default dist/; the tests use their own).
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
UUID=${1:?extension directory required}
shift
GNOME_EXTENSIONS=${GNOME_EXTENSIONS:-/usr/bin/gnome-extensions}
GLIB_COMPILE_SCHEMAS=${GLIB_COMPILE_SCHEMAS:-/usr/bin/glib-compile-schemas}
OUT=${PACK_OUT_DIR:-$ROOT/dist}
STAGING_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/froonty-public-pack.XXXXXX")
STAGED="$STAGING_ROOT/$UUID"
trap 'rm -rf "$STAGING_ROOT"' EXIT

cp -a "$ROOT/$UUID" "$STAGED"
cp "$ROOT/tools/pack-public/localFeatures.js" "$STAGED/features/localFeatures.js"
cp "$ROOT/tools/pack-public/localPrefs.js" "$STAGED/features/localPrefs.js"
rm -rf "$STAGED/features/zerotier" "$STAGED/features/writing"
python3 "$ROOT/tools/pack-public/strip-local-schema.py" \
    "$STAGED/schemas/org.gnome.shell.extensions.froonty.gschema.xml"
python3 "$ROOT/tools/pack-public/strip_local_css.py" "$STAGED/stylesheet.css" zerotier writing
"$GLIB_COMPILE_SCHEMAS" --strict "$STAGED/schemas"

extra_sources=()
for source in "$@"; do
    extra_sources+=("--extra-source=$source")
done

# gnome-extensions 46 segfaulted if --out-dir did not exist yet.
mkdir -p "$OUT"
"$GNOME_EXTENSIONS" pack --force "${extra_sources[@]}" \
    --out-dir="$OUT" "$STAGED"
python3 "$ROOT/tools/pack-public/check_zip.py" "$OUT/$UUID.shell-extension.zip" \
    "$ROOT/tools/pack-public"
