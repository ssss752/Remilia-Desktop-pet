# -*- coding: utf-8 -*-
import ctypes
from ctypes import wintypes
from PIL import Image, ImageGrab
import numpy as np

PIDS = {19368}
u = ctypes.windll.user32
EnumWindows = u.EnumWindows
EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
GetWindowThreadProcessId = u.GetWindowThreadProcessId
IsWindowVisible = u.IsWindowVisible
GetWindowRect = u.GetWindowRect


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


found = []


def cb(hwnd, lparam):
    pid = wintypes.DWORD()
    GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if pid.value in PIDS and IsWindowVisible(hwnd):
        r = RECT()
        GetWindowRect(hwnd, ctypes.byref(r))
        found.append((r.left, r.top, r.right - r.left, r.bottom - r.top))
    return True


EnumWindows(EnumWindowsProc(cb), 0)
print("visible windows:", found)
if not found:
    raise SystemExit("no window")

x, y, w, h = found[0]
print("window logical: pos=(%d,%d) size=%dx%d" % (x, y, w, h))

im = ImageGrab.grab(all_screens=True)
im.save("_tmp/screen3.png")
print("fullscreen:", im.size)

# screen 2560x1440 physical vs 1707x960 logical -> factor 1.5
f = im.size[0] / 1707.0
px, py, pw, ph = int(x * f), int(y * f), int(w * f), int(h * f)
pad = 8
crop = im.crop((max(0, px - pad), max(0, py - pad), px + pw + pad, py + ph + pad))
crop.save("_tmp/pet-crop.png")
print("crop:", crop.size, "at", (px, py))

a = np.array(crop.convert("RGB")).astype(int)
R, G, B = a[:, :, 0], a[:, :, 1], a[:, :, 2]
H, W = crop.size

pink = (R > 165) & (R - G > 22) & (B > 110) & (B - G > 5)
ys, xs = np.where(pink)
print("pink pixels:", len(ys))
if len(ys):
    print("pink y: %d..%d of %d   x: %d..%d of %d" % (ys.min(), ys.max(), H, xs.min(), xs.max(), W))
    prof = [int(pink[i * H // 12:(i + 1) * H // 12].sum()) for i in range(12)]
    print("pink vertical profile (top->bottom):", prof)
    hp = [int(pink[:, i * W // 10:(i + 1) * W // 10].sum()) for i in range(10)]
    print("pink horizontal profile (left->right):", hp)

white = (R > 246) & (G > 242) & (B > 242)
wy, wx = np.where(white)
if len(wy):
    print("near-white: count=%d x %d..%d y %d..%d" % (len(wy), wx.min(), wx.max(), wy.min(), wy.max()))
    hw = [int(white[:, i * W // 10:(i + 1) * W // 10].sum()) for i in range(10)]
    print("white horizontal profile (left->right):", hw)
