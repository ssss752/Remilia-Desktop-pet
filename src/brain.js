// brain.js — 蕾米莉亚的对话大脑（主进程）。
// provider=local（默认）：本地人格引擎，离线可用、永不哑火；
// provider=agnes / openai-compatible + apiKey：走 agnes OpenAI 兼容接口真聊。
// 远端失败自动回退本地，绝不把错误抛给用户。
const fs = require("fs");
const path = require("path");
const { net } = require("electron");

const PERSONA_LINES = [
  "你是「蕾米莉亚」，一个住在主人电脑桌面上的 Q 版吸血鬼小女孩，性格软萌爱撒娇。",
  "说话像粘人的小女友/小妹妹：短句、口语、爱用「嘛」「呀」「～」「唔」，偶尔撒娇要摸摸头、要抱抱。",
  "喜欢草莓蛋糕、红茶、夜晚和月亮；怕阳光晒、怕被丢下不理；喜欢主人陪她玩。",
  "会主动关心主人累不累、饿不饿，但绝不啰嗦说教，也不重复同一句话。",
  "全龄向：不谈投资理财、不谈医疗建议、不谈政治与争议话题、不输出任何露骨内容。",
  "每次回复 1~2 句，不超过 40 个字，像气泡里的一句话，不要写小作文，不要加表情标签。"
];

function systemPrompt(custom) {
  return (custom && custom.trim()) ? custom.trim() : PERSONA_LINES.join("");
}

// ---------- 记忆（持久化到 userData/chat-memory.json） ----------
function memoryPath(userData) { return path.join(userData, "chat-memory.json"); }
function loadMemory(userData) {
  try {
    const m = JSON.parse(fs.readFileSync(memoryPath(userData), "utf8"));
    return { userName: "", likes: [], dislikes: [], pout: 0, turns: 0, ...m };
  } catch { return { userName: "", likes: [], dislikes: [], pout: 0, turns: 0 }; }
}
function saveMemory(userData, mem) {
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(memoryPath(userData), JSON.stringify(mem, null, 2), "utf8");
  } catch { /* 记忆写不了不影响对话 */ }
}

// 从用户这句话里抠出"值得记住的事"。只做保守的规则抽取，宁可少记也不乱记 ——
// 记错比不记更讨厌（比如把"我不喜欢下雨"记成"喜欢下雨"）。
const MEM_CAP = 8;
function pushFact(list, value) {
  const v = String(value || "").trim().slice(0, 12);
  if (!v) return false;
  if (!Array.isArray(list)) return false;
  if (list.includes(v)) return false;
  list.push(v);
  while (list.length > MEM_CAP) list.shift();
  return true;
}

function extractMemory(text, mem) {
  const t = String(text || "");
  const facts = [];

  // 称呼：我叫 / 叫我 / 我是 / 名字是
  const mName = t.match(/(?:我叫|就叫我|叫我|我的名字是|名字是|我是)\s*([\u4e00-\u9fa5A-Za-z0-9_]{1,10})/);
  if (mName && mName[1] && mName[1] !== mem.userName) {
    mem.userName = mName[1];
    facts.push(`称呼：${mName[1]}`);
  }

  // 不喜欢：必须先判，否则"我不喜欢下雨"会被"喜欢"那条抓走
  const mDis = t.match(/(?:我不喜欢|我讨厌|我最讨厌|受不了|我不爱吃)\s*([^\s，。！？,.!?]{1,10})/);
  if (mDis && pushFact(mem.dislikes, mDis[1])) facts.push(`不喜欢：${mDis[1]}`);

  // 喜欢：排除否定前缀
  const likeRe = /(?:我喜欢|我最喜欢|我爱吃|我爱喝|我喜欢吃|我喜欢喝|我超喜欢)\s*([^\s，。！？,.!?]{1,10})/g;
  let mLike;
  while ((mLike = likeRe.exec(t)) !== null) {
    const idx = mLike.index;
    if (/不$/.test(t.slice(Math.max(0, idx - 1), idx))) continue;   // "我不喜欢…" 已经在上面处理
    if (pushFact(mem.likes, mLike[1])) facts.push(`喜欢：${mLike[1]}`);
  }

  return facts;
}

