# -*- coding: utf-8 -*-
"""全状态网格预览：贴在深色底上，缺口一眼可见。"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PET = ROOT / "assets" / "pet"
OUT = ROOT / "_tmp" / "all_states.png"
CELL = 130
PAD = 6
BG = (38, 32, 44, 255)

states = [d.name for d in sorted(PET.iterdir()) if d.is_dir() and not d.name.startswith("_")]
rows = []
for st in states:
    frames = sorted((PET / st).glob("frame_*.png"))
    rows.append((st, frames))

cols = max(len(f) for _, f in rows)
W = cols * (CELL + PAD) + PAD
H = len(rows) * (CELL + PAD) + PAD
canvas = Image.new("RGBA", (W, H), (24, 20, 28, 255))
for r, (st, frames) in enumerate(rows):
    for c, f in enumerate(frames):
        img = Image.open(f).convert("RGBA").resize((CELL, CELL), Image.LANCZOS)
        cellb = Image.new("RGBA", (CELL, CELL), BG)
        cellb.alpha_composite(img)
        canvas.paste(cellb, (PAD + c * (CELL + PAD), PAD + r * (CELL + PAD)))
canvas.save(OUT)
print(f"{OUT} ({W}x{H}) 行顺序: {', '.join(s for s, _ in rows)}")
