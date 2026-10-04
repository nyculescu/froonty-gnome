#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Build the published extension without the features it leaves out: their
# code, settings keys and CSS are removed from a staged copy, and the packed
# zip is checked for leftovers (check_zip.py deletes it and fails the build
# on any).
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
# The imports of features/localFeatures.js, features/localPrefs.js,
# panic/localCatalog.js and panic/localFactories.js, and their uses, go;
# prune.py then leaves those modules out with everything only they reach.
for module in features/registry.js prefs.js panic/catalog.js panic/registry.js; do
    python3 "$ROOT/tools/pack-public/strip_local.py" --several "$STAGED/$module" local-features
done
rm -rf "$STAGED/features/zerotier" "$STAGED/features/writing" "$STAGED/features/formulas"
# The Formulas tab's renderer (tools/fetch-mathjax.py), when fetched.
rm -rf "$STAGED/third_party/mathjax"
rmdir "$STAGED/third_party" 2>/dev/null || true
python3 "$ROOT/tools/pack-public/strip-local-schema.py" \
    "$STAGED/schemas/org.gnome.shell.extensions.froonty.gschema.xml"
python3 "$ROOT/tools/pack-public/strip_local.py" "$STAGED/stylesheet.css" zerotier writing formulas
# Only what extension.js and prefs.js reach, and only their settings keys
# and CSS; the description says what this build has.
python3 "$ROOT/tools/pack-public/prune.py" "$STAGED"
python3 "$ROOT/tools/pack-public/describe.py" "$STAGED/metadata.json" \
    "$ROOT/tools/pack-public/description.txt"
cp "$ROOT/LICENSE" "$STAGED/LICENSE"
"$GLIB_COMPILE_SCHEMAS" --strict "$STAGED/schemas"

extra_sources=(--extra-source=LICENSE)
for source in "$@"; do
    extra_sources+=("--extra-source=$source")
done

# gnome-extensions 46 segfaulted if --out-dir did not exist yet.
mkdir -p "$OUT"
"$GNOME_EXTENSIONS" pack --force "${extra_sources[@]}" \
    --out-dir="$OUT" "$STAGED"
python3 "$ROOT/tools/pack-public/check_zip.py" "$OUT/$UUID.shell-extension.zip"
