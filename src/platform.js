// platform.js — 双平台差异适配层。主进程其他代码禁止出现 process.platform 判断。
const { app } = require("electron");
const path = require("path");
const fs = require("fs");

const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";

function alwaysOnTopLevel() {
  // macOS: screen-saver 级盖过全屏应用；Windows 仅支持 normal/floating，用 floating
  return IS_MAC ? "screen-saver" : "floating";
}

function supportsAllWorkspaces() {
  // 全空间可见是 macOS 专有能力；Windows 上调用无效果，且可能触发窗口样式重设
  // → 透明窗重新合成 → 闪烁。按平台收敛在这里。
  return IS_MAC;
}

function windowTypeOptions() {
  // Windows 上用 type=toolbar 创建，窗口会带 WS_EX_TOOLWINDOW：
  // 不进任务栏、不进 Alt+Tab。只靠 skipTaskbar 在部分场景拿不到这个扩展样式，
  // 而一个「不可激活却挂在任务栏上」的窗口会让任务栏反复刷新它的按钮
  // —— 表现就是状态栏一直在闪。
  return IS_WIN ? { type: "toolbar" } : {};
}

function trayIconPath() {
  const name = IS_MAC ? "trayTemplate.png" : "tray.png";
  const p = path.join(__dirname, "..", "assets", "tray", name);
  return fs.existsSync(p) ? p : undefined; // Electron 无图标时用默认
}

function windowSize(display, basePt) {
  // 别在这里乘 scaleFactor。
  // Electron 的 BrowserWindow 宽高本来就是 DIP（设备无关像素），系统会按显示
  // 缩放自动放大。以前这里又乘了一次 scaleFactor，等于**双重放大**：48pt 的角色
  // 在 150% 缩放下实际画成了 108 个物理像素，比任务栏图标还大一倍多。
  // 保持 DIP 原值，跨 DPI 的视觉大小交给系统处理。
  return Math.round(basePt);
}

function screenshotSupported() {
  // 双平台统一走主进程的 app:capture（win.capturePage），无需外部命令
  return true;
}

function screenshotCommand(outPath) {
  // 保留接口占位；实际取证由 app:capture IPC 完成（跨平台一致）
  return null;
}

// 开机自启。
// Windows 上必须显式给 path + args：开发态 process.execPath 是 electron.exe，
// 只写 openAtLogin 会注册成"开机拉起一个空的 Electron"，用户会看到开机闪一下就没
// 任何东西。打包后 exe 自己就是入口，args 为空即可。
function loginItemOptions(enabled) {
  const opts = { openAtLogin: !!enabled };
  if (IS_WIN) {
    opts.path = process.execPath;
    opts.args = app.isPackaged ? [] : [app.getAppPath()];
  }
  return opts;
}

function setLoginItem(enabled) {
  try {
    app.setLoginItemSettings(loginItemOptions(enabled));
    return true;
  } catch (e) {
    console.log("[platform] setLoginItem failed:", e.message);
    return false;
  }
}

function getLoginItem() {
  try {
    return !!app.getLoginItemSettings(loginItemOptions(true)).openAtLogin;
  } catch {
    return false;
  }
}

module.exports = {
  IS_MAC,
  IS_WIN,
  alwaysOnTopLevel,
  supportsAllWorkspaces,
  windowTypeOptions,
  trayIconPath,
  windowSize,
  screenshotSupported,
  screenshotCommand,
  setLoginItem,
  getLoginItem
};