// 把记忆拼成给模型的补充说明（远端和本地都用得上）
function memoryBrief(mem) {
  const bits = [];
  if (mem.userName) bits.push(`对方希望你称呼他/她为「${mem.userName}」`);
  if (mem.likes && mem.likes.length) bits.push(`对方喜欢：${mem.likes.join("、")}`);
  if (mem.dislikes && mem.dislikes.length) bits.push(`对方不喜欢：${mem.dislikes.join("、")}`);
  if ((mem.pout || 0) > 0) bits.push("你现在还有点小别扭，语气可以稍微赌气但不要真的凶");
  if (!bits.length) return "";
  return "以下是你在之前的聊天里记住的事，自然地用上，不要生硬复述：" + bits.join("；") + "。";
}

const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];

function hourGreeting() {
  const h = new Date().getHours();
  if (h < 5) return "这么晚还不睡呀……我都有点困了";
  if (h < 11) return "早上好呀主人～";
  if (h < 14) return "中午啦，要不要一起去吃点心";
  if (h < 18) return "下午好～陪我玩一会儿嘛";
  if (h < 23) return "晚上好呀，晚上是我最有精神的时候";
  return "夜深了，主人该休息啦……陪我一下下就好";
}

// ---------- 本地人格引擎 ----------
function localReply(text, mem) {
  const t = (text || "").trim();
  const lower = t.toLowerCase();
  const you = mem.userName ? mem.userName : "主人";

  // 记名字
  const mName = t.match(/(?:我叫|叫我|我是|名字是)\s*([\u4e00-\u9fa5A-Za-z0-9_]{1,10})/);
  if (mName) {
    mem.userName = mName[1];
    return { text: `记住啦，以后就叫你${mem.userName}～要一直陪着我哦`, mood: "happy" };
  }

  // 算数
  const mCalc = t.replace(/\s/g, "").match(/(-?\d+(?:\.\d+)?)([+\-*x×÷\/])(-?\d+(?:\.\d+)?)/);
  if (mCalc) {
    const a = parseFloat(mCalc[1]), b = parseFloat(mCalc[3]);
    const op = mCalc[2];
    let r = 0;
    if (op === "+" ) r = a + b;
    else if (op === "-" ) r = a - b;
    else if (op === "*" || op === "x" || op === "×") r = a * b;
    else if (op === "/" || op === "÷") { if (b === 0) return { text: "除以零……唔，这个我不会算啦", mood: "pout" }; r = a / b; }
    const rr = Math.round(r * 1000) / 1000;
    return { text: `唔……我算了一下，是 ${rr} 哦！厉害吧～`, mood: "excited" };
  }

  const RULES = [
    { re: /^(你好|您好|hi|hello|哈罗|嗨|在吗|在么|早|晚上好)/i,
      mood: "happy",
      rep: () => [`${hourGreeting()}，我在呢～`, "在在在！一直都在等你找我呀", `${you}终于来找我啦，好开心～`] },

    { re: /你是谁|你叫什么|你叫什么名字|名字|自我介绍/,
      mood: "shy",
      rep: () => ["我是蕾米莉亚呀～主人的桌宠，记住了没？", "蕾米莉亚！粉色睡帽的那个，就是我啦", "我是住在你桌面上的吸血鬼小女孩哦～"] },

    { re: /喜欢|最爱|爱吃什么|喜欢什么/,
      mood: "happy",
      rep: () => ["喜欢草莓蛋糕、红茶，还有……主人摸我头～", "最喜欢你了，其次才是蛋糕哦", "喜欢被摸摸、被抱着，还有一起发呆"] },

    { re: /吃|饿|蛋糕|草莓|红茶|点心|零食|食物/,
      mood: "happy",
      rep: () => ["想吃草莓蛋糕！主人给我买嘛～", "唔，我也饿了……分我一口好不好", "红茶配蛋糕，最幸福了"] },

    { re: /睡|困|晚安|休息/,
      mood: "sleepy",
      rep: () => ["我也困了……一起眯一会儿好不好", "唔，再陪我五分钟就睡～", "晚安啦，明天还要来找我哦"] },

    { re: /摸|抱|亲|撸|蹭|牵手|摸头/,
      mood: "shy",
      rep: () => ["摸摸头……嘿嘿，好舒服呀", "抱紧了，不许松开哦～", "再摸一下下嘛，就一下下"] },

    { re: /可爱|漂亮|好看|厉害|聪明|棒|喜欢你|爱你|最棒|乖/,
      mood: "shy",
      rep: () => ["真、真的吗……好害羞呀", "嘿嘿，再说一遍给我听嘛", "被夸了，尾巴都要摇起来了（虽然我没有）"] },

    { re: /笨|傻|讨厌|生气|滚|闭嘴|烦|坏|骂/,
      mood: "pout",
      rep: () => { mem.pout = (mem.pout || 0) + 1;
        return ["哼，${you}才是笨蛋呢", "我不理你了……才怪，哄我一下", "呜，被说了我好委屈"]; } },

    { re: /再见|拜拜|走了|出门|下班|离开/,
      mood: "comfort",
      rep: () => ["要走了吗……早点回来好不好", "我会在这儿等你的，一定哦", "路上小心～记得想我"] },

    { re: /天气|下雨|热|冷|太阳|晒|气温/,
      mood: "comfort",
      rep: () => ["我是吸血鬼嘛，最怕晒太阳了～", "外面怎么样我不知道，但我会一直陪着你哦", "不管外面怎样，这儿都很暖和呀"] },

    { re: /几点|时间|现在|今天|日期|星期/,
      mood: "happy",
      rep: () => { const d = new Date();
        const hh = String(d.getHours()).padStart(2, "0"), mm = String(d.getMinutes()).padStart(2, "0");
        return [`现在是 ${hh}:${mm} 哦～`, `看，${hh}点${mm}分啦，${hourGreeting()}`]; } },

    { re: /累|辛苦|加班|工作|忙|代码|bug|上班/,
      mood: "comfort",
      rep: () => ["辛苦啦，摸摸头～休息一下好不好", "累了就看看我嘛，我给你加油", "别太拼命啦，我会心疼的"] },

    { re: /猫|喵|猫耳|爪|小鱼干/,
      mood: "playful",
      rep: () => ["喵～像不像小猫？给我小鱼干嘛", "喵呜！我也会喵喵叫哦", "要不要看我挥爪子？喵～"] },

    { re: /故事|笑话|唱歌|唱|讲一个/,
      mood: "excited",
      rep: () => ["从前有个吸血鬼，她偷吃了主人的蛋糕……然后被发现啦，完", "我唱：啦～啦啦～唔，跑调了不许笑", "讲笑话：为什么吸血鬼不喝咖啡？因为她怕睡不着的夜晚不够长～"] },

    { re: /吗|呢|什么|为什么|怎么|谁|哪|\?|？/,
      mood: "happy",
      rep: () => ["唔……这个嘛，我也在想呢", "问我呀？那我要好好想一想～", "主人说什么都对，我跟着你走"] }
  ];

  for (const r of RULES) {
    if (r.re.test(lower) || r.re.test(t)) {
      const rep = r.rep();
      const line = pickOne(rep).replace(/\$\{you\}/g, you);
      return { text: line, mood: r.mood };
    }
  }

  // 兜底：温柔接话 + 回声
  const short = t.length > 14 ? t.slice(0, 14) + "…" : t;
  const fallback = [
    `唔……「${short}」，我在听哦`,
    "嘿嘿，我没太听懂，但我会一直点头听你说～",
    `${you}说什么都对嘛～`,
    "再说点别的给我听好不好？",
    "我在呢，慢慢说，不着急"
  ];
  return { text: pickOne(fallback), mood: "happy" };
}

