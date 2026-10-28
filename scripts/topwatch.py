"""topwatch.py - sample the bubble window's extended style over time.

Prints a transition line whenever the WS_EX_TOPMOST bit changes, so we can tell
whether something keeps stripping it (and how often), instead of guessing.

Usage: python topwatch.py [seconds]
"""
import ctypes
import sys
import time
from ctypes import wintypes

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

u32 = ctypes.WinDLL("user32", use_last_error=True)
GWL_EXSTYLE = -20
WS_EX_TOPMOST = 0x00000008
TITLE = "蕾米莉亚桌宠"

EnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
found = []


def _collect(h, _l):
    n = u32.GetWindowTextLengthW(h)
    if n > 0:
        buf = ctypes.create_unicode_buffer(n + 1)
        u32.GetWindowTextW(h, buf, n + 1)
        if buf.value == TITLE and u32.IsWindowVisible(h):
            r = wintypes.RECT()
            u32.GetWindowRect(h, ctypes.byref(r))
            w, hh = r.right - r.left, r.bottom - r.top
            if w > 0 and hh > 0:
                found.append({"hwnd": h, "w": w, "h": hh, "ratio": w / float(hh)})
    return True


def snapshot():
    del found[:]
    u32.EnumWindows(EnumProc(_collect), 0)
    if not found:
        return []
    bubble = max(found, key=lambda d: d["ratio"])
    pet = min(found, key=lambda d: abs(d["ratio"] - 1.0))
    out = []
    for name, d in (("bubble", bubble), ("pet", pet)):
        ex = u32.GetWindowLongW(d["hwnd"], GWL_EXSTYLE) & 0xFFFFFFFF
        out.append((name, ex))
    return out


secs = float(sys.argv[1]) if len(sys.argv) > 1 else 6.0
start = time.time()
prev = {}
changes = 0
samples = 0
while time.time() - start < secs:
    for name, ex in snapshot():
        top = bool(ex & WS_EX_TOPMOST)
        samples += 1
        if name in prev and prev[name] != top:
            changes += 1
            print("t=%.2fs  %-6s TOPMOST %s -> %s   ex=0x%08X"
                  % (time.time() - start, name, prev[name], top, ex))
        prev[name] = top
    time.sleep(0.08)

print("--- summary: %d samples, %d transitions over %.1fs ---" % (samples, changes, secs))
for name, top in prev.items():
    print("  %-6s final TOPMOST=%s" % (name, top))
