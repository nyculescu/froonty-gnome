#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Checks out the patched submodules and applies Froonty's patches on top of them:
# third_party/patches/<submodule>/*.patch go, in order, onto a branch named
# `froonty` that starts at the commit the superproject records. Run it after
# a clone or after the submodule pointer or the patches change (make
# third-party). Upstream does not carry these commits, so the submodule
# pointer stays at upstream's commit and the patches live here.
#
# Refuses to touch a submodule with uncommitted changes; leaves it alone when
# its `froonty` branch already holds exactly these patches.
set -euo pipefail

GIT=${GIT:-/usr/bin/git}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

for dir in third_party/patches/*/; do
    name=$(basename "$dir")
    sub="third_party/$name"
    [ -d "$sub" ] || { echo "$sub: no such submodule" >&2; exit 1; }
    # Only the patched submodules: the others may be ahead of their pointer.
    [ -e "$sub/.git" ] || "$GIT" submodule update --init -- "$sub"
    base=$("$GIT" ls-files -s -- "$sub" | awk '{print $2}')
    [ -n "$base" ] || { echo "$sub: not a submodule" >&2; exit 1; }
    patches=("$dir"*.patch)

    if [ -n "$("$GIT" -C "$sub" status --porcelain --untracked-files=no)" ]; then
        echo "$sub: uncommitted changes, not patched" >&2
        exit 1
    fi

    # Same changes, whatever the commit ids: compare patch-ids in order.
    want=$(for p in "${patches[@]}"; do "$GIT" patch-id --stable <"$p" | cut -d' ' -f1; done)
    if "$GIT" -C "$sub" rev-parse -q --verify refs/heads/froonty >/dev/null &&
       [ "$("$GIT" -C "$sub" merge-base "$base" froonty)" = "$base" ]; then
        have=$(for c in $("$GIT" -C "$sub" rev-list --reverse "$base..froonty"); do
            "$GIT" -C "$sub" show "$c" | "$GIT" patch-id --stable | cut -d' ' -f1
        done)
        if [ "$have" = "$want" ]; then
            "$GIT" -C "$sub" checkout -q froonty
            echo "$sub: ${#patches[@]} patches already applied (branch froonty)"
            continue
        fi
    fi

    "$GIT" -C "$sub" checkout -q -B froonty "$base"
    "$GIT" -C "$sub" am -q --keep-cr --quoted-cr=nowarn --whitespace=nowarn --committer-date-is-author-date "${patches[@]/#/$ROOT/}"
    echo "$sub: applied ${#patches[@]} patches on ${base:0:7} (branch froonty)"
done
