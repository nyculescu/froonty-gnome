#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Fetch the Break tab's exercise pictures into the working tree.

Usage: fetch-break-art.py [EXTENSION_DIR]   (default: froonty@catalin)

The pictures are WorkoutLabs' (https://workoutlabs.com/exercise-guide/),
all rights reserved by WorkoutLabs: they are fetched to this computer only,
into EXTENSION_DIR/third_party/break-art/ (git-ignored; `make install`
copies it), never committed.
Without them the Break tab shows Workrave's pictures or none.

What is fetched: for each move of features/break/exercises/catalog.json
with a `workoutlabs` picture, the link in tools/break-art/workoutlabs.json:

  gif  an animation: its frames, with repeated frames merged into poses
       (each pose keeps its total time);
  svg  a still with several poses side by side: cut apart at the blank
       columns between them, each pose shown for POSE_MS.

Every picture becomes square PNGs (FRAME_SIZE, white background, the
figure centred, the same crop for all of a move's frames so it does not
jump), written as <move>/<n>.png, with index.json:

  {"format": 1, "source": {...}, "manifest": sha256, "moves":
   {"<move>": {"frames": [{"file": "<move>/0.png", "ms": 3360}], "series": ...}}}

Idempotent: a complete tree for the same link list is left alone. The new
tree is built beside the old one and swapped in only once complete; a move
that cannot be fetched is left out (the tab falls back for it). Needs
Python's PIL (python3-pil) and PyGObject with GdkPixbuf (SVG). Nothing is
fetched at runtime.
"""

import datetime
import hashlib
import io
import json
import shutil
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

try:
    from PIL import Image, ImageChops
except ImportError:
    sys.exit("fetch-break-art: needs Python's PIL (Debian/Ubuntu: apt install python3-pil)")

FRAME_SIZE = 320
POSE_MS = 3000
# A still's poses are rendered this wide before they are cut apart.
SVG_WIDTH = 1800
MAX_BYTES = 8 * 1024 * 1024
# A column counts as blank below this much ink (0-255 per pixel, summed).
BLANK_INK = 255 * 2
# A gap between poses at least this share of the picture's width.
MIN_GAP = 0.015
MARGIN = 0.06
# Brighter than this in every channel counts as the white background.
NEAR_WHITE = 236
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) Froonty-break-art"
# Between requests: gentle on the site.
PAUSE_SECONDS = 0.5

ROOT = Path(__file__).resolve().parent.parent


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=30) as response:
        kind = response.headers.get("Content-Type", "")
        if not kind.startswith("image/"):
            raise ValueError(f"not an image ({kind})")
        data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("too large")
    return data


def on_white(image):
    """RGBA or paletted → RGB over white; near-white (GIF dithering) → white."""
    rgba = image.convert("RGBA")
    white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
    rgb = Image.alpha_composite(white, rgba).convert("RGB")
    # Only pixels near white in all three channels: light colours stay.
    r, g, b = rgb.split()
    darkest = ImageChops.darker(ImageChops.darker(r, g), b)
    mask = darkest.point(lambda v: 255 if v >= NEAR_WHITE else 0)
    rgb.paste((255, 255, 255), mask=mask)
    return rgb


def ink_box(image):
    """The bounding box of what is not white, or None."""
    diff = ImageChops.difference(image, Image.new("RGB", image.size, (255, 255, 255)))
    return diff.convert("L").point(lambda v: 255 if v > 24 else 0).getbbox()


def union(boxes):
    boxes = [b for b in boxes if b]
    if not boxes:
        return None
    return (min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes))


def square(image, box):
    """The box of `image`, with a margin, centred on a white square of FRAME_SIZE."""
    x0, y0, x1, y1 = box
    side = max(x1 - x0, y1 - y0)
    side = int(side * (1 + 2 * MARGIN))
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    canvas = Image.new("RGB", (side, side), (255, 255, 255))
    canvas.paste(image, (int(side / 2 - cx), int(side / 2 - cy)))
    return canvas.resize((FRAME_SIZE, FRAME_SIZE), Image.LANCZOS)


def gif_poses(data):
    """[(RGB image, ms)]: the frames, consecutive repeats merged."""
    gif = Image.open(io.BytesIO(data))
    poses = []
    for i in range(getattr(gif, "n_frames", 1)):
        gif.seek(i)
        frame = on_white(gif)
        ms = int(gif.info.get("duration", 100)) or 100
        if poses and ImageChops.difference(poses[-1][0], frame).getbbox() is None:
            poses[-1] = (poses[-1][0], poses[-1][1] + ms)
        else:
            poses.append((frame, ms))
    # WorkoutLabs' flip-books repeat a cycle of 2 or 3 poses (A B A B …):
    # one pass of the shortest cycle that repeats exactly is enough.
    same = lambda a, b: ImageChops.difference(a, b).getbbox() is None
    for period in range(1, len(poses)):
        if all(same(poses[i][0], poses[i % period][0]) and poses[i][1] == poses[i % period][1]
               for i in range(len(poses))):
            poses = poses[:period]
            break
    box = union(ink_box(p) for p, _ in poses)
    if not box:
        raise ValueError("an empty animation")
    return [(square(p, box), ms) for p, ms in poses]


def render_svg(data):
    import gi
    gi.require_version("GdkPixbuf", "2.0")
    from gi.repository import GdkPixbuf, GLib
    loader = GdkPixbuf.PixbufLoader.new_with_type("svg")
    loader.set_size(SVG_WIDTH, int(SVG_WIDTH * 2 / 3))
    loader.write(data)
    loader.close()
    pixbuf = loader.get_pixbuf()
    if pixbuf is None:
        raise ValueError("the SVG did not render")
    mode = "RGBA" if pixbuf.get_has_alpha() else "RGB"
    image = Image.frombuffer(mode, (pixbuf.get_width(), pixbuf.get_height()),
                             GLib.Bytes.get_data(pixbuf.read_pixel_bytes()), "raw", mode,
                             pixbuf.get_rowstride(), 1)
    return on_white(image)


def svg_poses(data, poses):
    """[(RGB image, ms)]: the still cut apart at the blank columns between poses."""
    image = render_svg(data)
    width, height = image.size
    ink = ImageChops.difference(image, Image.new("RGB", image.size, (255, 255, 255))).convert("L")
    columns = [sum(ink.crop((x, 0, x + 1, height)).histogram()[v] * v for v in range(256)) for x in range(width)]
    runs, start = [], None
    for x, value in enumerate(columns + [0]):
        if value > BLANK_INK and start is None:
            start = x
        elif value <= BLANK_INK and start is not None:
            runs.append([start, x])
            start = None
    # Join runs split by a gap too narrow to be between two poses.
    joined = []
    for run in runs:
        if joined and run[0] - joined[-1][1] < MIN_GAP * width:
            joined[-1][1] = run[1]
        else:
            joined.append(run)
    # The widest `poses` runs, left to right; equal parts if none are found.
    if len(joined) >= poses > 1:
        joined = sorted(sorted(joined, key=lambda r: r[0] - r[1])[:poses])
    else:
        joined = [[i * width // poses, (i + 1) * width // poses] for i in range(poses)]
    parts = [image.crop((x0, 0, x1, height)) for x0, x1 in joined]
    boxes = [ink_box(p) for p in parts]
    top = min(b[1] for b in boxes if b)
    bottom = max(b[3] for b in boxes if b)
    side = max(b[2] - b[0] for b in boxes if b)
    out = []
    for part, b in zip(parts, boxes):
        if not b:
            continue
        cx = (b[0] + b[2]) / 2
        out.append((square(part, (int(cx - side / 2), top, int(cx + side / 2), bottom)), POSE_MS))
    if not out:
        raise ValueError("an empty still")
    return out


def wanted_moves(ext):
    catalog = json.loads((ext / "features/break/exercises/catalog.json").read_text())
    return sorted({m["art"]["workoutlabs"] for m in catalog["moves"] if m.get("art", {}).get("workoutlabs")})


def main():
    ext = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "froonty@catalin").resolve()
    links_file = ROOT / "tools/break-art/workoutlabs.json"
    links = json.loads(links_file.read_text())
    wanted = wanted_moves(ext)
    digest = hashlib.sha256((links_file.read_text() + json.dumps(wanted)).encode()).hexdigest()
    target = ext / "third_party" / "break-art"
    index_file = target / "index.json"
    if index_file.is_file():
        old = json.loads(index_file.read_text())
        files = [target / f["file"] for m in old.get("moves", {}).values() for f in m["frames"]]
        if old.get("manifest") == digest and all(f.is_file() for f in files):
            print("fetch-break-art: up to date")
            return

    target.parent.mkdir(parents=True, exist_ok=True)
    build = Path(tempfile.mkdtemp(prefix=".break-art.", dir=target.parent))
    moves, failed = {}, []
    try:
        for move in wanted:
            link = links["moves"].get(move)
            if not link:
                failed.append((move, "no link"))
                continue
            try:
                data = fetch(link["url"])
                poses = gif_poses(data) if link["kind"] == "gif" else svg_poses(data, link.get("poses", 1))
            except Exception as e:  # one move's failure leaves the others
                failed.append((move, str(e)))
                continue
            (build / move).mkdir()
            frames = []
            for i, (image, ms) in enumerate(poses):
                image.save(build / move / f"{i}.png", optimize=True)
                frames.append({"file": f"{move}/{i}.png", "ms": ms})
            moves[move] = {"frames": frames, "series": link.get("series"), "page": link.get("page")}
            print(f"  {move}: {len(frames)} frame(s)")
            time.sleep(PAUSE_SECONDS)
        if not moves:
            # Offline, or the site changed: keep what was fetched before.
            for move, why in failed:
                print(f"fetch-break-art: {move}: {why}", file=sys.stderr)
            sys.exit("fetch-break-art: nothing fetched; the pictures already here are kept")
        index = {
            "format": 1,
            "source": {"name": "WorkoutLabs", "url": links["source"],
                       "rights": "All rights reserved by WorkoutLabs; fetched for this computer only",
                       "fetched": datetime.date.today().isoformat()},
            "manifest": digest,
            "moves": moves,
        }
        (build / "index.json").write_text(json.dumps(index, indent=1) + "\n")
        if target.exists():
            shutil.rmtree(target)
        build.rename(target)
    finally:
        if build.exists():
            shutil.rmtree(build)
    for move, why in failed:
        print(f"fetch-break-art: {move}: {why}", file=sys.stderr)
    print(f"fetch-break-art: {len(moves)} of {len(wanted)} moves in {target}")


if __name__ == "__main__":
    main()
