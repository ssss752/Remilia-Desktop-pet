# -*- coding: utf-8 -*-
"""诊断：素材内洞里的 RGB 是否还在，原图是否带 alpha。"""
import os, glob
from PIL import Image, ImageDraw

ROOT = os.path.dirname(__file__)
PET = os.path.join(ROOT, "..", "assets", "pet")


def holes_mask(a, w, h):
    mask = a.point(lambda v: 0 if v < 32 else 255)
    for sx, sy in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        if mask.getpixel((sx, sy)) == 0:
            ImageDraw.floodfill(mask, (sx, sy), 128)
    return mask


for f in ["idle/frame_000.png", "greet/frame_000.png", "fall/frame_001.png"]:
    p = os.path.join(PET, f)
    img = Image.open(p).convert("RGBA")
    w, h = img.size
    a = img.split()[3]
    mask = holes_mask(a, w, h)
    px_img, px_m = img.load(), mask.load()
    inside = []
    for y in range(h):
        for x in range(w):
            if px_m[x, y] == 0:
                inside.append(px_img[x, y])
    n = len(inside) or 1
    avg = tuple(sum(c[i] for c in inside) // n for i in range(3))
    white = sum(1 for c in inside if c[0] > 240 and c[1] > 240 and c[2] > 240)
    black = sum(1 for c in inside if c[0] < 15 and c[1] < 15 and c[2] < 15)
    print(f"{f}: 洞={len(inside)} 平均RGB={avg} 纯白占比={white/n*100:.0f}% 纯黑占比={black/n*100:.0f}%")

print("\n=== 原图 ===")
for p in sorted(glob.glob(os.path.join(ROOT, "..", "_raw2", "*.png"))) + \
         sorted(glob.glob(os.path.join(ROOT, "..", "_raw3", "*.png"))):
    im = Image.open(p)
    mode = im.mode
    info = ""
    if mode in ("RGBA", "LA", "P"):
        rgba = im.convert("RGBA")
        al = rgba.split()[3]
        lo, hi = al.getextrema()
        info = f" alpha_range={lo}-{hi}"
        # 四角 alpha
        w, h = rgba.size
        corners = [rgba.getpixel(c)[3] for c in ((0, 0), (w-1, 0), (0, h-1), (w-1, h-1))]
        info += f" corners_alpha={corners}"
    print(f"{os.path.basename(p)}: {mode} {im.size}{info}")
