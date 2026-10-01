#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Build the published extension without local-only feature implementations.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
UUID=${1:?extension directory required}
shift
GNOME_EXTENSIONS=${GNOME_EXTENSIONS:-/usr/bin/gnome-extensions}
GLIB_COMPILE_SCHEMAS=${GLIB_COMPILE_SCHEMAS:-/usr/bin/glib-compile-schemas}
STAGING_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/froonty-public-pack.XXXXXX")
STAGED="$STAGING_ROOT/$UUID"
trap 'rm -rf "$STAGING_ROOT"' EXIT

cp -a "$ROOT/$UUID" "$STAGED"
cp "$ROOT/tools/pack-public/localFeatures.js" "$STAGED/features/localFeatures.js"
cp "$ROOT/tools/pack-public/localPrefs.js" "$STAGED/features/localPrefs.js"
rm -rf "$STAGED/features/zerotier"
python3 "$ROOT/tools/pack-public/strip-local-schema.py" \
    "$STAGED/schemas/org.gnome.shell.extensions.froonty.gschema.xml"
"$GLIB_COMPILE_SCHEMAS" --strict "$STAGED/schemas"

extra_sources=()
for source in "$@"; do
    extra_sources+=("--extra-source=$source")
done

"$GNOME_EXTENSIONS" pack --force "${extra_sources[@]}" \
    --out-dir="$ROOT/dist" "$STAGED"