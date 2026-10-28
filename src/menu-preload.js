// menu-preload.js — 自绘右键菜单的桥（只暴露"选一项"和"关掉"）
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("menuAPI", {
  pick: (act) => ipcRenderer.send("menu:action", String(act)),
  close: () => ipcRenderer.send("menu:close")
});
