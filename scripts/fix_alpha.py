#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fix_alpha.py -- 修掉帧素材里的「内部透明洞」与「内部半透明块」。

问题
----
蹲防时帽子上会透出桌面（用户实测反馈），睡觉时同样位置也有斑块。

**真正的原因：全透明区域的 RGB 全被清零了**（实测 100% 的 alpha=0 像素 RGB=0）。
渲染层（live2d.js）开了 mipmap + 线性采样：GPU 生成 mip 链时对**非预乘**的 RGBA
做平均，"透明像素的黑色"会把边缘颜色一起拉暗；屏幕上按 ~120pt 显示 512 的帧，
采样取到的正是 2~3 级 mip，于是浅色大面积区域（帽子）的边界变成灰蒙蒙一片，
在浅色桌面上看着就像"帽子透了一块"。

次要原因：
  1. 抠白底时，帽子这类浅粉高光与白底的通道差 < tol（24），并且通过抗锯齿
     细缝与画面外背景连通 —— flood fill 顺着缝"渗"进主体内部，挖出一小块
     alpha=0 的洞。
  2. 派生 / 缩放（LANCZOS、双线性逆映射）在主体内部留下 alpha<250 的半透明
     块。crouch 有 9 千多个这样的像素，平均 alpha 只有 90 上下。

修复原则
--------
**只动 alpha 通道和透明区里的颜色，不动任何可见像素的 RGB** —— 画风零变化。

  1. 透明区颜色外扩（首要修复）：把不透明像素的颜色向 alpha=0 的区域扩散，
     RGB 填满、alpha 保持 0。mipmap 再怎么平均也不会染黑了。
  2. 内部洞回填：从画面四边对 alpha<25 的区域做 flood，凡是到不了边缘的
     透明区就是"内部洞"→ RGB 用邻近颜色填上，alpha=255。
  3. 主体内部硬化：离透明区 ≥ 2px 的核心区，alpha 一律拉到 255。
     边缘 1~2px 的抗锯齿保留，否则轮廓会变锯齿。

三步都幂等，跑两次结果一致。

用法：
  python scripts/fix_alpha.py --check          # 只体检，不改文件
  python scripts/fix_alpha.py                  # 修全部状态
  python scripts/fix_alpha.py --only crouch sleep
