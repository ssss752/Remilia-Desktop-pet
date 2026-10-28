// bubble-preload.js — 气泡窗口的桥（只收"说什么"和"尖角朝哪边"）
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bubbleAPI", {
  onShow: (cb) => ipcRenderer.on("bubble:show", (_e, payload) => cb(payload || {})),
  onSide: (cb) => ipcRenderer.on("bubble:side", (_e, side) => cb(side))
});
