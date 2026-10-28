# -*- coding: utf-8 -*-
"""蹲防中抓起：验证按下拖动的瞬间就切成 drag（而不是等松手）。"""
import ctypes, subprocess, re, sys, time
try: ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception: ctypes.windll.user32.SetProcessDPIAware()

u = ctypes.windll.user32
MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP = 0x0002, 0x0004
prof = sys.argv[1] if len(sys.argv) > 1 else "pet-v12"
log = subprocess.run(["cmd", "/c", "echo", "%APPDATA%"], capture_output=True, text=True).stdout.strip()
logfile = f"{log}\\{prof}\\.gate.log"

def petwin():
    out = subprocess.run([r"E:/python3.13/python.exe", "scripts/listwin.py"],
                         capture_output=True, text=True).stdout
    for b in out.split("hwnd=")[1:]:
        m = re.search(r"pid=(\d+)", b)
        r = re.search(r"rect=\((-?\d+),(-?\d+),(-?\d+),(-?\d+)\)\s+(\d+)x(\d+)", b)
        if not m or not r: continue
        w, h = int(r.group(5)), int(r.group(6))
        if w == 186 and h == 180:
            return (int(r.group(1)), int(r.group(2)), int(r.group(3)), int(r.group(4)))
    return None

def tail_log(n=25):
    try:
        with open(logfile, encoding="utf-8", errors="ignore") as f:
            return f.readlines()[-n:]
    except FileNotFoundError:
        return []

rc = petwin()
if not rc:
    print("FAIL: 找不到 186x180 的宠物窗口"); sys.exit(1)
cx, cy = (rc[0]+rc[2])//2, (rc[1]+rc[3])//2
print(f"宠物窗口 {rc}，抓取点 ({cx},{cy})")
u.SetCursorPos(cx, cy); time.sleep(0.25)
u.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0); time.sleep(0.12)
for i in range(1, 7):
    u.SetCursorPos(cx, cy - i*14); time.sleep(0.05)
time.sleep(0.3)
lines_mid = tail_log(18)
u.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0); time.sleep(0.5)
lines_end = tail_log(28)

print("\n--- 拖动期间日志 ---")
for l in lines_mid:
    if "[input]" in l or "[perf]" in l or "[land]" in l:
        print("  " + l.rstrip())
print("\n--- 松手后日志 ---")
for l in lines_end:
    if "[input]" in l:
        print("  " + l.rstrip())

alllog = "".join(lines_end)
import re as _re
m = _re.findall(r"drag start from=(\w+) now=(\w+)", alllog)
print("\n结论:", "PASS 抓起立刻变为 " + m[-1][1] if m else "FAIL 没看到 drag start 日志")
