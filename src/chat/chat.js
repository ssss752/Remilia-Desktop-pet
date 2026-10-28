// chat.js — 聊天窗口渲染进程：和蕾米莉亚说话 + AI 设置面板。
(() => {
  const msgsEl = document.getElementById("msgs");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("send");
  const typingEl = document.getElementById("typing");
  const badgeEl = document.getElementById("badge");
  const hintEl = document.getElementById("hint");
  const subEl = document.getElementById("sub");
  const panelEl = document.getElementById("panel");
  const fProvider = document.getElementById("fProvider");
  const fEndpoint = document.getElementById("fEndpoint");
  const fKey = document.getElementById("fKey");
  const fModel = document.getElementById("fModel");
  const fTemp = document.getElementById("fTemp");
  const keyTip = document.getElementById("keyTip");
  const testResult = document.getElementById("testResult");
  const saveBtn = document.getElementById("saveBtn");
  const testBtn = document.getElementById("testBtn");
  const closeBtn = document.getElementById("closeBtn");
  let sending = false;
  let haveKey = false;

  const DEFAULT_ENDPOINT = {
    agnes: "https://api.agnes-ai.cn/v1/chat/completions",
    "openai-compatible": ""
  };
  const DEFAULT_MODEL = { agnes: "agnes-2.5-flash" };

  function addMsg(role, text) {
    const row = document.createElement("div");
    row.className = "row " + (role === "user" ? "me" : "pet");
    const b = document.createElement("div");
    b.className = "bubble";
    b.textContent = text;
    row.appendChild(b);
    msgsEl.appendChild(row);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function providerLabel(cfg) {
    if (!cfg) return "本地引擎";
    if (cfg.provider === "local" || !cfg.apiKey) return "本地引擎";
    if (cfg.provider === "agnes") return "agnes · " + cfg.model;
    return cfg.provider + " · " + cfg.model;
  }

  async function refreshBadge() {
    try {
      const cfg = await window.chatAPI.aiConfig();
      haveKey = !!(cfg && cfg.apiKey);
      badgeEl.textContent = providerLabel(cfg);
      const remote = cfg && cfg.provider !== "local" && cfg.apiKey;
      hintEl.innerHTML = remote
        ? "已连接 " + (cfg.provider === "agnes" ? "agnes" : cfg.provider) +
          "（" + cfg.model + "），是真的在聊天。<a id=\"cfg\">改设置</a>"
        : "当前是本地人格引擎，能接话但不会真的推理。<a id=\"cfg\">打开 AI 设置</a> 选 agnes 并填入 API Key 即可升级。";
      const a = document.getElementById("cfg");
      if (a) a.onclick = openPanel;
    } catch { /* 取配置失败不影响聊天 */ }
  }

  // ---------- 设置面板 ----------
  async function openPanel() {
    try {
      const cfg = await window.chatAPI.aiConfig();
      fProvider.value = cfg.provider || "local";
      fEndpoint.value = cfg.endpoint || "";
      fModel.value = cfg.model || "";
      fTemp.value = cfg.temperature != null ? cfg.temperature : 0.9;
      fKey.value = "";
      haveKey = !!cfg.apiKey;
      keyTip.textContent = haveKey
        ? "已保存过 Key（" + cfg.apiKey + "）；留空则沿用原来的。"
        : "还没有 Key。填上后点「测试连接」验证。";
      testResult.className = "";
      testResult.textContent = "还没测试过。";
    } catch { /* 打不开面板就用当前默认值 */ }
    panelEl.classList.add("open");
    setTimeout(() => fKey.focus(), 60);
  }

  function closePanel() {
    panelEl.classList.remove("open");
    inputEl.focus();
  }

  function collect() {
    const patch = {
      provider: fProvider.value,
      endpoint: fEndpoint.value.trim(),
      model: fModel.value.trim(),
      temperature: Number(fTemp.value) || 0.9
    };
    const k = fKey.value.trim();
    if (k) patch.apiKey = k;            // 留空表示"不改动已保存的 Key"
    if (!patch.endpoint && DEFAULT_ENDPOINT[patch.provider]) {
      patch.endpoint = DEFAULT_ENDPOINT[patch.provider];
    }
    if (!patch.model && DEFAULT_MODEL[patch.provider]) {
      patch.model = DEFAULT_MODEL[patch.provider];
    }
    return patch;
  }

  function setResult(kind, text) {
    testResult.className = kind;
    testResult.textContent = text;
  }

  fProvider.addEventListener("change", () => {
    const p = fProvider.value;
    if (p === "local") {
      fEndpoint.value = "";
      fModel.value = "";
      return;
    }
    if (DEFAULT_ENDPOINT[p]) fEndpoint.value = DEFAULT_ENDPOINT[p];
    if (DEFAULT_MODEL[p]) fModel.value = DEFAULT_MODEL[p];
  });

  testBtn.addEventListener("click", async () => {
    const patch = collect();
    if (patch.provider === "local") {
      setResult("", "本地人格引擎不需要联网，直接就能聊。");
      return;
    }
    if (!patch.apiKey && !haveKey) {
      setResult("bad", "请先填 API Key。");
      fKey.focus();
      return;
    }
    testBtn.disabled = true;
    setResult("", "正在连接……（最长 20 秒）");
    try {
      const r = await window.chatAPI.testAiConfig(patch);
      if (r && r.ok) {
        setResult("ok", `连通成功（${r.ms} ms）\n模型：${r.model || patch.model}\n它回了一句：${r.sample || "（空）"}`);
      } else {
        setResult("bad", "失败：" + ((r && r.reason) || "未知原因"));
      }
    } catch (e) {
      setResult("bad", "失败：" + (e && e.message ? e.message : String(e)));
    }
    testBtn.disabled = false;
  });

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      await window.chatAPI.saveAiConfig(collect());
      await refreshBadge();
      setResult("ok", "已保存。下一句就用新设置了。");
      setTimeout(closePanel, 550);
    } catch (e) {
      setResult("bad", "保存失败：" + (e && e.message ? e.message : String(e)));
    }
    saveBtn.disabled = false;
  });

  closeBtn.addEventListener("click", closePanel);
  panelEl.addEventListener("keydown", (e) => { if (e.key === "Escape") closePanel(); });

  // ---------- 发消息 ----------
  async function send() {
    const text = inputEl.value.trim();
    if (!text || sending) return;
    sending = true;
    sendBtn.disabled = true;
    inputEl.value = "";
    addMsg("user", text);
    typingEl.style.display = "block";
    try {
      const reply = await window.chatAPI.send(text);
      typingEl.style.display = "none";
      addMsg("pet", reply && reply.text ? reply.text : "（她好像没听清……）");
      refreshBadge();
    } catch (e) {
      typingEl.style.display = "none";
      addMsg("pet", "唔……我这边好像断线了，再说一次好不好？");
    }
    sending = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }

  sendBtn.addEventListener("click", send);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  badgeEl.addEventListener("click", openPanel);

  // 载入历史
  window.chatAPI.history().then((list) => {
    (list || []).forEach((m) => addMsg(m.role === "user" ? "user" : "pet", m.text));
    if (!list || !list.length) {
      addMsg("pet", "你来啦～想聊什么都可以哦，我一直在的。");
    }
    msgsEl.scrollTop = msgsEl.scrollHeight;
  });
  refreshBadge();
  inputEl.focus();

  // 验收用：?panel=1 自动打开设置面板
  if (location.search.includes("panel=1")) setTimeout(openPanel, 300);
})();
