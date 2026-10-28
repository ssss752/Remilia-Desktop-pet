#!/usr/bin/env python3
"""desktop-pet G2 static acceptance gate.

Checks a pet project's frame assets against the anti-fake-animation and
integrity rules. Exit code 0 = PASS, 1 = FAIL. Run this before delivery;
pipeline validate does NOT replace this gate.

Usage: python gate_check.py <project-dir>
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from pipeline import validate_dir  # noqa: E402

REQUIRED_FRAMES = {"drop": 1}  # states not listed need >= 2 frames
BUBBLE_MIN = 5
SINGLE_FRAME_STATES = set(REQUIRED_FRAMES.keys())


def check_alpha(pet):
    """素材透明度体检（G2 的一部分）。

    这套检查是补上两个真实事故的：帽子在浅色桌面上"透了一块"，根因是
    (1) 内部有 alpha=0 的小洞，(2) 透明区 RGB 全被清零，mipmap 平均时把
    边缘颜色往黑里拉。修法见 scripts/fix_alpha.py，这里是防复发。
    """
    sys.path.insert(0, str(Path(__file__).parent))
    out = []
    try:
        import fix_alpha as fa
    except Exception as e:
        return [f"alpha 检查跳过（fix_alpha 载入失败: {e}）"]
    for state_dir in sorted(pet.iterdir()):
        if not state_dir.is_dir() or state_dir.name.startswith("_"):
            continue
        bad_frames = []
        for f in sorted(state_dir.glob("frame_*.png")):
            nh, ns, nz = fa.fix_one(f, write=False)
            if nh or ns or nz:
                bad_frames.append(f"{f.name}(洞{nh}/半透明{ns}/黑边{nz})")
        if bad_frames:
            out.append(f"{state_dir.name}: 透明度异常 -> " + ", ".join(bad_frames[:3]))
    if not out:
        print("[gate_check] alpha OK: 无内部洞、无内部半透明、边缘无 RGB=0")
    return out


def check_bubbles(project):
    problems = []
    bubbles = project / "assets" / "bubbles"
    if not bubbles.is_dir():
        return [f"missing assets/bubbles/"]
    for txt in sorted(bubbles.glob("*.txt")):
        lines = [l for l in txt.read_text(encoding="utf-8").splitlines() if l.strip()]
        if len(lines) < BUBBLE_MIN:
            problems.append(f"bubbles/{txt.name}: {len(lines)} lines < {BUBBLE_MIN}")
    return problems


def check_config(project):
    problems = []
    cfg_path = project / "src" / "renderer" / "config.json"
    if not cfg_path.is_file():
        return [f"missing {cfg_path.relative_to(project)}"]
    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    except Exception as e:
        return [f"config.json parse error: {e}"]
    anims = cfg.get("animations", {})
    if not anims:
        problems.append("config.json: no animations defined")
    for name, spec in anims.items():
        loop = spec.get("loop", True)
        has_next = "next" in spec
        if not loop and not has_next:
            problems.append(f"config.json: non-looping state '{name}' has no 'next' (state machine deadlock)")
    for key in ("idle", "fly", "drag", "drop", "sleep"):
        if key not in anims:
            problems.append(f"config.json: missing required animation '{key}'")
    return problems, cfg


def main():
    project = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    pet = project / "assets" / "pet"
    problems = []

    print(f"[gate_check] project: {project}")
    if not pet.is_dir():
        print(f"[gate_check] FAIL: missing {pet}")
        sys.exit(1)

    cfg_result = check_config(project)
    cfg = {}
    if isinstance(cfg_result, tuple):
        cfg_problems, cfg = cfg_result
    else:
        cfg_problems = cfg_result
    problems += cfg_problems

    anims = cfg.get("animations", {}) if cfg else {}
    declared = set(anims.keys()) if anims else None
    # 别名状态（config 里写 "frames": "grip" 这种）复用另一套帧，本来就没有
    # 自己的素材目录，不应该要求它有一个。之前这里不认别名，peek/drop/fall
    # 全被误报成 missing —— 门禁喊狼来了，久了就没人信它了。
    alias = {n: s.get("frames") for n, s in (anims or {}).items() if isinstance(s, dict) and s.get("frames")}
    # 帧画布尺寸以 config.json 的 canvas 为准（不硬编码 256/512）
    expect = None
    canvas = cfg.get("canvas") if cfg else None
    if canvas and canvas.get("width") and canvas.get("height"):
        expect = (int(canvas["width"]), int(canvas["height"]))

    for state_dir in sorted(pet.iterdir()):
        if not state_dir.is_dir() or state_dir.name.startswith("_"):
            continue                                  # _props 等道具目录不参与帧校验
        frames = sorted(state_dir.glob("*.png"))
        n = len(frames)
        minimum = REQUIRED_FRAMES.get(state_dir.name, 2)
        if n < minimum:
            problems.append(f"{state_dir.name}: {n} frames < required {minimum}")
        if declared is not None and state_dir.name not in declared:
            problems.append(f"{state_dir.name}: dir not declared in config.json animations")
        problems += validate_dir(state_dir, expect)

    if declared:
        for name in declared:
            if (pet / name).is_dir():
                continue
            src = alias.get(name)
            if src and (pet / src).is_dir():
                print(f"[gate_check] '{name}' -> alias of '{src}' (no own dir, ok)")
                continue
            if src:
                problems.append(f"config.json: '{name}' aliases '{src}' but assets/pet/{src}/ missing")
            else:
                problems.append(f"config.json declares '{name}' but assets/pet/{name}/ missing")

    problems += check_bubbles(project)
    problems += check_alpha(pet)

    if problems:
        print(f"[gate_check] FAIL ({len(problems)} problems)")
        for p in problems:
            print(f"  - {p}")
        sys.exit(1)
    print("[gate_check] PASS: all states, frames, config and bubbles OK")
    sys.exit(0)


if __name__ == "__main__":
    main()
