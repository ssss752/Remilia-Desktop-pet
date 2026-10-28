# peekcheck.py - 验收「屏幕边缘偷看」：等她藏到屏幕外，点她被裁剩的那半边，
# 再看她是否立刻缩回屏幕内并冒一句嘴硬的话。
# 用法: python peekcheck.py [超时秒数]
import ctypes, sys, time
from ctypes import wintypes

try:
    ctypes.WinDLL("shcore").SetProcessDpiAwareness(2)
except Exception:
    try:
        ctypes.WinDLL("user32").SetProcessDPIAware()
    except Exception:
        pass

u32 = ctypes.WinDLL("user32", use_last_error=True)
MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP = 0x0002, 0x0004
VX = u32.GetSystemMetrics(76); VY = u32.GetSystemMetrics(77)
VW = max(1, u32.GetSystemMetrics(78)); VH = max(1, u32.GetSystemMetrics(79))
MOVE_ABS = 0x0001 | 0x8000 | 0x4000
SCREEN_W = u32.GetSystemMetrics(0)


def find_pet(title="蕾米莉亚桌宠", expect_w=0):
    """同名窗口有三类：宠物本体(正方形)、气泡(扁宽)、右键菜单(窄高)。
    GetWindowRect 即使窗口有一半在屏幕外也返回完整矩形，所以按宽高比挑仍然可靠。

    expect_w：按窗口宽度过滤。机器上可能同时跑着旧版本实例（尺寸不同），
    只按宽高比挑会挑到那个不动的，测半天等不到它偷看。"""
    hits = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(h, l):
        buf = ctypes.create_unicode_buffer(512)
        u32.GetWindowTextW(h, buf, 512)
        if buf.value == title:
            r = wintypes.RECT()
            u32.GetWindowRect(h, ctypes.byref(r))
            w, hh = r.right - r.left, r.bottom - r.top
            if w > 0 and hh > 0 and (not expect_w or w == expect_w):
                hits.append((abs(w / hh - 1.0), h))
        return True
    u32.EnumWindows(cb, 0)
    hits.sort()
    return hits[0][1] if hits else 0


def rect(h):
    r = wintypes.RECT()
    u32.GetWindowRect(h, ctypes.byref(r))
    return r


def move(x, y, steps=6):
    p = wintypes.POINT()
    u32.GetCursorPos(ctypes.byref(p))
    for i in range(1, steps + 1):
        nx = p.x + (x - p.x) * i / steps
        ny = p.y + (y - p.y) * i / steps
        ax = int(round((nx - VX) * 65535 / (VW - 1)))
        ay = int(round((ny - VY) * 65535 / (VH - 1)))
        u32.mouse_event(MOVE_ABS, ax, ay, 0, 0)
        time.sleep(0.015)


def hit_window(x, y):
    """诊断：这个屏幕坐标到底落在哪个窗口上。透明置顶窗如果被别的窗口压住、
    或者根本不可命中，鼠标事件就到不了渲染进程 —— 那就不是她的问题。"""
    class POINT(ctypes.Structure):
        _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]
    h = u32.WindowFromPoint(POINT(x, y))
    if not h:
        return "0", ""
    buf = ctypes.create_unicode_buffer(256)
    u32.GetWindowTextW(h, buf, 256)
    cls = ctypes.create_unicode_buffer(256)
    u32.GetClassNameW(h, cls, 256)
    return cls.value, buf.value


def click_at(x, y):
    cls, title = hit_window(x, y)
    print("   hit-test at %d,%d -> class=%s title=%r" % (x, y, cls, title))
    move(x, y)
    time.sleep(0.06)
    u32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    time.sleep(0.05)
    u32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)


def offscreen(r):
    return r.left < 0 or r.right > SCREEN_W


