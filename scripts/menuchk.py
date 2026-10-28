# menuchk.py - list top-level windows of the pet process, to see if the custom menu showed up
import ctypes
from ctypes import wintypes

u32 = ctypes.WinDLL("user32", use_last_error=True)
rows = []


@ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
def cb(h, l):
    r = wintypes.RECT()
    u32.GetWindowRect(h, ctypes.byref(r))
    w, hh = r.right - r.left, r.bottom - r.top
    cls = ctypes.create_unicode_buffer(256)
    u32.GetClassNameW(h, cls, 256)
    if cls.value.startswith("Chrome_WidgetWin"):
        pid = wintypes.DWORD()
        u32.GetWindowThreadProcessId(h, ctypes.byref(pid))
        ex = u32.GetWindowLongW(h, -20) & 0xFFFFFFFF
        rows.append((h, pid.value, w, hh, r.left, r.top, ex, u32.IsWindowVisible(h)))
    return True


u32.EnumWindows(cb, 0)
for h, pid, w, hh, x, y, ex, vis in rows:
    print("hwnd=%d pid=%d %dx%d at %d,%d vis=%d ex=0x%08X" % (h, pid, w, hh, x, y, vis, ex))
