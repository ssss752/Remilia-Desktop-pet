#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""bleed_check.py -- detect panels clipped by sprite-sheet cell borders.

Why this exists: generated 2x2 sprite sheets sometimes draw the character
larger than its cell, so hard grid slicing cuts off the head or the feet.
This check runs BEFORE slicing: it looks at each cell of the cut-out sheet
and requires an empty margin on all four sides of the content.

Usage:
  python scripts/bleed_check.py _tmp/cut_idle.png [--cols 2 --rows 2] [--min-gap 10]
Exit code 0 = every panel has margin (safe to slice), 1 = at least one clipped.
"""
import argparse
import json
import sys

import numpy as np
from PIL import Image


def check(path, cols=2, rows=2, thresh=20, min_gap=10):
    im = Image.open(path).convert("RGBA")
    a = np.array(im.getchannel("A")) > thresh
    H, W = a.shape
    cw, ch = W // cols, H // rows
    cells = []
    for r in range(rows):
        for c in range(cols):
            q = a[r * ch:(r + 1) * ch, c * cw:(c + 1) * cw]
            ys, xs = np.where(q)
            if len(ys) == 0:
                cells.append({"cell": [r, c], "ok": False, "reason": "empty"})
                continue
            gaps = {
                "top": int(ys.min()),
                "bottom": int(ch - 1 - ys.max()),
                "left": int(xs.min()),
                "right": int(cw - 1 - xs.max()),
            }
            worst = min(gaps.values())
            cells.append({
                "cell": [r, c],
                "ok": worst >= min_gap,
                "gaps": gaps,
                "worst_gap": int(worst),
            })
    return {"image": path, "grid": [rows, cols], "cell_size": [ch, cw],
            "min_gap": min_gap, "cells": cells,
            "clipped": sum(1 for x in cells if not x["ok"])}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("--cols", type=int, default=2)
    ap.add_argument("--rows", type=int, default=2)
    ap.add_argument("--min-gap", type=int, default=10)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    res = check(args.src, args.cols, args.rows, min_gap=args.min_gap)
    if args.json:
        print(json.dumps(res, ensure_ascii=False))
    else:
        print(f"[bleed] {res['image']} grid={res['grid']} cell={res['cell_size']} "
              f"min_gap={res['min_gap']}")
        for c in res["cells"]:
            if c["ok"]:
                print(f"[bleed]   cell{tuple(c['cell'])} OK  worst_gap={c['worst_gap']}")
            else:
                g = c.get("gaps")
                detail = f"gaps={g}" if g else c.get("reason")
                print(f"[bleed]   cell{tuple(c['cell'])} CLIPPED  {detail}")
        print(f"[bleed] verdict: "
              f"{'PASS' if res['clipped'] == 0 else 'FAIL (' + str(res['clipped']) + ' clipped)'}")
    return 0 if res["clipped"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
