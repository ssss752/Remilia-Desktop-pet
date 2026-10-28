#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fit_align.py -- fit frames to the canvas FIRST, then align feet-center.

Why: pipeline.step_align pastes the raw subject onto the 256x256 canvas with
cy = ANCHOR_Y - subject_height. A sliced subject is ~400px tall, so cy is
negative and the top of the character (i.e. her head) is silently cut off.
pipeline's `all` order is slice -> align -> normalize, so the downscale
happens AFTER the crop and cannot bring the head back.

This step does it in the right order:
  1. crop every frame to its subject bbox
  2. compute ONE uniform scale from the tallest frame so no pose changes size
  3. resize, then place with the feet-center at ANCHOR
Result: whole character visible, feet pinned to the same pixel in every frame
so the animation does not jitter.

Usage:
  python scripts/fit_align.py _tmp/slice_idle --out assets/pet/idle
"""
import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

CANVAS = (512, 512)
ANCHOR = (256, 472)      # feet-center target, must match pipeline.py
TOP_PAD = 8              # keep a sliver of headroom so nothing touches y=0
SIDE_PAD = 8
ALPHA_THRESH = 25


def subject_bbox(img):
    a = np.array(img.getchannel("A"))
    ys, xs = np.where(a > ALPHA_THRESH)
    if len(ys) == 0:
        return None
    return (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    src = Path(args.src)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    files = sorted(src.glob("*.png"))
    if not files:
        print(f"[fit] ERROR no frames in {src}")
        return 2

    subs = []
    for f in files:
        img = Image.open(f).convert("RGBA")
        bb = subject_bbox(img)
        if bb is None:
            print(f"[fit] WARN empty frame {f.name}")
            subs.append((f.name, None))
            continue
        subs.append((f.name, img.crop(bb)))

    valid = [s for _, s in subs if s is not None]
    if not valid:
        print("[fit] ERROR every frame is empty")
        return 2

    max_h = max(s.height for s in valid)
    max_w = max(s.width for s in valid)
    avail_h = ANCHOR[1] - TOP_PAD
    avail_w = CANVAS[0] - 2 * SIDE_PAD
    scale = min(1.0, avail_h / max_h, avail_w / max_w)
    print(f"[fit] {src} frames={len(files)} max_subject={max_w}x{max_h} "
          f"scale={scale:.4f} -> fitted={int(max_w*scale)}x{int(max_h*scale)}")

    for name, sub in subs:
        canvas = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
        if sub is None:
            canvas.save(out / name)
            continue
        nw, nh = max(1, round(sub.width * scale)), max(1, round(sub.height * scale))
        rs = sub.resize((nw, nh), Image.LANCZOS)
        cx = ANCHOR[0] - nw // 2
        cy = ANCHOR[1] - nh
        canvas.paste(rs, (cx, cy), rs)
        canvas.save(out / name)

    # report headroom so a clipped frame can never slip through again
    worst = None
    for f in sorted(out.glob("*.png")):
        bb = subject_bbox(Image.open(f).convert("RGBA"))
        if bb is None:
            continue
        gap = bb[1]
        worst = gap if worst is None else min(worst, gap)
    print(f"[fit] top headroom (min over frames): {worst}px -> "
          f"{'PASS' if (worst or 0) >= 1 else 'FAIL clipped'}")
    return 0 if (worst or 0) >= 1 else 1


if __name__ == "__main__":
    sys.exit(main())
