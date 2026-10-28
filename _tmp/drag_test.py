"""实测拖拽：把鼠标移到角色身上按住左键横移，看窗口是否跟着走。纯 ctypes。"""
import ctypes
import ctypes.wintypes as wt
import time

user32 = ctypes.windll.user32

# 找宠物窗口（可见、尺寸接近宠物窗口的那个）
EnumWindows = user32.EnumWindows
Proc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
GetWindowThreadProcessId = user32.GetWindowThreadProcessId
GetWindowRect = user32.GetWindowRect
IsWindowVisible = user32.IsWindowVisible
GetWindowLongW = user32.GetWindowLongW

cands = []


def cb(hwnd, lparam):
    if IsWindowVisible(hwnd):
        r = wt.RECT()
        GetWindowRect(hwnd, ctypes.byref(r))
        w, h = r.right - r.left, r.bottom - r.top
        ex = GetWindowLongW(hwnd, -20)
        # 宠物窗口：约 336x192，带 NOACTIVATE
        if 300 < w < 420 and 150 < h < 240 and (ex & 0x08000000):
            cands.append((hwnd, r.left, r.top, w, h))
    return True


EnumWindows(Proc(cb), 0)
if not cands:
    print("FAIL: pet window not found")
    raise SystemExit(1)

hwnd, x0, y0, w, h = cands[0]
print(f"pet window hwnd={hwnd} pos=({x0},{y0}) size={w}x{h}")

# 角色按 contain 居中：宽 = 高（正方形精灵），所以角色横向占中间 h 像素
pet_w = h
left_pad = (w - pet_w) // 2
cx = x0 + left_pad + pet_w // 2
cy = y0 + int(h * 0.62)          # 偏下一点，落在躯干上，避开头顶空白
print(f"grab point=({cx},{cy})")

# 记下原鼠标位置，结束后恢复
pt = wt.POINT()
user32.GetCursorPos(ctypes.byref(pt))
orig = (pt.x, pt.y)

user32.SetCursorPos(cx, cy)
time.sleep(0.25)                  # 等渲染进程的 mousemove 把穿透切回来

user32.mouse_event(0x0002, 0, 0, 0, 0)   # LEFTDOWN
time.sleep(0.12)
for i in range(1, 13):                    # 分 12 步右移 90px
    user32.SetCursorPos(cx + i * 7, cy)
    time.sleep(0.02)
user32.mouse_event(0x0004, 0, 0, 0, 0)   # LEFTUP
time.sleep(0.4)

r2 = wt.RECT()
GetWindowRect(hwnd, ctypes.byref(r2))
print(f"after drag pos=({r2.left},{r2.top}) dx={r2.left - x0} dy={r2.top - y0}")

user32.SetCursorPos(orig[0], orig[1])     # 还原鼠标
print("PASS: window moved" if abs(r2.left - x0) > 20 else "FAIL: window did not move")
