"""shot.py - DPI-aware full screen capture + crop.

Usage:
    python shot.py out.png [x1 y1 x2 y2] [scale]

DPI awareness is set BEFORE grabbing so the bitmap pixel grid matches the
coordinates reported by winprobe.py / listwin.py (both physical pixels).
Without this, a 150% scaled desktop returns a virtualized bitmap and every
crop lands in the wrong place.
"""
import ctypes
import sys

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)   # PROCESS_PER_MONITOR_DPI_AWARE
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

from PIL import Image, ImageGrab   # noqa: E402

out = sys.argv[1] if len(sys.argv) > 1 else "shot.png"
img = ImageGrab.grab(all_screens=True)
print("screen bitmap: %dx%d" % (img.size[0], img.size[1]))

if len(sys.argv) >= 6:
    x1, y1, x2, y2 = (int(v) for v in sys.argv[2:6])
    x2 = min(x2, img.width)
    y2 = min(y2, img.height)
    x1 = max(0, x1)
    y1 = max(0, y1)
    img = img.crop((x1, y1, x2, y2))
    print("cropped: (%d,%d)-(%d,%d) -> %dx%d" % (x1, y1, x2, y2, img.width, img.height))

scale = 1
if len(sys.argv) >= 7:
    scale = max(1, int(sys.argv[6]))
if scale > 1:
    img = img.resize((img.width * scale, img.height * scale), Image.LANCZOS)

img.save(out)
print("saved:", out, img.size)
