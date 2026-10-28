# listwin.py - list every top-level window whose title matches the pet
import ctypes
from ctypes import wintypes

# 必须 per-monitor DPI aware：不做的话 GetWindowRect 拿到的是被系统虚拟化过的坐标
# （150% 缩放下只有真实值的 2/3），跟 peekcheck/winprobe 读数对不上，会得出
# "窗口自己跑了"的假结论。
try:
    ctypes.WinDLL("shcore").SetProcessDpiAwareness(2)
except Exception:
    try:
        ctypes.WinDLL("user32").SetProcessDPIAware()
    except Exception:
        pass

u32 = ctypes.WinDLL("user32", use_last_error=True)
hits = []


@ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
def cb(h, l):
    buf = ctypes.create_unicode_buffer(512)
    u32.GetWindowTextW(h, buf, 512)
    if "蕾米莉亚" in buf.value:
        r = wintypes.RECT()
        u32.GetWindowRect(h, ctypes.byref(r))
        pid = wintypes.DWORD()
        u32.GetWindowThreadProcessId(h, ctypes.byref(pid))
        ex = u32.GetWindowLongW(h, -20) & 0xFFFFFFFF
        cls = ctypes.create_unicode_buffer(256)
        u32.GetClassNameW(h, cls, 256)
        hits.append((h, buf.value, r, ex, pid.value, u32.IsWindowVisible(h), cls.value))
    return True


u32.EnumWindows(cb, 0)
for h, title, r, ex, pid, vis, cls in hits:
    print("hwnd=%d pid=%d vis=%d title=%r class=%s" % (h, pid, vis, title, cls))
    print("   rect=(%d,%d,%d,%d) %dx%d ex=0x%08X" % (r.left, r.top, r.right, r.bottom,
                                                    r.right - r.left, r.bottom - r.top, ex))
