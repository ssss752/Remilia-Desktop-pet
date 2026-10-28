$wd  = "E:\WorkBuddy-Output\2026-10-27-12-00-52\remilia-pet"
$exe = "$wd\node_modules\electron\dist\electron.exe"
$out = "$wd\_tmp\launch-report.txt"
Remove-Item $out -Force -ErrorAction SilentlyContinue

function W($s) { $s | Out-File -FilePath $out -Append -Encoding ascii }

$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
  -Arguments @{ CommandLine = "`"$exe`" ."; CurrentDirectory = $wd }
W ("create rc=" + $res.ReturnValue + " pid=" + $res.ProcessId)

Start-Sleep -Seconds 15

$pids = @()
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -like '*remilia-pet*' } |
  ForEach-Object { $pids += [int]$_.ProcessId }
W ("pids=" + ($pids -join ','))

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WinUtil {
  delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  public static string[] List(int[] pids) {
    var res = new List<string>();
    var set = new HashSet<int>(pids);
    EnumWindows((h,l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (set.Contains((int)pid)) {
        RECT r; GetWindowRect(h, out r);
        StringBuilder sb = new StringBuilder(256); GetWindowText(h, sb, 256);
        int ex = GetWindowLong(h, -20);
        res.Add("pid=" + pid + " hwnd=" + h.ToInt32() + " vis=" + IsWindowVisible(h) +
                " pos=(" + r.L + "," + r.T + ") size=" + (r.R-r.L) + "x" + (r.B-r.T) +
                " exstyle=0x" + ex.ToString("X") + " title=[" + sb.ToString() + "]");
      }
      return true;
    }, IntPtr.Zero);
    return res.ToArray();
  }
  public static string ScreenInfo() {
    int w = GetSystemMetrics(0), h = GetSystemMetrics(1);
    return "screen=" + w + "x" + h;
  }
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
}
'@ -ErrorAction SilentlyContinue

W ("screen: " + [WinUtil]::ScreenInfo())
if ($pids.Count -gt 0) {
  $lines = [WinUtil]::List($pids)
  W ("windows=" + $lines.Count)
  foreach ($l in $lines) { W $l }
} else { W "windows=0 (no process)" }

$gate = "C:\Users\susan0721\AppData\Roaming\蕾米莉亚桌宠\.gate.log"
if (Test-Path $gate) { W "--- gate log ---"; Get-Content $gate | ForEach-Object { W $_ } } else { W "no gate log" }
W "--- done ---"
