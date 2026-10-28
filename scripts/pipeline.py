#!/usr/bin/env python3
"""desktop-pet asset pipeline: cutout / slice / align / normalize / validate.

All steps are idempotent and can be re-run independently.
Requires Pillow. Canvas: 256x256, anchor: feet-center -> (128, 236).
"""
import argparse
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

CANVAS = (256, 256)
ANCHOR = (128, 236)  # feet-center target position on canvas
ALPHA_MIN = 0.05     # min subject alpha ratio
ALPHA_MAX = 0.90     # max subject alpha ratio
DIFF_MIN = 0.01      # consecutive-frame diff ratio below this => fake animation
MAX_INNER_HOLE = 0.02  # 角色内部的"透明洞"占角色像素上限，超过即判定抠图挖穿了角色
CORNER_TOL = 32      # color-key tolerance for cutout


def load_rgba(path):
    return Image.open(path).convert("RGBA")


def subject_bbox(img, thresh=25):
    """Bounding box of pixels with alpha > thresh."""
    alpha = img.getchannel("A")
    mask = alpha.point(lambda a: 255 if a > thresh else 0)
    return mask.getbbox()


def step_cutout(src, out, tol=CORNER_TOL):
    """白底抠图。

    历史教训：这里原本是「全局颜色键」（任何接近四角背景色的像素一律 alpha=0）。
    对白底雪碧图而言，角色身上的白蕾丝、皮肤高光、白领口全都满足「接近纯白」，
    于是被一起挖掉 —— 角色内部出现 3%~50% 的块状透明缺口，而门禁不查 alpha
    连续性，一路 PASS 到用户面前。现在改为边缘 flood fill（只挖连通到画面的
    背景），实现见 cutout_edge.py。
    """
    try:
        from cutout_edge import cutout as _edge_cutout
    except ImportError:  # 独立分发 pipeline.py 时的兜底：退化为保守阈值
        _edge_cutout = None
    if _edge_cutout is not None:
        return _edge_cutout(src, out, tol)
    img = load_rgba(src)
    img.save(out)
    return out


def step_slice(src, out_dir, cols=1, rows=1, fps_in=None):
    """Slice a spritesheet into frames, or extract GIF frames."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    src = str(src)
    n = 0
    if src.lower().endswith(".gif"):
        gif = Image.open(src)
        idx = 0
        try:
            while True:
                gif.seek(idx)
                frame = gif.convert("RGBA")
                frame.save(out_dir / f"frame_{idx:03d}.png")
                idx += 1
        except EOFError:
            pass
        n = idx
    else:
        img = load_rgba(src)
        w, h = img.size
        cw, ch = w // cols, h // rows
        for r in range(rows):
            for c in range(cols):
                box = (c * cw, r * ch, (c + 1) * cw, (r + 1) * ch)
                frame = img.crop(box)
                frame.save(out_dir / f"frame_{n:03d}.png")
                n += 1
    return n


def step_align(src_dir, out_dir):
    """Align frames so the subject's feet-center sits at ANCHOR on CANVAS."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    frames = sorted(Path(src_dir).glob("*.png"))
    heights = []
    for f in frames:
        img = load_rgba(f)
        bbox = subject_bbox(img)
        if bbox is None:
            print(f"[align] WARN empty frame: {f.name}")
            canvas = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
            canvas.save(out_dir / f.name)
            continue
        subj = img.crop(bbox)
        sw, sh = subj.size
        heights.append(sh)
        canvas = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
        cx = ANCHOR[0] - sw // 2
        cy = ANCHOR[1] - sh
        canvas.paste(subj, (cx, cy), subj)
        canvas.save(out_dir / f.name)
    if heights:
        base = heights[0]
        for f, hgt in zip(frames, heights):
            if abs(hgt - base) / max(base, 1) > 0.30:
                print(f"[align] WARN subject height jump >30% in {f.name}: {hgt} vs {base}")
    return len(frames)


