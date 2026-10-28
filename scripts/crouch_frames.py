#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""crouch_frames.py -- 从单张「抱头蹲防」立绘派生出落地反应的帧序列。

来源：用户提供的 1080x1080 白底立绘（双手抱头、蹲坐在地、翅膀张开）。
铁律是零付费、禁云端出图，所以这里不"重画"，而是做**形变派生**：

  以脚底为唯一支点（脚一移动就变成整体平移 = 伪动画），
  对上身做 squash & stretch 与横向摆动：
    - sy/sx  竖向压扁、横向撑开  -> 落地冲击的形变
    - sway   越靠上横向偏移越大，脚底恒为 0  -> 蹲着发抖的摇摆

所有形变都是逆映射 + 双线性采样，脚底像素恒在 y=472（与 idle/fly 等
所有状态对齐），因此不会出现帧间"整体位移"的假动画。

Usage:
  python scripts/crouch_frames.py <source> --out assets/pet/crouch
"""
import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from cutout_edge import cutout  # noqa: E402

CANVAS = 512
ANCHOR_Y = 472          # 脚底，与 fit_align.py / 其它所有状态一致
ANCHOR_X = 256
TARGET_H = 372          # 蹲姿的视觉高度（站立 idle 是 454，蹲下矮约 18%）
SIDE_PAD = 10
ALPHA_THRESH = 25


def bilinear(sub, xs, ys):
    """在 sub(RGBA float array, HxWx4) 上做双线性采样，越界返回全透明。"""
    h, w = sub.shape[:2]
    valid = (xs >= 0) & (xs <= w - 1) & (ys >= 0) & (ys <= h - 1)

    x0 = np.floor(xs).astype(np.int64)
    y0 = np.floor(ys).astype(np.int64)
    x1 = np.clip(x0 + 1, 0, w - 1)
    y1 = np.clip(y0 + 1, 0, h - 1)
    x0c = np.clip(x0, 0, w - 1)
    y0c = np.clip(y0, 0, h - 1)

    fx = (xs - x0)[..., None]
    fy = (ys - y0)[..., None]

    p00 = sub[y0c, x0c]
    p10 = sub[y0c, x1]
    p01 = sub[y1, x0c]
    p11 = sub[y1, x1]

    top = p00 * (1 - fx) + p10 * fx
    bot = p01 * (1 - fx) + p11 * fx
    out = top * (1 - fy) + bot * fy
    out[~valid] = 0.0
    return out


def warp_frame(sub, sy, sx, sway, head_lift=0.0):
    """以脚底为支点变形，输出 512x512 RGBA。

    sy   : 竖向缩放（<1 压扁，>1 拉长）
    sx   : 横向缩放
    sway : 上身横摆幅度，按 (上身高度的平方) 加权，脚底恒 0
    head_lift: 额外把上半身整体上抬的比例（起身用），脚底恒 0
    """
    h, w = sub.shape[:2]
    hh = float(h)

    Y, X = np.mgrid[0:CANVAS, 0:CANVAS].astype(np.float64)

    # 目标坐标 -> 以脚底为原点（v 向上为负，t=0 脚底，t=1 头顶）
    v_dst = Y - ANCHOR_Y
    u_dst = X - ANCHOR_X
    t = np.clip(-v_dst / hh, 0.0, 1.6)

    # 逆映射：先反 sway（越靠上反向偏移越大），再反缩放
    u = (u_dst - sway * hh * t * t) / sx
    v = v_dst / sy - head_lift * hh * (t * t) / sy

    xs = u + w / 2.0
    ys = v + (hh - 1.0)

    px = bilinear(sub, xs, ys)
    return px


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("--out", required=True)
    ap.add_argument("--target-h", type=float, default=TARGET_H)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    tmp_cut = out.parent.parent.parent / "_tmp" / "crouch_cut.png"
    tmp_cut.parent.mkdir(parents=True, exist_ok=True)

    src = Path(args.source)
    print(f"[crouch] cutout {src.name} ...")
    cutout(src, tmp_cut)

    img = Image.open(tmp_cut).convert("RGBA")
    a = np.array(img.getchannel("A"))
    ys, xs = np.where(a > ALPHA_THRESH)
    if len(ys) == 0:
        print("[crouch] ERROR cutout produced empty image")
        return 2
    box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    sub_img = img.crop(box)
    print(f"[crouch] subject bbox {box} -> {sub_img.width}x{sub_img.height}")

    # 统一缩放：高度优先，宽度超了再按宽度收
    scale = args.target_h / sub_img.height
    max_w = CANVAS - 2 * SIDE_PAD
    if sub_img.width * scale > max_w:
        scale = max_w / sub_img.width
        print(f"[crouch] width-bound: scale={scale:.4f}")
    nw = max(1, round(sub_img.width * scale))
    nh = max(1, round(sub_img.height * scale))
    sub_img = sub_img.resize((nw, nh), Image.LANCZOS)
    print(f"[crouch] scaled subject {nw}x{nh} (scale={scale:.4f})")

    sub = np.array(sub_img).astype(np.float64)
    # 换行：脚底在最后一行

    # 帧表：落地冲击 -> 回弹 -> 蹲实 -> 发抖(左/右) -> 蹲实 -> 缓起
    frames = [
        # (文件名, sy,   sx,   sway,  head_lift, 说明)
        ("frame_000", 0.86, 1.10, 0.000, 0.000),   # 着地瞬间：压扁撑开
        ("frame_001", 1.05, 0.96, 0.000, 0.000),   # 回弹：拉长收窄
        ("frame_002", 1.00, 1.00, 0.000, 0.000),   # 蹲实
        ("frame_003", 1.01, 0.99, -0.055, 0.000),  # 发抖：上身偏左
        ("frame_004", 0.99, 1.01, 0.055, 0.000),   # 发抖：上身偏右
        ("frame_005", 1.06, 0.96, 0.000, 0.030),   # 缓起：抬头，准备站起来
    ]

    for name, sy, sx, sway, lift in frames:
        px = warp_frame(sub, sy, sx, sway, lift)
        rgba = np.clip(px, 0, 255).astype(np.uint8)
        Image.fromarray(rgba, "RGBA").save(out / f"{name}.png")
        # 报告脚底与包围盒，防抖动的关键指标
        al = rgba[:, :, 3]
        yy, xx = np.where(al > ALPHA_THRESH)
        print(f"[crouch] {name}: bbox=({xx.min()},{yy.min()})-({xx.max()+1},{yy.max()+1}) "
              f"subj={xx.max()+1-xx.min()}x{yy.max()+1-yy.min()} feet={yy.max()+1}")

    print(f"[crouch] done -> {out} ({len(frames)} frames)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
