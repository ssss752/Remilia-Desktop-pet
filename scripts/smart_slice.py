#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""smart_slice.py -- slice a sprite sheet on REAL whitespace gutters.

Why: a hard 2x2 grid cut assumes the generator laid the panels out evenly.
It does not. Measured example: the row gutter sits at y=515..581 while the
grid cut is y=512 -- so the grid slices straight through the character's head.
This tool locates the widest empty bands and cuts there instead, then reports
the margin left around the subject in every cell so a clipped panel is caught
immediately instead of being discovered by the user.

Output frame order is row-major (000=top-left, 001=top-right, ...), matching
pipeline.py's step_slice so `align` / `normalize` can consume it directly.

Usage:
  python scripts/smart_slice.py _tmp/cut_idle.png --out _tmp/slice_idle --cols 2 --rows 2
"""
import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image


def bands_of(proj, minlen):
    """Return (start, end) inclusive ranges where proj is zero, len >= minlen."""
    idx = np.where(proj == 0)[0]
    out = []
    start = prev = None
    for i in idx:
        if start is None:
            start = prev = i
            continue
        if i - prev == 1:
            prev = i
            continue
        if prev - start + 1 >= minlen:
            out.append((int(start), int(prev)))
        start = prev = i
    if start is not None and prev - start + 1 >= minlen:
        out.append((int(start), int(prev)))
    return out


def pick_cuts(mask, n, axis, minlen=10, margin_frac=0.08):
    """Pick n cut positions along `axis`.

    axis=1 -> horizontal cut lines (y values, from row projection)
    axis=0 -> vertical cut lines (x values, from column projection)
    Returns (positions, used_gutters: bool).
    """
    if n <= 0:
        return [], True
    proj = mask.sum(axis=axis)
    size = int(proj.shape[0])
    lo, hi = int(size * margin_frac), int(size * (1 - margin_frac))
    cands = [b for b in bands_of(proj, minlen) if b[0] >= lo and b[1] <= hi]
    cands.sort(key=lambda b: (b[1] - b[0]), reverse=True)
    if len(cands) < n:
        return [int(size * (i + 1) / (n + 1)) for i in range(n)], False
    return sorted((b[0] + b[1]) // 2 for b in cands[:n]), True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("--out", required=True)
    ap.add_argument("--cols", type=int, default=2)
    ap.add_argument("--rows", type=int, default=2)
    ap.add_argument("--min-band", type=int, default=10)
    ap.add_argument("--alpha-thresh", type=int, default=20)
    args = ap.parse_args()

    img = Image.open(args.src).convert("RGBA")
    a = np.array(img.getchannel("A"))
    mask = a > args.alpha_thresh
    H, W = mask.shape

    ycuts, yok = pick_cuts(mask, args.rows - 1, axis=1, minlen=args.min_band)
    xcuts, xok = pick_cuts(mask, args.cols - 1, axis=0, minlen=args.min_band)

    print(f"[slice] {args.src} {W}x{H} grid={args.rows}x{args.cols}")
    print(f"[slice]   cut lines  y={ycuts} (gutter={yok})  x={xcuts} (gutter={xok})")
    if not (yok and xok):
        print("[slice]   WARN fell back to even split - panels may be clipped")

    ys = [0] + ycuts + [H]
    xs = [0] + xcuts + [W]

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    n = 0
    clipped = 0
    for r in range(len(ys) - 1):
        for c in range(len(xs) - 1):
            box = (xs[c], ys[r], xs[c + 1], ys[r + 1])
            cell = img.crop(box)
            cm = np.array(cell.getchannel("A")) > args.alpha_thresh
            cy, cx = np.where(cm)
            if len(cy) == 0:
                print(f"[slice]   cell({r},{c}) EMPTY")
            else:
                gaps = {"top": int(cy.min()), "bottom": int(cm.shape[0] - 1 - cy.max()),
                        "left": int(cx.min()), "right": int(cm.shape[1] - 1 - cx.max())}
                worst = min(gaps.values())
                flag = "OK " if worst >= 3 else "CLIP"
                if worst < 3:
                    clipped += 1
                print(f"[slice]   cell({r},{c}) {flag} box={box} worst_gap={worst} {gaps}")
            cell.save(out / f"frame_{n:03d}.png")
            n += 1

    print(f"[slice] wrote {n} frames -> {out}")
    print(f"[slice] verdict: {'PASS' if clipped == 0 else f'FAIL ({clipped} clipped)'}")
    return 0 if clipped == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
