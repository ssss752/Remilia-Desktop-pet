# winprobe.py - inspect the pet window: rect, exstyle, class; optionally simulate mouse.
# usage: python winprobe.py [info|click|rclick|drag]
import ctypes, sys, time
from ctypes import wintypes

# per-monitor DPI aware：拿到真实物理像素坐标，跟 DIP 空间换算才对得上
try:
    ctypes.WinDLL("shcore").SetProcessDpiAwareness(2)
except Exception:
    try:
        ctypes.WinDLL("user32").SetProcessDPIAware()
    except Exception:
        pass

u32 = ctypes.WinDLL("user32", use_last_error=True)

def find(title="蕾米莉亚桌宠"):
    hwnd = u32.FindWindowW(None, title)
    if not hwnd:
        # fallback: enumerate top-level windows looking for our title
        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def cb(h, l):
            buf = ctypes.create_unicode_buffer(512)
            u32.GetWindowTextW(h, buf, 512)
            if buf.value == title:
                hits.append(h)
            return True
        hits = []
        u32.EnumWindows(cb, 0)
        hwnd = hits[0] if hits else 0
    return hwnd

def info():
    h = find()
    print("hwnd=", h)
    if not h:
        return
    r = wintypes.RECT()
    u32.GetWindowRect(h, ctypes.byref(r))
    ex = u32.GetWindowLongW(h, -20) & 0xFFFFFFFF
    cls = ctypes.create_unicode_buffer(256)
    u32.GetClassNameW(h, cls, 256)
    print("rect=%d,%d,%d,%d  (%dx%d)" % (r.left, r.top, r.right, r.bottom, r.right - r.left, r.bottom - r.top))
    print("exstyle=0x%08X  class=%s" % (ex, cls.value))
    flags = [(0x8, "TOPMOST"), (0x80, "TOOLWINDOW"), (0x20, "TRANSPARENT"),
             (0x80000, "LAYERED"), (0x8000000, "NOACTIVATE"), (0x40000, "APPWINDOW")]
    print("flags=" + ",".join(n for b, n in flags if ex & b))
    return r

def cursor():
    p = wintypes.POINT()
    u32.GetCursorPos(ctypes.byref(p))
    print("cursor=%d,%d" % (p.x, p.y))

if __name__ == "__main__":
    info()
    cursor()
