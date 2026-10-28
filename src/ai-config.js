// ai-config.js — AI 对话后端配置（存 userData/ai-config.json）。
// 默认本地人格引擎；选 agnes 并填入 API Key 即升级为真实大模型对话。
const fs = require("fs");
const path = require("path");

const DEFAULT = {
  provider: "local", // local | agnes | openai-compatible
  // agnes 的 OpenAI 兼容对话端点
  endpoint: "https://api.agnes-ai.cn/v1/chat/completions",
  apiKey: "",
  model: "agnes-2.5-flash",
  temperature: 0.9,
  maxTokens: 220,
  systemPrompt: ""
};

let cached = null;

function configPath(userData) {
  return path.join(userData, "ai-config.json");
}

// 旧版本默认后端是千问（DashScope）。用户磁盘上可能已经存着那份配置，
// 升级后如果不迁移，端点还指着 dashscope、模型名 qwen-plus，请求必然失败 →
// 静默回退本地引擎，用户只会觉得"AI 坏了"。这里读到旧配置就顺手换到 agnes。
function migrate(cfg) {
  const out = { ...cfg };
  const legacyProvider = out.provider === "qwen";
  const legacyEndpoint = /dashscope\.aliyuncs\.com/i.test(out.endpoint || "");
  const legacyModel = /^qwen/i.test(out.model || "");
  if (!legacyProvider && !legacyEndpoint && !legacyModel) return { cfg: out, changed: false };

  if (legacyProvider) out.provider = "agnes";
  if (!out.endpoint || legacyEndpoint) out.endpoint = DEFAULT.endpoint;
  if (!out.model || legacyModel) out.model = DEFAULT.model;
  return { cfg: out, changed: true };
}

function load(userData) {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(configPath(userData), "utf8");
    const migrated = migrate({ ...DEFAULT, ...JSON.parse(raw) });
    cached = migrated.cfg;
    if (migrated.changed) {
      try {
        fs.writeFileSync(configPath(userData), JSON.stringify(cached, null, 2), "utf8");
        console.log("[ai-config] migrated legacy qwen config -> agnes");
      } catch { /* 写不进去也不影响本次运行 */ }
    }
  } catch {
    cached = { ...DEFAULT };
    // 首次运行落一份配置文件，方便用户直接打开填写（openPath 只能打开已存在的文件）
    try {
      fs.mkdirSync(userData, { recursive: true });
      fs.writeFileSync(configPath(userData), JSON.stringify(cached, null, 2), "utf8");
    } catch { /* 写不了就用内存默认 */ }
  }
  return cached;
}

function save(userData, patch) {
  const next = { ...load(userData), ...patch };
  cached = next;
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(configPath(userData), JSON.stringify(next, null, 2), "utf8");
  return next;
}

function pathOf(userData) {
  return configPath(userData);
}

// 只有填了 key 且 provider 不是 local 才走远端
function useRemote(cfg) {
  return cfg && cfg.provider !== "local" && !!cfg.apiKey;
}

module.exports = { load, save, pathOf, useRemote, DEFAULT, migrate };
