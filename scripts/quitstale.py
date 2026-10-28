#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""quitstale.py -- 优雅地让"上一个验证实例"自己退出。

为什么需要它：验证批次里残留的 electron 进程有时被权限保护（taskkill 报
"拒绝访问"），但它自己是正常的 GUI 程序 —— 用它的右键菜单点「退出」，
走 app.quit() 就是干净退出，也不会有半截状态写盘。

流程：右键宠物窗口 -> 等菜单窗口出现 -> 点菜单最末项（退出）-> 核对进程消失。

Usage:
  python scripts/quitstale.py <target_pid>
"""
import ctypes
import sys
import time
from ctypes import wintypes

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    pass

u32 = ctypes.WinDLL("user32", use_last_error=True)
user32 = u32

ULTRA_MOVE = 0x0001
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG),
                ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.POINTER(wintypes.ULONG))]


class INPUT(ctypes.Structure):
    class _U(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT)]
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _U)]


def move(x, y):
    user32.SetCursorPos(int(x), int(y))
    time.sleep(0.03)


def click(flag_down, flag_up):
    for f in (flag_down, flag_up):
        inp = INPUT(type=0)
        inp.mi = MOUSEINPUT(0, 0, 0, f, 0, None)
        user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))
        time.sleep(0.04)


def windows_of(pid):
    EP = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    out = []

    def cb(h, _l):
        p = wintypes.DWORD()
        user32.GetWindowThreadProcessId(h, ctypes.byref(p))
        if p.value != pid:
            return True
        if not user32.IsWindowVisible(h):
            return True
        r = wintypes.RECT()
        user32.GetWindowRect(h, ctypes.byref(r))
        n = user32.GetWindowTextLengthW(h)
        title = ""
        if n:
            b = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(h, b, n + 1)
            title = b.value
        out.append({"hwnd": h, "title": title,
                    "rect": (r.left, r.top, r.right - r.left, r.bottom - r.top)})
        return True

    user32.EnumWindows(EP(cb), 0)
    return out


def top_windows():
    """所有可见的顶层窗口，用来 diff 出刚弹出的菜单窗口。"""
    EP = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    out = []

    def cb(h, _l):
        if not user32.IsWindowVisible(h):
            return True
        r = wintypes.RECT()
        user32.GetWindowRect(h, ctypes.byref(r))
        if r.right - r.left < 20 or r.bottom - r.top < 20:
            return True
        n = user32.GetWindowTextLengthW(h)
        title = ""
        if n:
            b = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(h, b, n + 1)
            title = b.value
        out.append((h, title, (r.left, r.top, r.right - r.left, r.bottom - r.top)))
        return True

    user32.EnumWindows(EP(cb), 0)
    return out


def main():
    if len(sys.argv) < 2:
        print("usage: quitstale.py <pid>")
        return 2
    pid = int(sys.argv[1])

    wins = windows_of(pid)
    if not wins:
        print(f"pid {pid} 没有可见窗口，可能已经退出")
        return 0
    # 宠物本体是正方形那个（气泡是扁的）
    pet = min(wins, key=lambda w: abs(w["rect"][2] - w["rect"][3]))
    x, y, w, h = pet["rect"]
    cx, cy = x + w // 2, y + h // 2
    print(f"pet window {pet['rect']} 右键点 ({cx},{cy})")

    before = {t[0] for t in top_windows()}
    # 它是置顶窗，但 WorkBuddy 自己的窗口也是置顶且后创建 —— 会被压在下面，
    # 这时右键落在 WorkBuddy 上，桌宠根本收不到。先把它顶到最上层再点。
    HWND_TOPMOST = -1
    SWP_NOSIZE = 0x0001
    SWP_NOMOVE = 0x0002
    SWP_SHOWWINDOW = 0x0040
    user32.SetWindowPos(pet["hwnd"], HWND_TOPMOST, 0, 0, 0, 0,
                        SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW)
    user32.BringWindowToTop(pet["hwnd"])
    time.sleep(0.35)

    hit = user32.WindowFromPoint(wintypes.POINT(cx, cy))
    if hit != pet["hwnd"]:
        p = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hit, ctypes.byref(p))
        print(f"WARN: ({cx},{cy}) 实际落在 hwnd={hit} pid={p.value}，不是目标窗口")

    move(cx, cy)
    click(MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)
    time.sleep(0.7)

    menus = [t for t in top_windows() if t[0] not in before]
    if not menus:
        print("FAIL: 右键后没有出现新窗口（菜单没弹出来）")
        return 1
    # 菜单窗口：靠近宠物、窄而高
    menus.sort(key=lambda t: abs(t[2][0] - cx) + abs(t[2][1] - cy))
    mh, mtitle, mrect = menus[0]
    mx, my, mw, mhh = mrect
    print(f"menu window {mrect} title={mtitle!r}")

    # 点最末一项（退出）
    tx, ty = mx + mw // 2, my + mhh - 16
    print(f"点退出项 ({tx},{ty})")
    move(tx, ty)
    time.sleep(0.15)
    click(MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
    time.sleep(1.2)

    left = windows_of(pid)
    if not left:
        print(f"OK: pid {pid} 已退出")
        return 0
    print(f"FAIL: pid {pid} 还有 {len(left)} 个可见窗口")
    for w_ in left:
        print("   ", w_)
    return 1


if __name__ == "__main__":
    sys.exit(main())
