#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""recolor.py -- local (zero-credit) character-design correction for Remilia.

Corrections (all derived from the official design, verified via web sources):
  - eyes:  lavender-purple -> BLOOD RED      (官方「眼睛是血红色」)
  - wings: purple          -> near-black grey (官方「黑色蝙蝠翅膀」)
  - shoes: red             -> black Mary Jane (官方「玛丽珍鞋」; 白短袜受姿势限制不可靠, 未加)

Detection is per-frame and colour-space based (HSV), so it adapts to pose.
Frames with closed eyes (sleep) or no visible feet (fall/roll) are simply left
untouched where the corresponding region is absent -- the masks just match
nothing, which is safe.
"""
import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image


def hsv(rgb):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    v = mx
    d = mx - mn
    s = np.where(mx > 0, d / np.maximum(mx, 1e-6), 0)
    h = np.zeros_like(v)
    m = d > 1e-6
    idx = m & (mx == r)
    h[idx] = (((g - b)[idx] / np.maximum(d[idx], 1e-6)) % 6)
    idx = m & (mx == g)
    h[idx] = ((b - r)[idx] / np.maximum(d[idx], 1e-6)) + 2
    idx = m & (mx == b)
    h[idx] = ((r - g)[idx] / np.maximum(d[idx], 1e-6)) + 4
    return h / 6.0, s, v


def hsv2rgb(h, s, v):
    i = (h * 6).astype(int) % 6
    f = h * 6 - np.floor(h * 6)
    p = v * (1 - s); q = v * (1 - f * s); t = v * (1 - (1 - f) * s)
    r = np.choose(i, [v, q, p, p, t, v])
    g = np.choose(i, [t, v, v, q, p, p])
    b = np.choose(i, [p, p, t, v, v, q])
    return np.stack([r, g, b], -1)


def process(img):
    arr = np.array(img.convert("RGBA")).astype(float)
    A = arr[:, :, 3]
    rgb = arr[:, :, :3] / 255.0
    h, s, v = hsv(rgb)

    ys, xs = np.where(A > 25)
    if len(ys) == 0:
        return img, (0, 0, 0)
    y0, y1 = int(ys.min()), int(ys.max())
    H = y1 - y0
    Y, X = np.mgrid[0:arr.shape[0], 0:arr.shape[1]]

    # --- eyes: purple -> blood red (only within the face band) ---
    band = (Y >= y0 + int(H * 0.26)) & (Y <= y0 + int(H * 0.47))
    eye = band & (h > 0.70) & (h < 0.90) & (s > 0.25) & (v < 0.80) & (v > 0.10)
    h2 = h.copy(); s2 = s.copy()
    h2[eye] = 0.985
    s2[eye] = np.clip(s[eye] * 1.5, 0, 0.85)

    # --- wings: dark purple -> near-black grey ---
    wing = (v < 0.52) & (h > 0.60) & (h < 0.98) & (s > 0.12)
    s2[wing] = 0.10
    h2[wing] = 0.0

    # --- shoes: saturated red near the bottom -> black Mary Jane ---
    shoeband = Y >= y0 + int(H * 0.80)
    shoe = shoeband & ((h < 0.05) | (h > 0.94)) & (s > 0.5) & (v < 0.80)
    s2[shoe] = 0.08
    v2 = v.copy()
    v2[shoe] = v[shoe] * 0.5

    out = arr.copy()
    out[:, :, :3] = hsv2rgb(h2, s2, v2) * 255
    res = Image.fromarray(out.astype("uint8"), "RGBA")
    return res, (int(eye.sum()), int(wing.sum()), int(shoe.sum()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")           # dir of frames, or single png
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    src = Path(args.src); out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    files = [src] if src.is_file() else sorted(src.glob("*.png"))
    tot = [0, 0, 0]
    for f in files:
        res, (ne, nw, ns) = process(Image.open(f))
        res.save(out / f.name)
        tot[0] += ne; tot[1] += nw; tot[2] += ns
    print(f"[recolor] {src} -> {out} frames={len(files)} "
          f"eye_px={tot[0]} wing_px={tot[1]} shoe_px={tot[2]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
