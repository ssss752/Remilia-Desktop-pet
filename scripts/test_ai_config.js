// test_ai_config.js -- 验收：旧千问配置能自动迁移到 agnes，新默认值正确。
const fs = require("fs");
const os = require("os");
const path = require("path");

const aiConfig = require("../src/ai-config.js");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail || ""}`); }
}

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aicfg-"));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log("[1] 全新安装：默认值应是 agnes");
withTmp((dir) => {
  const cfg = aiConfig.load(dir);           // 无文件 -> 写默认
  check("provider 默认 local", cfg.provider === "local", cfg.provider);
  check("endpoint 指向 agnes", cfg.endpoint === "https://api.agnes-ai.cn/v1/chat/completions", cfg.endpoint);
  check("model 是 agnes-2.5-flash", cfg.model === "agnes-2.5-flash", cfg.model);
  check("配置文件已落盘", fs.existsSync(path.join(dir, "ai-config.json")));
});

console.log("[2] migrate() 纯函数：旧 qwen 配置被改写");
const legacy = aiConfig.migrate({
  provider: "qwen",
  endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  model: "qwen-plus",
  apiKey: "sk-legacy",
  temperature: 0.7
});
check("provider qwen -> agnes", legacy.cfg.provider === "agnes", legacy.cfg.provider);
check("endpoint 换成 agnes", legacy.cfg.endpoint === "https://api.agnes-ai.cn/v1/chat/completions", legacy.cfg.endpoint);
check("model 换成 agnes-2.5-flash", legacy.cfg.model === "agnes-2.5-flash", legacy.cfg.model);
check("apiKey 原样保留", legacy.cfg.apiKey === "sk-legacy");
check("temperature 原样保留", legacy.cfg.temperature === 0.7);
check("标记为已迁移", legacy.changed === true);

console.log("[3] migrate() 不误伤自定义服务");
const custom = aiConfig.migrate({
  provider: "openai-compatible",
  endpoint: "https://my-own.example/v1/chat/completions",
  model: "my-model",
  apiKey: "sk-x"
});
check("自定义配置保持原样", custom.changed === false);
check("endpoint 未被改写", custom.cfg.endpoint === "https://my-own.example/v1/chat/completions");
check("model 未被改写", custom.cfg.model === "my-model");

console.log("[4] 只有 endpoint 残留 dashscope 也会被纠正");
const half = aiConfig.migrate({
  provider: "openai-compatible",
  endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  model: "some-model"
});
check("dashscope 端点被换掉", half.cfg.endpoint === "https://api.agnes-ai.cn/v1/chat/completions", half.cfg.endpoint);
check("未因端点迁移而改 provider", half.cfg.provider === "openai-compatible", half.cfg.provider);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