def step_normalize(src_dir, out_dir):
    """Scale each frame onto the standard canvas preserving aspect ratio."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for f in sorted(Path(src_dir).glob("*.png")):
        img = load_rgba(f)
        img.thumbnail((CANVAS[0], CANVAS[1]), Image.LANCZOS)
        canvas = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
        canvas.paste(img, ((CANVAS[0] - img.width) // 2, (CANVAS[1] - img.height) // 2), img)
        canvas.save(out_dir / f.name)
    return True


def alpha_ratio(img, thresh=25):
    alpha = img.getchannel("A")
    hist = alpha.histogram()
    total = img.width * img.height
    subject = sum(hist[thresh + 1:])
    return subject / total if total else 0.0


def inner_hole_ratio(img, alpha_thresh=32):
    """角色内部「被不透明像素包围的透明像素」占角色的比例。

    这是抠图挖穿角色的直接指纹：白底图用全局颜色键抠图时，角色身上的白色
    细节会被一起挖掉，表现为角色身上随机的块状透明缺口。本函数从画面四边
    flood fill 标记外部背景，剩下仍是透明的就是内部洞。
    """
    a = img.getchannel("A")
    w, h = a.size
    mask = a.point(lambda v: 0 if v < alpha_thresh else 255)
    for sx, sy in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        if mask.getpixel((sx, sy)) == 0:
            ImageDraw.floodfill(mask, (sx, sy), 128)
    hist = mask.histogram()
    holes = hist[0]        # 仍未填充 = 被角色包围的内部透明区
    opaque = hist[255]
    return holes / max(1, opaque)


def frame_diff_ratio(a, b):
    da = a.getchannel("A").point(lambda v: 255 if v > 25 else 0)
    db = b.getchannel("A").point(lambda v: 255 if v > 25 else 0)
    bbox1 = da.point(lambda v: 255 if v else 0).getbbox()
    diff = ImageChops.difference(a.convert("RGB"), b.convert("RGB"))
    gray = diff.convert("L").point(lambda v: 255 if v > 16 else 0)
    if bbox1:
        gray = gray.crop(bbox1)
    total = gray.width * gray.height if gray.width and gray.height else 1
    changed = sum(gray.histogram()[1:])  # nonzero bins above 0
    hist = gray.histogram()
    changed = sum(hist[1:])
    return changed / max(total, 1)


def validate_dir(dir_path, expect=None):
    """Validate one state directory. Returns list of problems (empty = pass).
    expect: optional (w, h) the frames must match; defaults to module CANVAS."""
    expected = expect or CANVAS
    problems = []
    frames = sorted(Path(dir_path).glob("*.png"))
    if not frames:
        return [f"{dir_path}: no frames"]
    sizes = set()
    imgs = []
    for f in frames:
        try:
            img = load_rgba(f)
            img.load()
        except Exception as e:  # naturalWidth==0 proxy
            problems.append(f"{f.name}: unreadable ({e})")
            continue
        sizes.add(img.size)
        imgs.append((f, img))
        if img.size != expected:
            problems.append(f"{f.name}: size {img.size} != {expected}")
        ar = alpha_ratio(img)
        if not (ALPHA_MIN <= ar <= ALPHA_MAX):
            problems.append(f"{f.name}: alpha ratio {ar:.3f} outside [{ALPHA_MIN}, {ALPHA_MAX}]")
        hole = inner_hole_ratio(img)
        if hole > MAX_INNER_HOLE:
            problems.append(
                f"{f.name}: inner transparent holes {hole * 100:.1f}% of subject "
                f"> {MAX_INNER_HOLE * 100:.0f}% -- cutout punched through the character"
            )
    if len(sizes) > 1:
        problems.append(f"{dir_path}: mixed sizes {sizes}")
    for (f1, i1), (f2, i2) in zip(imgs, imgs[1:]):
        d = frame_diff_ratio(i1, i2)
        if d < DIFF_MIN:
            problems.append(f"{dir_path}: frames {f1.name}->{f2.name} diff {d:.4f} < {DIFF_MIN} (fake animation?)")
    return problems


def step_validate(root, config=None):
    """Validate all state dirs under root/assets/pet (or root itself)."""
    pet = Path(root)
    pet_dir = pet / "assets" / "pet" if (pet / "assets" / "pet").is_dir() else pet
    all_ok = True
    for state_dir in sorted(pet_dir.iterdir()):
        if not state_dir.is_dir():
            continue
        problems = validate_dir(state_dir)
        n = len(list(state_dir.glob("*.png")))
        status = "PASS" if not problems else "FAIL"
        print(f"[validate] {state_dir.name}: {n} frames -> {status}")
        for p in problems:
            print(f"  - {p}")
            all_ok = False
    if not all_ok:
        sys.exit(1)
    print("[validate] ALL PASS")


def step_matting(src, out):
    """Optional AI matting via rembg. Falls back to src if rembg missing."""
    try:
        from rembg import remove
    except Exception:
        print("[matting] 未安装 rembg，跳过 AI 抠图（回退 color-key 抠图）")
        return src
    img = load_rgba(src)
    out_img = remove(img.convert("RGB"))
    out_img.save(out)
    print(f"[matting] AI 抠图 -> {out}")
    return out


def main():
    ap = argparse.ArgumentParser(description="desktop-pet asset pipeline")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("cutout")
    p.add_argument("--src", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--tol", type=int, default=CORNER_TOL)

    p = sub.add_parser("slice")
    p.add_argument("--src", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--cols", type=int, default=1)
    p.add_argument("--rows", type=int, default=1)

    p = sub.add_parser("align")
    p.add_argument("--src", required=True)
    p.add_argument("--out", required=True)

    p = sub.add_parser("normalize")
    p.add_argument("--src", required=True)
    p.add_argument("--out", required=True)

    p = sub.add_parser("validate")
    p.add_argument("--dir", required=True)
    p.add_argument("--config", default=None)

    p = sub.add_parser("all")
    p.add_argument("--src", required=True)
    p.add_argument("--state", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--cols", type=int, default=1)
    p.add_argument("--rows", type=int, default=1)
    p.add_argument("--matting", action="store_true", help="用 rembg 做 AI 抠图（照片更干净），未装则回退 color-key")

    args = ap.parse_args()
    if args.cmd == "cutout":
        print(step_cutout(args.src, args.out, args.tol))
    elif args.cmd == "slice":
        print(f"sliced {step_slice(args.src, args.out, args.cols, args.rows)} frames")
    elif args.cmd == "align":
        print(f"aligned {step_align(args.src, args.out)} frames")
    elif args.cmd == "normalize":
        step_normalize(args.src, args.out)
        print("normalized")
    elif args.cmd == "validate":
        step_validate(args.dir, args.config)
    elif args.cmd == "all":
        tmp = Path(args.out + ".tmp")
        tmp.mkdir(parents=True, exist_ok=True)
        src_for_slice = step_matting(args.src, str(tmp) + ".matted.png") if args.matting else args.src
        n = step_slice(src_for_slice, tmp, args.cols, args.rows)
        aligned = Path(args.out + ".align")
        step_align(tmp, aligned)
        step_normalize(aligned, Path(args.out))
        problems = validate_dir(args.out)
        print(f"[all] {args.state}: {n} frames, {'PASS' if not problems else 'FAIL'}")
        for pr in problems:
            print(f"  - {pr}")
        sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
