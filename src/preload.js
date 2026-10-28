// preload.js — 最小暴露面，contextIsolation 开启。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("petAPI", {
  rendererReady: (payload) => ipcRenderer.send("renderer-ready", payload),
  rendererError: (payload) => ipcRenderer.send("renderer-error", payload),
  moveBy: (dx, dy) => ipcRenderer.send("window:moveBy", dx, dy),
  getMoveBounds: () => ipcRenderer.invoke("window:getMoveBounds"),
  // 物理/飞行/攀爬：拿窗口位置与所在显示器工作区
  getEnv: () => ipcRenderer.invoke("env:get"),
  setSize: (pt) => ipcRenderer.send("window:setSize", pt),
  // 气泡画在独立的透明窗口里（那个窗口永久穿透，宠物窗口只包住角色本体）
  bubble: (text, ms) => ipcRenderer.send("pet:bubble", { text, ms }),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  onClickThroughChanged: (cb) => ipcRenderer.on("click-through-changed", (_e, v) => cb(v)),
  getOnboarded: () => ipcRenderer.invoke("app:onboarded"),
  markOnboarded: () => ipcRenderer.send("app:onboarded"),
  onQuietChanged: (cb) => ipcRenderer.on("quiet-changed", (_e, v) => cb(v)),
  onLowFlashChanged: (cb) => ipcRenderer.on("lowflash-changed", (_e, v) => cb(v)),
  contextMenu: (x, y) => ipcRenderer.send("pet:contextmenu", x, y),
  onPetSleep: (cb) => ipcRenderer.on("pet:sleep", () => cb()),
  // 对话联动
  openChat: () => ipcRenderer.invoke("chat:open"),
  onSay: (cb) => ipcRenderer.on("pet:say", (_e, payload) => cb(payload)),
  // 托盘/右键菜单手动触发动作
  onAction: (cb) => ipcRenderer.on("pet:action", (_e, name) => cb(name)),
  // 主进程发现主人好久没理她 → 提示一句"该去旁边偷看了"
  onPeekHint: (cb) => ipcRenderer.on("pet:peek-hint", () => cb()),
  // 全屏避让（旧）：主进程探测到独占全屏窗口时发来 { on, x, y }，渲染器平移到边角
  onRetreat: (cb) => ipcRenderer.on("pet:retreat", (_e, payload) => cb(payload)),
  // 页面避让（新）：前台是别的窗口时主进程发 { on }，渲染器滑到屏幕边藏着；点她时回传
  onPageHide: (cb) => ipcRenderer.on("pet:pagehide", (_e, payload) => cb(payload)),
  pageClick: () => ipcRenderer.send("pet:pageclick"),
  capture: () => ipcRenderer.invoke("app:capture")
});
