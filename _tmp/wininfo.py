# -*- coding: utf-8 -*-
import ctypes
from ctypes import wintypes

u = ctypes.windll.user32
EnumWindows = u.EnumWindows
EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
GetWindowThreadProcessId = u.GetWindowThreadProcessId
IsWindowVisible = u.IsWindowVisible
GetWindowTextW = u.GetWindowTextW
GetWindowTextLengthW = u.GetWindowTextLengthW
GetWindowRect = u.GetWindowRect
GetClassNameW = u.GetClassNameW

PIDS = {2060, 7128, 4216, 19484}

class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

rows = []

def cb(hwnd, lparam):
    pid = wintypes.DWORD()
    GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if pid.value in PIDS:
        n = GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(n + 1)
        GetWindowTextW(hwnd, buf, n + 1)
        cn = ctypes.create_unicode_buffer(256)
        GetClassNameW(hwnd, cn, 256)
        r = RECT()
        GetWindowRect(hwnd, ctypes.byref(r))
        rows.append((pid.value, hwnd, buf.value, cn.value,
                     bool(IsWindowVisible(hwnd)),
                     r.left, r.top, r.right - r.left, r.bottom - r.top))
    return True

EnumWindows(EnumWindowsProc(cb), 0)

sm = ctypes.windll.user32.GetSystemMetrics
print("screen: %dx%d  virtual: %dx%d" % (sm(0), sm(1), sm(78), sm(79)))
print("matched windows:", len(rows))
for pid, hwnd, title, cls, vis, x, y, w, h in rows:
    print("pid=%d hwnd=%d vis=%s pos=(%d,%d) size=%dx%d class=%s title=%r"
          % (pid, hwnd, vis, x, y, w, h, cls, title))
