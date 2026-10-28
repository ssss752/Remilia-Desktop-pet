// chat-preload.js — 聊天窗口的最小暴露面。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("chatAPI", {
  history: () => ipcRenderer.invoke("chat:history"),
  send: (text) => ipcRenderer.invoke("chat:send", text),
  clear: () => ipcRenderer.invoke("chat:clear"),
  onReply: (cb) => ipcRenderer.on("chat:reply", (_e, msg) => cb(msg)),
  aiConfig: () => ipcRenderer.invoke("ai:config:get"),
  saveAiConfig: (patch) => ipcRenderer.invoke("ai:config:set", patch),
  testAiConfig: (patch) => ipcRenderer.invoke("ai:config:test", patch),
  openAiConfig: () => ipcRenderer.invoke("ai:config:open")
});
