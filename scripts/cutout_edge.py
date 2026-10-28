#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""cutout_edge.py -- 正确的白底抠图：只挖「与画面边缘连通的背景」。

为什么需要它
------------
pipeline.py 的 step_cutout 用的是**全局颜色键**：任何与四角背景色相近的像素
一律 alpha=0。对白底雪碧图来说，角色身上的白蕾丝、皮肤高光、白领口、白色装饰
全部满足「接近纯白」，于是被一起挖掉 —— 角色内部出现大片块状透明缺口
（实测最严重的一帧有 50% 的角色像素被挖空）。

本工具改成标准做法：
  1. 从画面四条边出发做 flood fill，只沿「颜色接近背景色」的像素扩散；
  2. 只有**连通到外部**的背景才透明；
  3. 被角色描边包围的内部浅色像素完全不碰 —— 白蕾丝保留。

另外做两步善后：
  - 边缘 alpha 收 1px（MinFilter），去掉抗锯齿留下的白边；
  - 颜色外扩（bleed）：把不透明像素的颜色向透明区扩散 3 圈，这样后续
    LANCZOS 缩放不会因为透明区 RGB=0 而把角色边缘染黑/染白。

用法：
  python scripts/cutout_edge.py _raw/sheet_idle.png --out _tmp/edge_idle.png
"""
import argparse
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

BORDER_SAMPLE = 3        # 取多宽的边框统计背景色
DEFAULT_TOL = 24         # 与背景色的单通道最大差
BLEED_ROUNDS = 3


def estimate_bg(arr):
    """用四条边像素的中位数估计背景色（比取四角更抗噪）。"""
    b = BORDER_SAMPLE
    edges = np.concatenate([
        arr[:b, :, :3].reshape(-1, 3),
        arr[-b:, :, :3].reshape(-1, 3),
        arr[:, :b, :3].reshape(-1, 3),
        arr[:, -b:, :3].reshape(-1, 3),
    ])
    return np.median(edges.astype(np.float32), axis=0)


def flood_bg(cand):
    """从四边出发，在 cand 为 True 的像素上做连通扩散。返回外部背景 mask。"""
    h, w = cand.shape
    visited = np.zeros(h * w, dtype=bool)
    flat_cand = cand.reshape(-1)
    stack = []

    def push(idx):
        if flat_cand[idx] and not visited[idx]:
            visited[idx] = True
            stack.append(idx)

    for x in range(w):
        push(x)
        push((h - 1) * w + x)
    for y in range(h):
        push(y * w)
        push(y * w + w - 1)

    while stack:
        i = stack.pop()
        x = i % w
        if i >= w:
            j = i - w
            if flat_cand[j] and not visited[j]:
                visited[j] = True
                stack.append(j)
        if i + w < h * w:
            j = i + w
            if flat_cand[j] and not visited[j]:
                visited[j] = True
                stack.append(j)
        if x > 0:
            j = i - 1
            if flat_cand[j] and not visited[j]:
                visited[j] = True
                stack.append(j)
        if x < w - 1:
            j = i + 1
            if flat_cand[j] and not visited[j]:
                visited[j] = True
                stack.append(j)

    return visited.reshape(h, w)


def bleed_colors(rgb, opaque, rounds=BLEED_ROUNDS):
    """把不透明像素的颜色向透明区扩散，供缩放插值使用。"""
    rgb = rgb.astype(np.float32).copy()
    known = opaque.copy()
    for _ in range(rounds):
        acc = np.zeros_like(rgb)
        cnt = np.zeros(known.shape, dtype=np.float32)
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            k = np.roll(np.roll(known, dy, 0), dx, 1)
            c = np.roll(np.roll(rgb, dy, 0), dx, 1)
            acc += c * k[..., None]
            cnt += k
        grow = (~known) & (cnt > 0)
        if not grow.any():
            break
        rgb[grow] = (acc[grow] / cnt[grow][..., None])
        known |= grow
    return rgb


def cutout(src, out, tol=DEFAULT_TOL, erode=1):
    img = Image.open(src).convert("RGBA")
    arr = np.array(img)
    h, w = arr.shape[:2]
    rgb = arr[:, :, :3]
    bg = estimate_bg(arr)

    diff = np.abs(rgb.astype(np.float32) - bg[None, None, :]).max(axis=2)
    cand = diff <= tol
    exterior = flood_bg(cand)

    alpha = np.where(exterior, 0, 255).astype(np.uint8)
    out_img = Image.fromarray(np.dstack([rgb, alpha]), "RGBA")

    if erode > 0:
        # 收回 1px：抗锯齿过渡像素大半是背景色，留着会形成白边
        a = out_img.getchannel("A").filter(ImageFilter.MinFilter(3))
        out_img.putalpha(a)

    a = np.array(out_img.getchannel("A"))
    opaque = a > 25
    rgb_bleed = bleed_colors(rgb, opaque)
    final = np.dstack([np.clip(rgb_bleed, 0, 255).astype(np.uint8), a])
    Image.fromarray(final, "RGBA").save(out)

    kept = int(opaque.sum())
    print(f"[cutout-edge] {Path(src).name} bg={bg.round().astype(int).tolist()} "
          f"tol={tol} 不透明={kept}px ({kept / (w * h) * 100:.1f}%) -> {out}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("--out", required=True)
    ap.add_argument("--tol", type=int, default=DEFAULT_TOL)
    args = ap.parse_args()
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    cutout(args.src, args.out, args.tol)
    return 0


if __name__ == "__main__":
    sys.exit(main())
