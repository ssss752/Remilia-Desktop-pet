"""列出 electron 进程窗口的扩展样式，判断是否 WS_EX_TOPMOST (0x8)。纯 ctypes，零依赖。"""
import ctypes
import ctypes.wintypes as wt
import subprocess
import sys

user32 = ctypes.windll.user32
EnumWindows = user32.EnumWindows
EnumWindowsProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
GetWindowThreadProcessId = user32.GetWindowThreadProcessId
GetWindowLongW = user32.GetWindowLongW
GetWindowRect = user32.GetWindowRect
IsWindowVisible = user32.IsWindowVisible

# 目标 electron 进程 pid
out = subprocess.run(
    ["tasklist", "/FI", "IMAGENAME eq electron.exe", "/FO", "CSV", "/NH"],
    capture_output=True, text=True, encoding="gbk", errors="replace"
).stdout
pids = set()
for line in out.splitlines():
    parts = [p.strip('"') for p in line.split('","')]
    if len(parts) >= 2 and parts[1].isdigit():
        pids.add(int(parts[1]))

print("electron pids:", sorted(pids))

rows = []


def cb(hwnd, lparam):
    pid = wt.DWORD()
    GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if pid.value in pids:
        rect = wt.RECT()
        GetWindowRect(hwnd, ctypes.byref(rect))
        ex = GetWindowLongW(hwnd, -20)
        rows.append({
            "pid": pid.value,
            "hwnd": hwnd,
            "vis": bool(IsWindowVisible(hwnd)),
            "w": rect.right - rect.left,
            "h": rect.bottom - rect.top,
            "x": rect.left,
            "y": rect.top,
            "ex": ex,
            "topmost": bool(ex & 0x8),
            "transparent": bool(ex & 0x20),
            "layered": bool(ex & 0x80000),
            "noactivate": bool(ex & 0x8000000),
            "toolwindow": bool(ex & 0x80),
        })
    return True


EnumWindows(EnumWindowsProc(cb), 0)

for r in rows:
    print(f"pid={r['pid']} hwnd={r['hwnd']} vis={r['vis']} size={r['w']}x{r['h']} "
          f"pos=({r['x']},{r['y']}) exstyle=0x{r['ex']:X} topmost={r['topmost']} "
          f"layered={r['layered']} transparent={r['transparent']} "
          f"noactivate={r['noactivate']} toolwindow={r['toolwindow']}")

if not rows:
    print("no visible electron windows found")