def report(tag, r):
    hidden = 0
    w = r.right - r.left
    if r.left < 0:
        hidden = min(w, -r.left)
    elif r.right > SCREEN_W:
        hidden = min(w, r.right - SCREEN_W)
    print("%-16s rect=(%d,%d,%d,%d) %dx%d  offscreen=%dpx (%.0f%%)" %
          (tag, r.left, r.top, r.right, r.bottom, w, r.bottom - r.top,
           hidden, 100.0 * hidden / max(1, w)))
    return hidden


def shot(path, r):
    try:
        from PIL import ImageGrab
        # 框宽一点：气泡在左/右都可能（贴边时会自动翻到里侧），340px 够包住整条气泡
        x1 = max(0, r.left - 340)
        x2 = min(SCREEN_W, r.right + 340)
        img = ImageGrab.grab(bbox=(x1, r.top - 14, x2, r.bottom + 14), all_screens=True)
        img = img.resize((img.width * 2, img.height * 2))
        img.save(path)
        print("   shot ->", path)
    except Exception as e:
        print("   shot failed:", e)


def main():
    budget = float(sys.argv[1]) if len(sys.argv) > 1 else 40.0
    expect_w = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    h = find_pet(expect_w=expect_w)
    if not h:
        print("FAIL: 宠物窗口没找到（app 没起来？）")
        return 1
    print("hwnd =", h, " screen width =", SCREEN_W)

    t0 = time.time()
    hidden_r = None
    hidden = 0
    while time.time() - t0 < budget:
        r = rect(h)
        w = r.right - r.left
        if w > 0:
            # 不能一越界就算成功：她可能刚跨过边界、还在往深处挪。
            # 等到"藏掉三成以上"才算真的藏好了。
            now_hidden = min(w, -r.left) if r.left < 0 else (min(w, r.right - SCREEN_W) if r.right > SCREEN_W else 0)
            if now_hidden >= w * 0.3:
                hidden_r, hidden = r, now_hidden
                break
        time.sleep(0.12)

    if not hidden_r:
        print("FAIL: %.0f 秒内没等到她真正藏好（>30%% 出界）" % budget)
        report("now", rect(h))
        return 1

    hidden = report("hidden", hidden_r)
    if hidden < 8:
        print("FAIL: 只藏了 %d px，太浅，看不出偷看" % hidden)
        return 1
    shot("E:/WorkBuddy-Output/2026-10-27-12-00-52/remilia-pet/_tmp/peek-before-click.png", hidden_r)

    # 点她被裁剩的那半边（可见区域的中心）
    time.sleep(0.5)
    r = rect(h)
    vis_left = max(0, r.left)
    vis_right = min(SCREEN_W, r.right)
    cx = (vis_left + vis_right) // 2
    cy = (r.top + r.bottom) // 2
    print("click at %d,%d (visible span %d..%d)" % (cx, cy, vis_left, vis_right))
    click_at(cx, cy)
    t_click = time.time()
    time.sleep(0.45)
    shot("E:/WorkBuddy-Output/2026-10-27-12-00-52/remilia-pet/_tmp/peek-after-click.png", r)

    # 等她缩回屏幕内。注意：她站在最右合法位置时，窗口那 4~5px 的**透明边框**本来
    # 就会压在屏幕外一点（角色视觉宽度按高度算 60，窗口 rect 是 64），所以不能要求
    # 严格 100% 在屏幕内 —— 出界比例回到 12% 以内就算缩回来了。
    back_at = None
    while time.time() - t_click < 8:
        r = rect(h)
        w = r.right - r.left
        hid = (min(w, -r.left) if r.left < 0 else (min(w, r.right - SCREEN_W) if r.right > SCREEN_W else 0))
        if hid <= w * 0.12:
            back_at = time.time() - t_click
            break
        time.sleep(0.08)

    if back_at is None:
        print("FAIL: 点她之后 8 秒还没缩回屏幕内")
        report("now", rect(h))
        return 1

    report("back", r)
    print("OK: 点破后 %.2f 秒缩回屏幕内" % back_at)
    shot("E:/WorkBuddy-Output/2026-10-27-12-00-52/remilia-pet/_tmp/peek-back.png", r)
    return 0


if __name__ == "__main__":
    sys.exit(main())
