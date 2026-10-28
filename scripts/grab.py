# grab.py - capture a screen region to a png (default: around the pet + menu)
import sys, time
from PIL import ImageGrab

x1, y1, x2, y2 = (int(v) for v in sys.argv[1:5]) if len(sys.argv) >= 5 else (1150, 560, 1550, 900)
out = sys.argv[5] if len(sys.argv) > 5 else "E:/WorkBuddy-Output/2026-10-27-12-00-52/remilia-pet/_tmp/screen.png"
img = ImageGrab.grab(bbox=(x1, y1, x2, y2), all_screens=True)
img.save(out)
print("saved", out, img.size)
