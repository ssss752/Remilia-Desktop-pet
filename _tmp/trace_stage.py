# -*- coding: utf-8 -*-
"""扫描所有中间产物目录，找出"从哪一步开始出现内洞"。"""
import os, glob
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(__file__), "..")
THRESH = 32


def holes(img):
    a = img.split()[3]
    w, h = a.size
    mask = a.point(lambda v: 0 if v < THRESH else 255)
    for sx, sy in ((0, 0), (w-1, 0), (0, h-1), (w-1, h-1)):
        if mask.getpixel((sx, sy)) == 0:
            ImageDraw.floodfill(mask, (sx, sy), 128)
    px = mask.load()
    hole = 0
    total = 0
    for y in range(h):
        for x in range(w):
            v = px[x, y]
            if v == 0:
                hole += 1
            elif v == 255:
                total += 1
    return hole, total, w, h


def report(label, path):
    img = Image.open(path).convert("RGBA")
    hole, total, w, h = holes(img)
    al = img.split()[3]
    lo, hi = al.getextrema()
    alpha_ratio = total / (w * h) * 100
    pct = hole / max(1, total) * 100
    print(f"  {label:22s} {w}x{h} alpha_range={lo}-{hi} 不透明={alpha_ratio:5.1f}% 内洞={hole:6d}px ({pct:4.1f}%)")


print("=== 原始雪碧图 ===")
for p in sorted(glob.glob(os.path.join(ROOT, "_raw2", "*.png")))[:2] + \
         sorted(glob.glob(os.path.join(ROOT, "_raw3", "*.png"))):
    report(os.path.basename(p), p)

for stage in ["slice", "hi", "align"]:
    print(f"\n=== _tmp/{stage}_*  (取 idle 状态第 0 帧) ===")
    for d in sorted(glob.glob(os.path.join(ROOT, "_tmp", stage + "_*"))):
        fs = sorted(glob.glob(os.path.join(d, "*.png")))
        if not fs:
            print(f"  {os.path.basename(d)}: 空")
            continue
        report(os.path.basename(d) + "/0", fs[0])

print("\n=== 最终产物 ===")
for p in ["assets/pet/idle/frame_000.png", "assets/pet/greet/frame_000.png"]:
    report(p, os.path.join(ROOT, p))