"""
import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from cutout_edge import bleed_colors  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PET = ROOT / "assets" / "pet"
HOLE_ALPHA = 25          # alpha 低于此值视为"透明"
CORE_ERODE = 2           # 核心区离透明边界的距离（px）；这一圈内的抗锯齿保留
BLEED_ROUNDS = 32        # 洞内颜色扩散轮数（最大的洞约 25px 宽，32 轮够）
OUTER_BLEED = 12         # 透明区要覆盖的方形半径（px）：mipmap 降 3 级 = 8px 半径
BLEED_STEPS = 24         # 实际扩散轮数。bleed 走的是 4 邻域（曼哈顿距离），
                         # 要覆盖方形 12 的对角线得走 24 步，否则对角方向留白


def near_opaque(al, r=None):
    """贴近角色的透明像素（离不透明区 ≤ r 像素）。

    只有这一圈会影响 mipmap：GPU 降采样 3 级 = 8px 半径，再远就混不到边缘了。
    远端透明像素的 RGB 是 0 无所谓 —— 所以体检也只查这一圈，跑一次就能清零。
    """
    from PIL import ImageFilter
    r = OUTER_BLEED if r is None else r
    solid = Image.fromarray(((al >= HOLE_ALPHA) * 255).astype(np.uint8))
    k = r * 2 + 1
    grown = np.array(solid.filter(ImageFilter.MaxFilter(k))) > 0
    return grown & (al < HOLE_ALPHA)


def near_bright(al, rgb, r=None):
    """贴近「亮色」不透明像素的透明区。

    用来排除误报：角色有黑色描边（实测 alpha=255 且 RGB=(0,0,0)），描边外侧
    的透明区就算 RGB=0 也没问题 —— mipmap 混出来还是黑的，本来就该黑。
    真正会坏事的是"粉白帽子旁边那片 0"，混出来就是脏灰。
    """
    from PIL import ImageFilter
    # 默认只查 3px：真正会渗进帽子的是紧贴主体的那一两圈，离远了 mipmap 也混不到
    r = 3 if r is None else r
    bright = ((al >= HOLE_ALPHA) & (rgb.max(axis=2) > 60))
    m = Image.fromarray((bright * 255).astype(np.uint8))
    k = r * 2 + 1
    return (np.array(m.filter(ImageFilter.MaxFilter(k))) > 0) & (al < HOLE_ALPHA)


def spread8(rgb, known, rounds):
    """8 邻域颜色扩散。

    cutout_edge 里的 bleed 走 4 邻域（曼哈顿距离），对角方向要多花一倍步数，
    而且"先到先得" —— 深色描边会抢在粉色帽子前面把相邻透明区涂黑，正是这次
    mipmap 脏边的成因。这里换成 8 邻域，并用调用方控制优先级（先亮色后全部）。
    """
    rgb = rgb.astype(np.float32).copy()
    known = known.copy()
    for _ in range(rounds):
        acc = np.zeros_like(rgb)
        cnt = np.zeros(known.shape, dtype=np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0:
                    continue
                k = np.roll(np.roll(known, dy, 0), dx, 1)
                c = np.roll(np.roll(rgb, dy, 0), dx, 1)
                acc += c * k[..., None]
                cnt += k
        grow = (~known) & (cnt > 0)
        if not grow.any():
            break
        rgb[grow] = acc[grow] / cnt[grow][..., None]
        known |= grow
    return rgb


def bleed_outward(rgb, al, rounds=BLEED_STEPS):
    """把颜色向外扩散到透明区，**只改 RGB，不动 alpha**。

    这是修"帽子发灰像透明"的关键：透明区 RGB=0 时，GPU 生成 mipmap 会把边缘
    颜色往黑里平均，屏幕上看到帽檐一圈发脏。填上邻近颜色之后 mip 平均出来的
    仍然是角色本身的颜色，只是变淡 —— 那才是正确的抗锯齿观感。

    两遍：先只用**亮色**像素当源（保证粉色帽子/蕾丝外围是粉色），
    剩下的再用全部不透明像素兜底（黑色描边也是合法颜色）。
    """
    transparent = al < HOLE_ALPHA
    opaque = al >= HOLE_ALPHA
    bright = opaque & (rgb.max(axis=2) > 60)

    out = rgb.astype(np.float32).copy()
    first = spread8(out, bright, rounds)
    out[transparent] = first[transparent]
    second = spread8(out, opaque, rounds)
    out[transparent] = second[transparent]

    # 第三遍兜底：黑色描边会抢先把它外侧的透明像素涂黑，那几像素如果紧贴亮色主体
    # 就会在 mipmap 里渗进帽子边缘（实测残留 25~69px）。这里用亮色再兜一次。
    leftover = near_bright(al, rgb, r=3) & (out.max(axis=2) < 1)
    if leftover.any():
        third = spread8(out, bright, 8)
        out[leftover] = third[leftover]
    return out


def inner_holes(al):
    """返回「不与画面边缘连通」的透明像素掩码（= 主体内部的洞）。"""
    h, w = al.shape
    cand = al < HOLE_ALPHA
    visited = np.zeros(h * w, dtype=bool)
    flat = cand.reshape(-1)
    stack = []

    def push(i):
        if flat[i] and not visited[i]:
            visited[i] = True
            stack.append(i)

    for x in range(w):
        push(x)
        push((h - 1) * w + x)
    for y in range(h):
        push(y * w)
        push(y * w + w - 1)

    while stack:
        i = stack.pop()
        x = i % w
        for j, ok in ((i - w, i >= w), (i + w, i + w < h * w),
                      (i - 1, x > 0), (i + 1, x < w - 1)):
            if ok and flat[j] and not visited[j]:
                visited[j] = True
                stack.append(j)

    exterior = visited.reshape(h, w)
    return cand & ~exterior


def core_mask(al):
    """主体内部核心区：离透明区 ≥ CORE_ERODE 的地方。"""
    from PIL import ImageFilter
    solid = Image.fromarray(((al >= HOLE_ALPHA) * 255).astype(np.uint8))
    # MinFilter(r) 腐蚀 r//2 px；做 CORE_ERODE*2+1 得到腐蚀 CORE_ERODE 的效果
    k = CORE_ERODE * 2 + 1
    eroded = solid.filter(ImageFilter.MinFilter(k))
    return np.array(eroded) > 0


def fix_one(path, write=True):
    """返回 (洞像素数, 半透明像素数, 透明区RGB为0的像素数)。"""
    img = Image.open(path).convert("RGBA")
    arr = np.array(img)
    rgb = arr[:, :, :3].astype(np.float32)
    al = arr[:, :, 3].astype(np.int32)

    holes = inner_holes(al)
    core = core_mask(al)
    semi = core & (al < 250) & (al >= HOLE_ALPHA)
    n_hole = int(holes.sum())
    n_semi = int(semi.sum())
    # 贴近亮色主体的透明像素里 RGB 完全为 0 的数量 —— 这就是 mipmap 染黑的源头
    zero_rgb = near_bright(al, rgb) & (rgb.max(axis=2) == 0)
    n_zero = int(zero_rgb.sum())

    if not write:
        return n_hole, n_semi, n_zero

    if n_hole == 0 and n_semi == 0 and n_zero == 0:
        return 0, 0, 0

    # 1) 洞内颜色：把不透明像素的颜色向洞里扩散（RGB=0 的洞直接补 255 会变黑斑）。
    #    必须排在颜色外扩**之前** —— 洞当时还是 alpha=0，会挡住扩散，导致洞外那圈
    #    透明像素拿不到颜色（实测残留 25px 怎么也修不掉）。
    if n_hole:
        opaque = al >= HOLE_ALPHA
        filled = bleed_colors(rgb, opaque, rounds=BLEED_ROUNDS)
        rgb[holes] = filled[holes]
        al[holes] = 255

    # 2) 透明区颜色外扩（首要修复：mipmap 混色不再染黑）
    rgb = bleed_outward(rgb, al)

    # 3) 核心区半透明硬化：这些位置本来就该是实心的，半透明只可能来自重采样
    if n_semi:
        al[semi] = 255

    out = np.dstack([np.clip(rgb, 0, 255).astype(np.uint8),
                     np.clip(al, 0, 255).astype(np.uint8)])
    Image.fromarray(out, "RGBA").save(path)
    return n_hole, n_semi, n_zero


def states_in(only):
    if only:
        return list(only)
    return sorted(d.name for d in PET.iterdir()
                  if d.is_dir() and not d.name.startswith("_"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", default=None)
    ap.add_argument("--check", action="store_true", help="只体检不改文件")
    args = ap.parse_args()

    total_h = total_s = total_z = 0
    bad = []
    for st in states_in(args.only):
        d = PET / st
        files = sorted(d.glob("frame_*.png"))
        if not files:
            continue
        sh = ss = sz = 0
        for f in files:
            nh, ns, nz = fix_one(f, write=not args.check)
            sh += nh
            ss += ns
            sz += nz
        total_h += sh
        total_s += ss
        total_z += sz
        flag = "OK" if sh == 0 and ss == 0 and sz == 0 else ("待修" if args.check else "已修")
        print(f"[{'check' if args.check else 'fix'}] {st:9s} {len(files)}帧 "
              f"内部洞={sh:5d}px 内部半透明={ss:5d}px 透明区RGB黑={sz:7d}px  {flag}")
        if args.check and (sh or ss or sz):
            bad.append(st)

    print(f"\n合计：内部洞 {total_h}px，内部半透明 {total_s}px，透明区 RGB 为 0 {total_z}px")
    if args.check:
        print("体检结果：" + ("FAIL " + ",".join(bad) if bad else "PASS 全部干净"))
        return 1 if bad else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
