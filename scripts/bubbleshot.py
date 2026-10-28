"""bubbleshot.py - find the pet window + bubble window, then screenshot them together.

Both windows share the same title, so they are told apart by shape:
  pet    -> square-ish (w/h close to 1, height ~= 90 physical px)
  bubble -> wide and short (aspect ratio ~3.2)

Crop is taken from the union of both rects, so whatever the pet happens to do,
the shot always frames both of them. DPI aware, so coordinates are physical px.
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

from PIL import Image, ImageGrab   # noqa: E402

u32 = ctypes.WinDLL("user32", use_last_error=True)
TITLE = "蕾米莉亚桌宠"
EnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
found = []


def _rect(h):
    r = wintypes.RECT()
    u32.GetWindowRect(h, ctypes.byref(r))
    return r.left, r.top, r.right, r.bottom


def _collect(h, _l):
    n = u32.GetWindowTextLengthW(h)
    if n > 0:
        buf = ctypes.create_unicode_buffer(n + 1)
        u32.GetWindowTextW(h, buf, n + 1)
        if buf.value == TITLE and u32.IsWindowVisible(h):
            l, t, r, b = _rect(h)
            w, hh = r - l, b - t
            if w > 0 and hh > 0:
                found.append({"hwnd": h, "rect": (l, t, r, b), "w": w, "h": hh,
                              "ratio": w / float(hh)})
    return True


u32.EnumWindows(EnumProc(_collect), 0)
if not found:
    print("FAIL: no visible window titled %r" % TITLE)
    sys.exit(1)

pet = min(found, key=lambda d: abs(d["ratio"] - 1.0))
bubble = max(found, key=lambda d: d["ratio"])
print("windows found: %d" % len(found))
for d in found:
    print("  rect=%s %dx%d ratio=%.2f" % (d["rect"], d["w"], d["h"], d["ratio"]))
print("pet    -> %s" % (pet["rect"],))
print("bubble -> %s" % (bubble["rect"],))

time.sleep(0.12)   # let DWM finish composing before grabbing
img = ImageGrab.grab(all_screens=True)

left = max(0, min(pet["rect"][0], bubble["rect"][0]) - 24)
top = max(0, min(pet["rect"][1], bubble["rect"][1]) - 24)
right = min(img.width, max(pet["rect"][2], bubble["rect"][2]) + 24)
bottom = min(img.height, max(pet["rect"][3], bubble["rect"][3]) + 24)

crop = img.crop((left, top, right, bottom))
print("crop (%d,%d)-(%d,%d) -> %dx%d" % (left, top, right, bottom, crop.width, crop.height))
scale = int(sys.argv[2]) if len(sys.argv) > 2 else 3
crop = crop.resize((crop.width * scale, crop.height * scale), Image.LANCZOS)

out = sys.argv[1] if len(sys.argv) > 1 else "_tmp/bubble-pair.png"
crop.save(out)
print("saved:", out, crop.size)
