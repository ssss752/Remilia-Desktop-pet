# mousetest.py - drive real mouse input at the pet window and report what happens.
# usage: python mousetest.py [hover|click|rclick|drag]
import ctypes, sys, time
from ctypes import wintypes

# 必须切成 per-monitor DPI aware：否则本进程拿到的是被系统虚拟化的坐标，
# GetWindowRect / mouse_event 与 Electron 的 DIP 空间对不上，测出来的全错。
try:
    ctypes.WinDLL("shcore").SetProcessDpiAwareness(2)
except Exception:
    try:
        ctypes.WinDLL("user32").SetProcessDPIAware()
    except Exception:
        pass

u32 = ctypes.WinDLL("user32", use_last_error=True)

MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP = 0x0002, 0x0004
MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP = 0x0008, 0x0010

def find(title="蕾米莉亚桌宠"):
    hwnd = u32.FindWindowW(None, title)
    return hwnd


def find_pet(title="蕾米莉亚桌宠"):
    """宠物主窗口：同名的还有气泡窗口(扁宽)和右键菜单(窄高)。
    宠物窗口现在就是角色本体的正方形，按"宽高比最接近 1"挑最稳。"""
    hits = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(h, l):
        buf = ctypes.create_unicode_buffer(512)
        u32.GetWindowTextW(h, buf, 512)
        if buf.value == title:
            r = wintypes.RECT()
            u32.GetWindowRect(h, ctypes.byref(r))
            w, hh = r.right - r.left, r.bottom - r.top
            if w > 0 and hh > 0:
                hits.append((abs(w / hh - 1.0), h))
        return True
    u32.EnumWindows(cb, 0)
    hits.sort()
    return hits[0][1] if hits else find(title)


def click_at(x, y):
    move(x, y, steps=4)
    time.sleep(0.08)
    down(); time.sleep(0.05); up()

def rect(h):
    r = wintypes.RECT()
    u32.GetWindowRect(h, ctypes.byref(r))
    return r

def exstyle(h):
    return u32.GetWindowLongW(h, -20) & 0xFFFFFFFF

def flags(ex):
    names = [(0x8, "TOPMOST"), (0x80, "TOOLWINDOW"), (0x20, "TRANSPARENT"),
             (0x80000, "LAYERED"), (0x8000000, "NOACTIVATE"), (0x40000, "APPWINDOW")]
    return ",".join(n for b, n in names if ex & b)

def report(h, tag):
    r = rect(h)
    ex = exstyle(h)
    print("%-22s rect=(%d,%d,%d,%d) %dx%d ex=0x%08X [%s]" %
          (tag, r.left, r.top, r.right, r.bottom, r.right - r.left, r.bottom - r.top, ex, flags(ex)))

VX = u32.GetSystemMetrics(76)
VY = u32.GetSystemMetrics(77)
VW = max(1, u32.GetSystemMetrics(78))
VH = max(1, u32.GetSystemMetrics(79))
MOVE_ABS = 0x0001 | 0x8000 | 0x4000   # MOVE | ABSOLUTE | VIRTUALDESK


def move(x, y, steps=None):
    """Real input movement: SetCursorPos alone does not generate WM_MOUSEMOVE,
    so we drive mouse_event ABSOLUTE (that is what the window actually sees)."""
    p = wintypes.POINT()
    u32.GetCursorPos(ctypes.byref(p))
    steps = steps or 1
    for i in range(1, steps + 1):
        nx = p.x + (x - p.x) * i / steps
        ny = p.y + (y - p.y) * i / steps
        ax = int(round((nx - VX) * 65535 / (VW - 1)))
        ay = int(round((ny - VY) * 65535 / (VH - 1)))
        u32.mouse_event(MOVE_ABS, ax, ay, 0, 0)
        time.sleep(0.015)

def down(btn="left"):
    u32.mouse_event(MOUSEEVENTF_LEFTDOWN if btn == "left" else MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, 0)

def up(btn="left"):
    u32.mouse_event(MOUSEEVENTF_LEFTUP if btn == "left" else MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0)

@ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
def enum_cb(h, l):
    cls = ctypes.create_unicode_buffer(256)
    u32.GetClassNameW(h, cls, 256)
    if cls.value == "#32768":
        menus.append(h)
    return True

menus = []

def has_menu():
    menus.clear()
    u32.EnumWindows(enum_cb, 0)
    return menus[:]

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "hover"
    print("== mode: %s ==" % mode)
    if mode == "drag":
        click_at(300, 300)      # 先把可能还开着的右键菜单点掉
        time.sleep(0.7)
    h = find_pet()
    if not h:
        print("window not found")
        sys.exit(1)
    r = rect(h)
    # 角色在窗口左侧的正方形区域里：取左边正方形中心
    h_pet = r.bottom - r.top
    cx = r.left + h_pet // 2
    cy = (r.top + r.bottom) // 2
    report(h, "start")
    move(cx, cy, steps=8)
    time.sleep(0.35)
    report(h, "after hover(over pet)")
    if mode == "click":
        down(); time.sleep(0.06); up()
        time.sleep(0.5)
        report(h, "after left click")
    elif mode == "rclick":
        down("right"); time.sleep(0.06); up("right")
        time.sleep(0.6)
        found = has_menu()
        print("menu windows:", found)
        for m in found:
            mr = rect(m)
            print("  menu rect=(%d,%d,%d,%d) visible=%d" % (mr.left, mr.top, mr.right, mr.bottom, u32.IsWindowVisible(m)))
    elif mode == "drag":
        down(); time.sleep(0.1)
        bx, by = cx, cy
        for i in range(1, 11):
            move(bx - 12 * i, by - 6 * i)
            time.sleep(0.03)
        up()
        time.sleep(0.4)
        report(h, "after drag(-120,-60)")
    # move cursor far away to release hover state
    move(200, 400, steps=6)
    time.sleep(0.3)
    report(h, "cursor away")
