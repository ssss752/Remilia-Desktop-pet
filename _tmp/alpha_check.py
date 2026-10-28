# -*- coding: utf-8 -*-
"""检查帧素材的 alpha 通道：角色内部是否存在"洞"（被不透明像素包围的透明像素）。
如果素材本身有洞，渲染层再怎么改都会看到块状透明缺失。"""
import os, sys, glob
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(__file__), "..", "assets", "pet")
THRESH = 32  # alpha < 32 视为透明


def inner_holes(path):
    img = Image.open(path).convert("RGBA")
    a = img.split()[3]
    w, h = a.size
    # 二值化：透明->0，不透明->255
    mask = a.point(lambda v: 0 if v < THRESH else 255)
    # 从四边把所有"连到外界"的透明区填成 128
    for sx, sy in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        if mask.getpixel((sx, sy)) == 0:
            ImageDraw.floodfill(mask, (sx, sy), 128)
    px = mask.load()
    holes = 0
    for y in range(h):
        for x in range(w):
            if px[x, y] == 0:
                holes += 1
    # 统计不透明像素总量，用于算洞的占比
    total = sum(1 for y in range(h) for x in range(w) if px[x, y] == 255)
    return holes, total, w, h


def main():
    rows = []
    for state_dir in sorted(glob.glob(os.path.join(ROOT, "*"))):
        if not os.path.isdir(state_dir):
            continue
        name = os.path.basename(state_dir)
        if name.startswith("_"):
            continue
        for f in sorted(glob.glob(os.path.join(state_dir, "frame_*.png"))):
            holes, total, w, h = inner_holes(f)
            if holes > 20:
                rows.append((name, os.path.basename(f), holes, total, w, h))
    if not rows:
        print("OK: 所有帧内部无洞（alpha 连续）")
        return
    print("发现内洞的帧（阈值 >20 像素）：")
    bad_states = {}
    for name, fn, holes, total, w, h in rows:
        pct = holes / max(1, total) * 100
        print(f"  {name}/{fn}: 洞={holes}px 占角色 {pct:.1f}%  total={total} canvas={w}x{h}")
        bad_states[name] = max(bad_states.get(name, 0), holes)
    print("\n受影响状态:", ", ".join(sorted(bad_states)))


if __name__ == "__main__":
    main()
