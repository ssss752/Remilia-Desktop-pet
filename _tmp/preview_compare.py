# -*- coding: utf-8 -*-
"""生成"修复前 vs 修复后"对比图：把帧贴在深色底上，内洞会一眼可见。"""
import sys
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
states = sys.argv[1].split(",") if len(sys.argv) > 1 else ["idle"]
out_path = ROOT / "_tmp" / "compare.png"

BG = (38, 32, 44, 255)     # 深紫灰：透明处显示成深色，缺口立刻暴露
CELL = 200
PAD = 8


def paste_on(img, cell):
    img = img.convert("RGBA").resize((cell, cell), Image.LANCZOS)
    bg = Image.new("RGBA", (cell, cell), BG)
    bg.alpha_composite(img)
    return bg


def label_row(imgs):
    row = Image.new("RGBA", (len(imgs) * (CELL + PAD) + PAD, CELL + PAD), (24, 20, 28, 255))
    for i, im in enumerate(imgs):
        row.paste(im, (PAD + i * (CELL + PAD), PAD))
    return row


backups = sorted((ROOT / "assets").glob("pet_backup_*"))
backup = backups[-1] if backups else None

rows = []
for st in states:
    before = sorted((backup / st).glob("frame_*.png")) if backup else []
    after = sorted((ROOT / "assets" / "pet" / st).glob("frame_*.png"))
    if before:
        rows.append(label_row([paste_on(Image.open(p), CELL) for p in before]))
    if after:
        rows.append(label_row([paste_on(Image.open(p), CELL) for p in after]))

w = max(r.width for r in rows)
h = sum(r.height for r in rows)
canvas = Image.new("RGBA", (w, h), (24, 20, 28, 255))
y = 0
for r in rows:
    canvas.paste(r, (0, y))
    y += r.height
canvas.save(out_path)
print(f"对比图 -> {out_path}  ({w}x{h})  上排=修复前 下排=修复后")
