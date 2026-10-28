#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""rebuild_assets.py -- 从白底原图重建全部状态的帧素材。

管线：cutout_edge -> smart_slice -> recolor -> fit_align

批次自动判定
------------
同一状态有两批原图（_raw 暖白底 14 个状态齐全 / _raw2 冷白底只有 8 个）。
两批是不同批次的出图，直接混用会让画风跳变。本脚本把每个候选批次都跑一遍，
再和**当前线上帧**比相似度（只比旧帧实际可见的像素），选最像的那批 —— 这样
重建后视觉与用户已经看到的版本一致，只有"洞被补回来了"这一处变化。

帧数对齐
--------
沿用现有各状态的帧数（drop 就只有 1 帧），不擅自增删帧数，避免破坏
config.json 里的动画定义。

用法：
  python scripts/rebuild_assets.py --only idle        # 单状态试跑
  python scripts/rebuild_assets.py                    # 全量重建
"""
import argparse
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
TMP = ROOT / "_tmp" / "rebuild"
PET = ROOT / "assets" / "pet"
PY = sys.executable

STATES = ["grip", "drag", "drop", "fall", "float", "greet", "idle", "interact",
          "neko", "paw", "pout", "roll", "sleep"]

# drop 的原图是一整张单图（蹲伏落地 + 尘土），不是 4 格雪碧图，不能切分
NO_SLICE = {"drop"}


def candidates(state):
    """返回 [(批次名, 原图路径)]，只用真实存在的。"""
    out = []
    p1 = ROOT / "_raw" / f"sheet_{state}.png"
    if p1.exists():
        out.append(("raw", p1))
    p2 = ROOT / "_raw2" / f"sheet2_{state}.png"
    if p2.exists():
        out.append(("raw2", p2))
    return out


def run(*args):
    r = subprocess.run([PY, *map(str, args)], capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stdout[-1500:])
        print(r.stderr[-1500:])
        raise RuntimeError(f"step failed: {' '.join(map(str, args))}")
    return r.stdout


def build(state, batch, src):
    """跑一条完整管线，返回输出目录。"""
    out = TMP / f"{state}_{batch}"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    # 命名成 frame_000.png：recolor/fit_align 对单文件沿用原文件名，不统一命名
    # 会让下游产出的帧名对不上（曾导致 drop 写出 0 帧）
    cut = TMP / f"{state}_{batch}_cut" / "frame_000.png"
    run(ROOT / "scripts" / "cutout_edge.py", src, "--out", cut)

    if state in NO_SLICE:
        # 单图状态：不切分，直接进重着色
        rec = TMP / f"{state}_{batch}_rec"
        run(ROOT / "scripts" / "recolor.py", cut, "--out", rec)
        run(ROOT / "scripts" / "fit_align.py", rec, "--out", out)
        return out

    sliced = TMP / f"{state}_{batch}_slice"
    run(ROOT / "scripts" / "smart_slice.py", cut, "--out", sliced, "--cols", 2, "--rows", 2)

    rec = TMP / f"{state}_{batch}_rec"
    run(ROOT / "scripts" / "recolor.py", sliced, "--out", rec)

    run(ROOT / "scripts" / "fit_align.py", rec, "--out", out)
    return out


def sig(img, size=192):
    """统一尺度的指纹：轻微模糊以容忍 1~2px 位移差异。"""
    g = img.convert("RGBA").resize((size, size), Image.LANCZOS)
    g = g.filter(ImageFilter.GaussianBlur(1.6))
    return np.array(g).astype(np.float32)


def similarity(new_dir, old_dir, n_frames):
    """只用旧帧实际可见（alpha>25）的像素比较，返回平均 RGB 绝对误差（越小越像）。"""
    errs = []
    for i in range(n_frames):
        f_new = new_dir / f"frame_{i:03d}.png"
        f_old = old_dir / f"frame_{i:03d}.png"
        if not f_new.exists() or not f_old.exists():
            continue
        a = sig(Image.open(f_new))
        b = sig(Image.open(f_old))
        # 只用旧帧"实际可见"的像素做比较：旧帧的洞（alpha=0、RGB=0）会把
        # 差异数值整体拉高，用它选批次会把真正同源的那批判错。
        visible = b[:, :, 3] > 25
        if visible.sum() == 0:
            continue
        d = np.abs(a[:, :, :3] - b[:, :, :3]).max(axis=2)
        errs.append(float(d[visible].mean()))
    return sum(errs) / len(errs) if errs else 1e9


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default=None, help="只重建指定状态（逗号分隔）")
    ap.add_argument("--force-batch", default=None, help="强制使用某批次 raw / raw2")
    args = ap.parse_args()

    todo = STATES if not args.only else [s.strip() for s in args.only.split(",")]
    TMP.mkdir(parents=True, exist_ok=True)

    for state in todo:
        old_dir = PET / state
        if not old_dir.is_dir():
            print(f"[rebuild] SKIP {state}: {old_dir} 不存在")
            continue
        olds = sorted(old_dir.glob("frame_*.png"))
        n_frames = len(olds)
        if n_frames == 0:
            print(f"[rebuild] SKIP {state}: 没有帧")
            continue

        cands = candidates(state)
        if not cands:
            print(f"[rebuild] SKIP {state}: 找不到原图")
            continue
        if args.force_batch:
            cands = [c for c in cands if c[0] == args.force_batch] or cands

        results = []
        for batch, src in cands:
            try:
                out = build(state, batch, src)
            except Exception as e:
                print(f"[rebuild] {state}/{batch} 失败: {e}")
                continue
            score = similarity(out, old_dir, n_frames)
            results.append((score, batch, out))
            print(f"[rebuild] {state}/{batch}: 与线上帧差异={score:.2f}")

        if not results:
            print(f"[rebuild] FAIL {state}: 所有批次都失败")
            continue
        results.sort()
        score, batch, out = results[0]

        # 沿用原有帧数
        frames = sorted(out.glob("frame_*.png"))[:n_frames]
        if len(frames) < n_frames:
            print(f"[rebuild] WARN {state}: 只产出 {len(frames)} 帧，需要 {n_frames}")
        for i, f in enumerate(frames):
            shutil.copy2(f, old_dir / f"frame_{i:03d}.png")
        print(f"[rebuild] OK {state}: 采用批次 {batch} (差异 {score:.2f})，写入 {len(frames)} 帧")

    print("[rebuild] done")


if __name__ == "__main__":
    sys.exit(main())