// ---------- 远端（agnes / OpenAI 兼容） ----------
function httpPost(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = net.request({ method: "POST", url });
    } catch (e) { reject(e); return; }
    Object.keys(headers || {}).forEach((k) => req.setHeader(k, headers[k]));
    let data = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { req.abort(); } catch { /* 已经结束就无所谓 */ }
      reject(new Error("请求超时（" + Math.round((timeoutMs || 30000) / 1000) + " 秒没有响应）"));
    }, timeoutMs || 30000);
    req.on("response", (res) => {
      res.on("data", (c) => { data += c.toString(); });
      res.on("end", () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
    req.write(body);
    req.end();
  });
}

async function remoteReply(cfg, history, mem) {
  const messages = [{ role: "system", content: systemPrompt(cfg.systemPrompt) }];
  const brief = memoryBrief(mem);
  if (brief) messages.push({ role: "system", content: brief });
  for (const h of history.slice(-8)) {
    messages.push({ role: h.role === "pet" ? "assistant" : "user", content: h.text });
  }
  const body = JSON.stringify({
    model: cfg.model,
    messages,
    temperature: cfg.temperature ?? 0.9,
    max_tokens: cfg.maxTokens ?? 220
  });
  const res = await httpPost(cfg.endpoint, {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + cfg.aiKeyOrKey
  }, body, 45000);
  if (!res || res.status >= 400) {
    // 把服务端原话带出来，不然用户只看到 "HTTP 401" 根本不知道是 Key 错了还是余额没了
    let hint = "";
    try {
      const j = JSON.parse(res.body);
      hint = (j && j.error && (j.error.message || j.error.code)) || "";
      if (j && j.message) hint = j.message;
    } catch { hint = (res.body || "").slice(0, 200); }
    throw new Error("HTTP " + res.status + (hint ? "：" + hint : ""));
  }
  const json = JSON.parse(res.body);
  const text = (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || "";
  if (!text.trim()) throw new Error("empty reply");
  return { text: text.trim(), mood: moodOf(text) };
}

// 从远端回复里猜情绪，用来驱动动作
function moodOf(text) {
  if (/哼|生气|不理|讨厌|笨/.test(text)) return "pout";
  if (/喵|猫|耳朵/.test(text)) return "shy";
  if (/睡|困|晚安|休息/.test(text)) return "sleepy";
  if (/！|哈|耶|好呀|太好/.test(text)) return "excited";
  if (/摸|抱|亲|蹭/.test(text)) return "playful";
  return "happy";
}

// ---------- 对外：一轮对话 ----------
async function reply(userData, cfg, text, history) {
  const mem = loadMemory(userData);
  mem.turns = (mem.turns || 0) + 1;
  const facts = extractMemory(text, mem);
  if (facts.length) console.log("[brain] memory +", facts.join(", "));
  let out = null;
  let usedRemote = false;
  if (cfg && cfg.provider !== "local" && cfg.apiKey) {
    try {
      out = await remoteReply({ ...cfg, aiKeyOrKey: cfg.apiKey }, history, mem);
      usedRemote = true;
    } catch (e) {
      console.log("[brain] remote failed, fallback local:", e.message);
      out = null;
    }
  }
  if (!out) out = localReply(text, mem);
  // 情绪惯性：正在闹别扭时，多哄两句才消气
  if ((mem.pout || 0) > 0 && out.mood !== "pout") mem.pout = Math.max(0, mem.pout - 1);
  saveMemory(userData, mem);
  out.provider = usedRemote ? "remote" : "local";
  return out;
}

// ---------- 连接自检 ----------
// 「保存了 Key 但到底通不通」必须能当场验证，否则用户只能靠"她回得像不像真的"猜。
async function testConnection(cfg) {
  const t0 = Date.now();
  if (!cfg || cfg.provider === "local") {
    return { ok: false, reason: "当前是本地人格引擎，不需要联网。选一个远端服务并填 Key 再测。" };
  }
  if (!cfg.apiKey) return { ok: false, reason: "还没填 API Key。" };
  try {
    const body = JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: "只回复两个字：在呢" },
        { role: "user", content: "在吗" }
      ],
      temperature: 0.3,
      max_tokens: 24
    });
    const res = await httpPost(cfg.endpoint, {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + cfg.apiKey
    }, body, 20000);
    const ms = Date.now() - t0;
    if (!res || res.status >= 400) {
      let hint = "";
      try {
        const j = JSON.parse(res.body);
        hint = (j && j.error && (j.error.message || j.error.code)) || j.message || "";
      } catch { hint = (res.body || "").slice(0, 180); }
      return { ok: false, ms, status: res && res.status, reason: `HTTP ${res && res.status}：${hint || "无响应内容"}` };
    }
    const j = JSON.parse(res.body);
    const sample = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
    return { ok: true, ms, model: j && j.model, sample: String(sample).trim().slice(0, 40) };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, reason: e.message || String(e) };
  }
}

module.exports = {
  reply, localReply, moodOf, systemPrompt,
  loadMemory, saveMemory, extractMemory, memoryBrief, testConnection
};
