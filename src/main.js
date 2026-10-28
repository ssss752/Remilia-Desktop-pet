// main.js — 蕾米莉亚桌宠主进程：窗口、托盘、持久化、对话、门禁记录。
// 平台差异一律调 platform.js，本文件零 process.platform 判断。
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const platform = require("./platform");
const aiConfig = require("./ai-config");
const brain = require("./brain");
const { createReminders } = require("./reminders");

// 验收隔离：PET_PROFILE=<名字> 把 userData 指到 appData/<名字>。
// 上一轮验证留下的实例有时因权限原因杀不掉、还占着单实例锁和同一份
// pet-state.json / .gate.log，两边互相覆盖会让日志变成乱码、结论不可信。
// 验证实例用独立 profile 就彻底隔离了；capturePage 抓的是窗口自己的像素，
// 屏幕上叠着别的窗口也不影响取证。
if (process.env.PET_PROFILE) {
  app.setPath("userData", path.join(app.getPath("appData"), process.env.PET_PROFILE));
}

const BASE_H = 120;                      // 角色高度基准(DIP)：桌面上放大一倍后的体量
// 宠物窗口就是**角色本体的正方形**（宽=高）。气泡不再挤在同一个窗口里 ——
// 见下方"气泡窗口"一节的说明，这是"右键/拖拽时灵时不灵"的根治办法。
const BASE_W = BASE_H;
const BUBBLE_W = 196;                    // 气泡窗口宽（DIP）
const BUBBLE_H = 60;                     // 气泡窗口高（DIP）
const BOTTOM_INSET_PT = 6;               // 离屏幕底保留的空白，避免压住自动隐藏的任务栏触发带
const SIZE_VERSION = 7;                  // 尺寸/坐标持久化版本：基准变过就要作废旧坐标
const MOVE_FLUSH_MS = 16;                // 窗口位置更新合并窗口：约 60Hz 上限，避免 DWM 重排风暴
const STATE_FILE = "pet-state.json";
const GATE_LOG = ".gate.log";
const CHAT_FILE = "chat-history.json";

let win = null;
// 创建/改尺寸时记下的目标尺寸（DIP）。G3 用它断言窗口没有自己长大 ——
// 曾经因为在移动时把膨胀后的 getBounds 回写进 setBounds，窗口会越走越大。
let expectedSize = { w: 0, h: 0 };
let tray = null;
let chatWin = null;
let bubbleWin = null;
let petHidden = false;          // 用户主动收起（托盘/右键菜单），此时不冒泡
let gateReady = false;
// lowFlash 默认开：渲染降帧 + 静止冻结，消除透明置顶窗的高频合成闪烁。
let settings = { alwaysOnTop: true, clickThrough: true, quiet: false, lowFlash: true, peekHint: true };
const SETTINGS_VERSION = 2;
let history = [];

// ---------- 置顶自愈 ----------
// 窗口扩展样式（SetWindowLong GWL_EXSTYLE）被改写时会把 WS_EX_TOPMOST 位一起冲掉。
// 但"补置顶"本身也是写窗口样式：频繁 false→true 翻转会让 Windows 反复把这块区域判成
// "来了/走了个置顶全屏窗"，表现就是通知区「请勿打扰」跟着一闪一闪。所以：
//   1) 只在真的丢了置顶（isAlwaysOnTop() 探针为 false）时才补；
//   2) 两次补之间至少隔 60 秒，绝不高频翻；
//   3) 本轮架构本身已经不再改写样式（气泡独立窗口），正常情况下它永远不会被触发。
let healBusy = false;
let lastHealAt = 0;
let healTries = 0;
const HEAL_MIN_GAP_MS = 60000;
function healTopmost(force) {
  if (healBusy || !win || win.isDestroyed() || !settings.alwaysOnTop) return;
  if (win.isAlwaysOnTop()) { healTries = 0; return; }
  if (!force && Date.now() - lastHealAt < HEAL_MIN_GAP_MS) return;
  healBusy = true;
  lastHealAt = Date.now();
  win.setAlwaysOnTop(false);
  setTimeout(() => {
    healBusy = false;
    if (!win || win.isDestroyed() || !settings.alwaysOnTop) return;
    win.setAlwaysOnTop(true, platform.alwaysOnTopLevel());
    const ok = win.isAlwaysOnTop();
    gateLog(`[perf] alwaysOnTop healed ok=${ok}`);
    // 偶发一次不成就再补一次（最多 3 次），之后才进入 60 秒冷却，避免样式抖动
    if (!ok && healTries < 3) { healTries++; setTimeout(() => healTopmost(true), 500); }
    else healTries = 0;
  }, 40);
}

// ---------- 持久化 ----------
function statePath() { return path.join(app.getPath("userData"), STATE_FILE); }
function chatPath() { return path.join(app.getPath("userData"), CHAT_FILE); }

function loadState() {
  try { return JSON.parse(fs.readFileSync(statePath(), "utf8")); } catch { return {}; }
}

let saveTimer = null;
function saveState(patch) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const cur = loadState();
    const next = { ...cur, ...patch };
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(next, "utf8"), "utf8");
  }, 500);
}

function loadHistory() {
  try { history = JSON.parse(fs.readFileSync(chatPath(), "utf8")) || []; }
  catch { history = []; }
}
function saveHistory() {
  try {
    fs.mkdirSync(path.dirname(chatPath()), { recursive: true });
    fs.writeFileSync(chatPath(), JSON.stringify(history.slice(-200), null, 2), "utf8");
  } catch { /* 聊天记录写不了不影响运行 */ }
}

// ---------- 门禁记录 ----------
function gateLog(line) {
  try {
    fs.appendFileSync(path.join(app.getPath("userData"), GATE_LOG), line + "\n", "utf8");
  } catch { /* 日志不可写也不影响运行 */ }
  console.log(line);
}

// ---------- 改尺寸 ----------
// 模块级：托盘菜单和 IPC 都走这一条路径。（旧版把它写在 registerIpc() 里面，
// 托盘「尺寸」菜单点下去其实是 ReferenceError —— 静默失效。）
function resizePet(pt) {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const d = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  const h = platform.windowSize(d, pt);
  const w = platform.windowSize(d, Math.round(pt * (BASE_W / BASE_H)));  // 正方形窗口
  // 以左下角为锚点缩放，避免改尺寸时角色飘走
  const y2 = Math.max(0, b.y + (b.height - h));
  win.setBounds({ width: w, height: h, y: y2 });
  expectedSize = { w, h };
  syncBubbleBounds();
  saveState({ sizePt: pt, sizeVersion: SIZE_VERSION });
  gateLog(`[size] -> ${pt}pt (${w}x${h})`);
}

// ---------- 气泡窗口 ----------
// 为什么单独开一个窗口：气泡要占角色右边一大条，如果和角色共用一个窗口，就只能靠
// setIgnoreMouseEvents(true/false) 把空条"穿透"掉。而每次改窗口扩展样式都会连带把
// WS_EX_TOPMOST 冲掉、并且打断正在进行的 mousedown→mousemove→mouseup 序列 ——
// 实测就是「右键没反应、抓不起来」的直接原因（窗口还停在穿透状态，点击穿透到桌面了）。
// 现在：角色窗口 = 角色本体正方形，永不穿透、永不改样式；气泡窗口 = 永远穿透、
// 创建时设置一次就再也不动。输入链路上一个开关都没有，稳。
function bubbleGeometry(petBounds) {
  const b = petBounds || (win && win.getBounds()) || { x: 0, y: 0, width: BASE_W, height: BASE_H };
  const d = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  const wa = d.workArea;
  let x = b.x + b.width + 2, side = "right";        // 气泡在右，尖角朝左
  if (x + BUBBLE_W > wa.x + wa.width - 2) {          // 右边没地方就翻到左边
    x = b.x - BUBBLE_W - 2;
    side = "left";
  }
  if (x < wa.x) x = wa.x;
  return { x: Math.round(x), y: Math.round(b.y), w: BUBBLE_W, h: Math.round(b.height), side };
}

function ensureBubbleWin() {
  if (bubbleWin && !bubbleWin.isDestroyed()) return bubbleWin;
  const g = bubbleGeometry();
  bubbleWin = new BrowserWindow({
    width: g.w,
    height: g.h,
    x: g.x,
    y: g.y,
    ...platform.windowTypeOptions(),
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: settings.alwaysOnTop,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "bubble-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  // 整个气泡窗口永久穿透：它只负责显示，永远不接鼠标 —— 一次设置，此后不再改动样式。
  // PET_BUBBLE_NO_IGNORE 仅用于对照实验（验证 WS_EX_LAYERED 是不是罪魁）。
  if (!process.env.PET_BUBBLE_NO_IGNORE) bubbleWin.setIgnoreMouseEvents(true);
  bubbleWin.loadFile(path.join(__dirname, "renderer", "bubble.html"));
  bubbleWin.on("closed", () => { bubbleWin = null; bubbleHealTries = 0; });
  return bubbleWin;
}

// 气泡窗口的置顶自愈。
// 坑（和宠物窗口同一个）：setIgnoreMouseEvents 内部改 GWL_EXSTYLE，会把 WS_EX_TOPMOST
// 一起冲掉（实测 0x08200088 → 0x082800A0，TOPMOST 位没了）。而 Electron 内部的
// alwaysOnTop 标记仍是 true，所以直接再调 setAlwaysOnTop(true) 是空操作 ——
// 必须 false → 隔一拍 → true 才真的落到系统上。
// 另一个坑：对**还没显示**的窗口调 setAlwaysOnTop 同样落空（实测 ok=false），
// 所以这里不在创建期补，一律在 showInactive() 之后补。
let bubbleHealTries = 0;
function healBubbleTopmost(force) {
  if (!bubbleWin || bubbleWin.isDestroyed() || !settings.alwaysOnTop) return;
  if (!force && bubbleWin.isAlwaysOnTop()) { bubbleHealTries = 0; return; }
  bubbleWin.setAlwaysOnTop(false);
  setTimeout(() => {
    if (!bubbleWin || bubbleWin.isDestroyed() || !settings.alwaysOnTop) return;
    bubbleWin.setAlwaysOnTop(true, platform.alwaysOnTopLevel());
    const ok = bubbleWin.isAlwaysOnTop();
    if (!ok && bubbleHealTries < 4) {
      bubbleHealTries++;
      gateLog(`[bubble] topmost heal retry #${bubbleHealTries}`);
      setTimeout(() => healBubbleTopmost(true), 200 * bubbleHealTries);
    } else {
      gateLog(`[bubble] topmost heal ok=${ok}`);
      bubbleHealTries = 0;
    }
  }, 40);
}

// 气泡显示期间每 1.5s 摸一次顶置位：已经是 TOPMOST 就立刻返回，不动任何样式，
// 只有真丢了才走上面的 false→true 两拍。
function startBubbleTopWatch() {
  setInterval(() => {
    if (!bubbleWin || bubbleWin.isDestroyed() || !bubbleWin.isVisible()) return;
    healBubbleTopmost(false);
  }, 1500);
}

// 启动预热：透明窗的第一次合成，Chromium 会重刷自己的扩展样式，把 TOPMOST 抹掉
// 好几次（实测要重试 3~4 次才稳住）。如果等她第一次开口才现搭窗口，头一两句气泡
// 就会顶着 top=false 被前台窗口盖住——看着就是"气泡没出来"。所以启动时先把窗口
// 建好、显示一次、把样式打稳，之后句句都直接可见。
// 预热期窗口是全透明的空页面，屏幕上看不见东西，也不接鼠标。
function warmUpBubble() {
  const bw = ensureBubbleWin();
  const run = () => {
    if (!bubbleWin || bubbleWin.isDestroyed()) return;
    if (!bubbleWin.isVisible()) bubbleWin.showInactive();
    healBubbleTopmost(false);
    setTimeout(() => {
      if (!bubbleWin || bubbleWin.isDestroyed()) return;
      healBubbleTopmost(false);
      gateLog(`[bubble] warm-up done top=${bubbleWin.isAlwaysOnTop()}`);
    }, 900);
  };
  if (bw.webContents.isLoading()) bw.webContents.once("did-finish-load", run);
  else run();
}

let lastBubbleSide = null;
function syncBubbleBounds() {
  if (!bubbleWin || bubbleWin.isDestroyed() || !win || win.isDestroyed()) return;
  const g = bubbleGeometry();
  // 先告诉页面尖角朝哪边，再挪窗口：反过来的话会有 1 帧"窗口已在左边、尖角还朝左"的错位。
  bubbleWin.webContents.send("bubble:side", g.side);
  bubbleWin.setBounds({ x: g.x, y: g.y, width: g.w, height: g.h });
  if (g.side !== lastBubbleSide) {
    lastBubbleSide = g.side;
    gateLog(`[bubble] side -> ${g.side} at x=${g.x}`);
  }
}

function showBubbleText(text, ms) {
  if (!win || win.isDestroyed() || petHidden) return;   // 被收起时不冒泡
  const bw = ensureBubbleWin();
  const g = bubbleGeometry();
  const send = () => {
    if (!bubbleWin || bubbleWin.isDestroyed()) return;
    // 每次冒泡都重新定位：她可能刚飞完/被拖过，老坐标不能沿用
    bubbleWin.setBounds({ x: g.x, y: g.y, width: g.w, height: g.h });
    bubbleWin.webContents.send("bubble:show", { text: String(text || ""), ms: ms || 3200, side: g.side });
    if (!bubbleWin.isVisible()) bubbleWin.showInactive();   // 不抢焦点
    // 必须在显示之后补顶置：对隐藏窗口调 setAlwaysOnTop 会落空
    healBubbleTopmost(false);
    gateLog(`[bubble] "${String(text).slice(0, 12)}" side=${g.side} at ${g.x},${g.y} ` +
            `top=${bubbleWin.isAlwaysOnTop()}`);
    // 取证：抓气泡窗口自己的像素。如果 capturePage 有内容而屏幕上没有，
    // 说明是透明窗合成问题（DWM 没重绘），不是页面/JS 的问题 —— 定位方向完全不同。
    if (process.env.PET_BUBBLE_SHOT) {
      setTimeout(async () => {
        if (!bubbleWin || bubbleWin.isDestroyed()) return;
        try {
          const img = await bubbleWin.capturePage();
          fs.writeFileSync(process.env.PET_BUBBLE_SHOT, img.toPNG());
          gateLog(`[gate] bubble shot ${img.getSize().width}x${img.getSize().height} ` +
                  `visible=${bubbleWin.isVisible()} -> ${process.env.PET_BUBBLE_SHOT}`);
        } catch (e) { gateLog(`[gate] bubble shot failed: ${e.message}`); }
      }, 600);
    }
  };
  if (bw.webContents.isLoading()) bw.webContents.once("did-finish-load", send);
  else send();
}

// ---------- 实用小功能（整点报时 / 喝水提醒 / 番茄钟 / 夜间静音）----------
let reminders = null;

function initReminders() {
  const saved = loadState().reminders || {};
  reminders = createReminders({
    initial: saved,
    say: (text, ms) => showBubbleText(text, ms),
    isHidden: () => petHidden || !win || win.isDestroyed() || !win.isVisible(),
    onChange: (cfg) => { saveState({ reminders: cfg }); createTray(); },  // 勾选状态立刻反映到托盘
    log: gateLog
  });
  reminders.start();
}

// ---------- 「主人在忙别的」探测 → 提示她去屏幕边偷看 ----------
// 她什么时候该溜到屏幕边偷看？最像活的时机是「主人盯着别的窗口、很久没碰她」。
// Electron 拿不到"当前前台是哪个程序"，但拿得到**全局光标位置** —— 光标长时间不
// 在她身上，就是主人在别处忙的可靠信号。每 3 秒读一次坐标：纯读取，不改任何窗口
// 样式、不碰 always-on-top，所以不会引起上次那种通知区抖动。
let lastNearPetAt = Date.now();
let lastPeekHintAt = 0;
const PEEK_HINT_IDLE_MS = 45000;     // 连续 45 秒没靠近她
const PEEK_HINT_GAP_MS = 150000;     // 两次提示之间至少隔 2.5 分钟，别烦人
function startPeekHintWatch() {
  setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible() || petHidden) return;
    if (!settings.peekHint) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const pad = 16;
    const near = p.x >= b.x - pad && p.x <= b.x + b.width + pad &&
                 p.y >= b.y - pad && p.y <= b.y + b.height + pad;
    const now = Date.now();
    if (near) { lastNearPetAt = now; return; }
    if (now - lastNearPetAt < PEEK_HINT_IDLE_MS) return;
    if (now - lastPeekHintAt < PEEK_HINT_GAP_MS) return;
    lastPeekHintAt = now;
    win.webContents.send("pet:peek-hint");
    gateLog(`[peek] hint sent (cursor away ${Math.round((now - lastNearPetAt) / 1000)}s)`);
  }, 3000);
}

// ---------- 窗口 ----------
function createWindow() {
  const display = screen.getPrimaryDisplay();
  const saved = loadState();
  // 尺寸只存「角色高度(DIP)」，窗口宽高每次重算。
  // SIZE_VERSION 3 起基准 128pt → 48pt，4 起 → 38pt（图标大小）。更早版本存下的
  // sizePt / x / y 一律丢弃：旧坐标是给大窗口算的，直接沿用会让她悬在屏幕中间。
  const keepSaved = saved.sizeVersion >= SIZE_VERSION;
  const sizePt = (keepSaved && Number.isFinite(saved.sizePt)) ? saved.sizePt : BASE_H;
  const petH = platform.windowSize(display, sizePt);
  const petW = platform.windowSize(display, Math.round(sizePt * (BASE_W / BASE_H)));
  const wa = display.workArea;
  const bottomInset = platform.windowSize(display, BOTTOM_INSET_PT);

  // 默认把她放在右下角，右侧留出气泡的位置
  const rightInset = BUBBLE_W + 12;
  let x = keepSaved && Number.isFinite(saved.x) ? saved.x : wa.x + wa.width - petW - rightInset;
  let y = keepSaved && Number.isFinite(saved.y) ? saved.y : wa.y + wa.height - petH - bottomInset;
  const onAnyScreen = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return x >= a.x - petW && x < a.x + a.width && y >= a.y - petH && y < a.y + a.height;
  });
  if (!onAnyScreen) { x = wa.x + wa.width - petW - rightInset; y = wa.y + wa.height - petH - bottomInset; }

  win = new BrowserWindow({
    width: petW,
    height: petH,
    x,
    y,
    ...platform.windowTypeOptions(),
    transparent: true,
    backgroundColor: "#00000000", // 显式全透明，避免 Windows 上首帧黑底/白底闪一下
    frame: false,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: settings.alwaysOnTop,
    // focusable 必须是 true：实测 WS_EX_NOACTIVATE 的窗口上，Chromium 会把"窗口未激活时
    // 的鼠标按下"当成一次激活尝试而**吞掉**，只有右键的 WM_CONTEXTMENU 侥幸到达
    // —— 于是"左键点不动、抓不住、右键能出菜单"。
    // 为了不抢焦点：窗口用 show:false 创建，加载完用 showInactive() 显示，启动和冒泡
    // 都不会夺取前台；只有用户主动点她时才会激活（这是交互应有的行为）。
    focusable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  win.setAlwaysOnTop(settings.alwaysOnTop, platform.alwaysOnTopLevel());
  gateLog(`[top] after create setAOT(${settings.alwaysOnTop}) -> ${win.isAlwaysOnTop()}`);
  expectedSize = { w: petW, h: petH };
  // 系统会给无边框透明窗补 2~3px 的不可见边框，所以以**创建后的实测值**作为
  // 基线尺寸：G3 要抓的是「之后有没有自己长大」，而不是差这几个像素。
  setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const b0 = win.getBounds();
    if (b0.width > 0 && b0.height > 0) expectedSize = { w: b0.width, h: b0.height };
  }, 400);
  // setVisibleOnAllWorkspaces 是 macOS 专有能力；Windows 上调用无效果却可能触发
  // 窗口样式重设，进而让透明窗重新合成 —— 只在支持的平台调用。
  if (platform.supportsAllWorkspaces()) {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  win.setIgnoreMouseEvents(false);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  // 加载完再显示，且不激活：启动过程绝不抢前台焦点
  win.webContents.once("did-finish-load", () => {
    if (win && !win.isDestroyed()) win.showInactive();
    setTimeout(() => { if (win && !win.isDestroyed()) healTopmost(true); }, 100);
  });
  // 被点击激活/失焦时，Windows 会把 WS_EX_TOPMOST 位甩掉（实测：一点击就从
  // 0x00200088 变成 0x00200080），下一次交互就点到别的窗口上去了 —— 立刻补回来。
  win.on("focus", () => setTimeout(() => healTopmost(true), 100));
  win.on("blur", () => setTimeout(() => healTopmost(true), 100));

  // 置顶保活：全屏程序退出、任务栏重建等场景会把 WS_EX_TOPMOST 丢掉。
  // 用 isAlwaysOnTop() 当探针，**只在真丢了才补，且 60 秒内只补一次** ——
  // 高频翻转窗口样式会让通知区的「请勿打扰」跟着反复开关。
  setTimeout(() => healTopmost(true), 1500);   // 首次强制：窗口选项里的 alwaysOnTop 常常没真的落下去
  setInterval(healTopmost, 8000);

  // 打上本轮尺寸版本：之后拖动保存的 x/y 才允许被下次启动沿用
  saveState({ sizeVersion: SIZE_VERSION });

  // 取证开关（仅验收用，正常启动不生效）：
  //   PET_FORCE_STATE=float      启动后强制切到某动作（走和托盘菜单相同的通道）
  //   PET_SHOT=<输出png路径>      抓图；路径末尾的 .png 会替换成 _0.png/_1.png ...
  //   PET_SHOT_DELAY=2600,2800    逗号分隔的多个延迟，用来抓连续帧核对动画是否真的在动
  // 透明窗口用外部截屏工具抓不到（硬件合成层），只能用 Electron 自己的
  // capturePage —— 它拿到的是窗口合成后的真实像素，才是用户看到的东西。
  if (process.env.PET_TEST_MENU) {
    // 验收用：不依赖真实右键，直接弹一次菜单，核对窗口能不能出来
    setTimeout(() => {
      const b = win.getBounds();
      showPetContextMenu(b.x + 30, b.y + 10);
    }, 2500);
  }
  if (process.env.PET_SYNTH_CLICK) {
    // 诊断用：绕开操作系统，直接往渲染进程灌一次合成点击，验证 DOM 侧是否正常
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      win.webContents.sendInputEvent({ type: "mouseDown", x: 30, y: 30, button: "left", clickCount: 1 });
      setTimeout(() => {
        if (!win || win.isDestroyed()) return;
        win.webContents.sendInputEvent({ type: "mouseUp", x: 30, y: 30, button: "left", clickCount: 1 });
        gateLog("[input] synth click sent");
      }, 80);
    }, 3000);
  }
  if (process.env.PET_FORCE_STATE) {
    setTimeout(() => {
      if (win && !win.isDestroyed()) {
        win.webContents.send("pet:action", process.env.PET_FORCE_STATE);
        gateLog(`[gate] force state ${process.env.PET_FORCE_STATE}`);
      }
    }, 1400);
  }
  if (process.env.PET_OPEN_CHAT) {
    // 验收用：启动就把聊天窗口打开，便于核对设置面板
    setTimeout(() => { if (!petHidden) openChat(); }, 1800);
  }
  if (process.env.PET_SAY) {    // 验收用：启动后主动让角色说一句，便于核对气泡在小尺寸下的可读性
    setTimeout(() => {
      if (win && !win.isDestroyed()) {
        win.webContents.send("pet:say", { text: process.env.PET_SAY, mood: "playful" });
        gateLog("[gate] say forced");
      }
    }, 1200);
  }
  if (process.env.PET_SHOT) {
    const delays = String(process.env.PET_SHOT_DELAY || 4000).split(",").map(Number);
    const base = process.env.PET_SHOT.replace(/\.png$/i, "");
    delays.forEach((delay, i) => {
      setTimeout(async () => {
        if (!win || win.isDestroyed()) return;
        try {
          const img = await win.capturePage();
          const out = `${base}_${i}.png`;
          fs.writeFileSync(out, img.toPNG());
          const s = img.getSize();
          const b = win.getBounds(), c = win.getContentBounds();
          const d = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
          gateLog(`[gate] shot ${s.width}x${s.height} bounds=${b.width}x${b.height} ` +
                  `content=${c.width}x${c.height} scale=${d.scaleFactor} -> ${out}`);
        } catch (e) {
          gateLog(`[gate] shot failed: ${e.message}`);
        }
      }, delay);
    });
  }

  // 渲染进程的绘制/输入探针：转发到门禁日志，用于核对低闪烁模式的实际帧数与输入链路
  win.webContents.on("console-message", (...args) => {
    const msg = args.find((a) => typeof a === "string" && /\[(perf|input|top|peek|land|fly|hover)\]/.test(a));
    if (msg) gateLog(msg);
  });

  // G3 自检：ready 后 2s。置顶自愈的重试节奏是 1.5s → 2.04s，正好和 2.0s 的检查
  // 卡在两拍之间，会出现「检查那一下正好是 false」的假报警。所以失败时再给两次机会，
  // 报出来的是**稳定后**的真实状态，而不是抓拍到的瞬态。
  function runG3(attempt) {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const inScreen = screen.getAllDisplays().some((d) => {
      const wa2 = d.workArea;
      return b.x >= wa2.x - b.width && b.x < wa2.x + wa2.width &&
             b.y >= wa2.y - b.height && b.y < wa2.y + wa2.height;
    });
    const checks = {
      visible: win.isVisible(),
      // isAlwaysOnTop() 在 Windows 上读的就是 exstyle 的 WS_EX_TOPMOST 位，是准的
      // （曾误判为"恒返回 false"，结果把真回归当成了假报警）。保活已在 1.5s 时补过。
      alwaysOnTop: win.isAlwaysOnTop(),
      // 启动/冒泡都不该抢前台：窗口可激活（为了收得到点击），但显示时必须是 showInactive
      notFocused: !win.isFocused(),
      inScreen,
      // 尺寸不得偏离目标：移动时回写尺寸会导致窗口一路变大
      sizeOk: Math.abs(b.width - expectedSize.w) <= 2 && Math.abs(b.height - expectedSize.h) <= 2
    };
    const pass = Object.values(checks).every(Boolean);
    if (!pass && attempt < 2) {
      gateLog(`[gate] G3 retry#${attempt + 1} ${JSON.stringify(checks)}`);
      setTimeout(() => runG3(attempt + 1), 700);
      return;
    }
    gateLog(`[gate] G3 ${pass ? "PASS" : "FAIL"} ${JSON.stringify(checks)} ` +
            `size=${b.width}x${b.height} want=${expectedSize.w}x${expectedSize.h}` +
            (attempt ? ` (after ${attempt} retry)` : ""));
  }
  setTimeout(() => runG3(0), 2000);

  // G4 取证：启动后自动截一张宠物窗口（双平台通用）
  setTimeout(async () => {
    try {
      const img = await win.capturePage();
      const p = path.join(app.getPath("userData"), "pet-capture.png");
      fs.writeFileSync(p, img.toPNG());
      const ev = path.join(__dirname, "..", "g4-evidence.png");
      fs.writeFileSync(ev, img.toPNG());
      gateLog(`[gate] G4 evidence: ${ev}`);
    } catch (e) {
      gateLog(`[gate] G4 evidence failed: ${e.message}`);
    }
  }, 4500);

  // G1 超时门禁：10s 内未收到 renderer-ready 即 FAIL
  setTimeout(() => {
    if (!gateReady) gateLog("[gate] G1 FAIL timeout: renderer-ready not received in 10s");
  }, 10000);

  win.on("moved", () => {
    const b = win.getBounds();
    saveState({ x: b.x, y: b.y });
    syncBubbleBounds();          // 气泡窗口跟着她走（两个窗口各自独立合成，必须同步挪）
  });
}

// ---------- 聊天窗口（独立窗口，保证宠物窗口始终不抢焦点） ----------
function openChat() {
  if (chatWin && !chatWin.isDestroyed()) { chatWin.show(); chatWin.focus(); return; }
  chatWin = new BrowserWindow({
    width: 430,
    height: 600,
    minWidth: 340,
    minHeight: 420,
    title: "和蕾米莉亚聊天",
    backgroundColor: "#12060c",      // 与聊天页的夜黑底一致，避免加载瞬间闪出紫色
    webPreferences: {
      preload: path.join(__dirname, "chat-preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  // 验收用：PET_CHAT_PANEL=1 直接打开设置面板；PET_CHAT_SHOT=<png> 把窗口本身截下来。
  // 聊天窗口不透明，capturePage 能正常工作，比外部截屏可靠（外部截屏会被前台窗口盖住）。
  chatWin.loadFile(path.join(__dirname, "chat", "index.html"),
    { search: process.env.PET_CHAT_PANEL ? "panel=1" : "" });
  chatWin.on("closed", () => { chatWin = null; });
  if (process.env.PET_CHAT_SHOT) {
    // capturePage 对被遮挡的窗口会抛 UnknownVizError（合成表面被回收）。
    // 测试态下临时置顶，保证它没被别的窗口盖住，截完就不管了。
    chatWin.setAlwaysOnTop(true, platform.alwaysOnTopLevel());
    const out = process.env.PET_CHAT_SHOT;
    chatWin.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        if (!chatWin || chatWin.isDestroyed()) return;
        try {
          const img = await chatWin.capturePage();
          fs.writeFileSync(out, img.toPNG());
          gateLog(`[gate] chat shot -> ${out} ${img.getSize().width}x${img.getSize().height}`);
        } catch (e) { gateLog(`[gate] chat shot failed: ${e.message}`); }
      }, 1500);
    });
  }
}

// ---------- 托盘 ----------
function makeTrayIcon() {
  const { nativeImage } = require("electron");
  const S = 32, cx = (S - 1) / 2, cy = (S - 1) / 2, r = 13;
  const buf = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r * r) {
        buf[i] = 236; buf[i + 1] = 108; buf[i + 2] = 152; buf[i + 3] = 255; // 蕾米莉亚粉
      }
    }
  }
  return nativeImage.createFromBuffer(buf, { width: S, height: S });
}

// 托盘菜单拆成"可重建"：番茄钟/提醒的开关状态要能立刻反映到勾选上，
// 而托盘对象本身只建一次（重复 new Tray 会多出一个图标）。
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: "和蕾米莉亚聊天", click: () => openChat() },
    {
      label: "显示 / 隐藏",
      click: () => {
        if (win.isVisible()) {
          petHidden = true;
          win.hide();
          if (bubbleWin && !bubbleWin.isDestroyed()) bubbleWin.hide();
        } else {
          petHidden = false;
          win.showInactive();
        }
      }
    },
    { type: "separator" },
    {
      label: "让它表演一个",
      submenu: [
        { label: "扇着翅膀飞一段（横向移动）", click: () => win.webContents.send("pet:action", "fly") },
        { label: "展翅飞起来（扇翅膀）", click: () => win.webContents.send("pet:action", "float") },
        { label: "去屏幕边上偷看你", click: () => win.webContents.send("pet:action", "peek") },
        { label: "飞到屏幕顶上盘旋", click: () => win.webContents.send("pet:action", "flyTop") },
        { label: "比猫耳朵", click: () => win.webContents.send("pet:action", "neko") },
        { label: "挥爪子", click: () => win.webContents.send("pet:action", "paw") },
        { label: "打个滚", click: () => win.webContents.send("pet:action", "roll") }
      ]
    },
    { type: "separator" },
    {
      label: "窗口置顶",
      type: "checkbox",
      checked: settings.alwaysOnTop,
      click: (item) => {
        settings.alwaysOnTop = item.checked;
        win.setAlwaysOnTop(item.checked, platform.alwaysOnTopLevel());
        if (bubbleWin && !bubbleWin.isDestroyed()) {
          bubbleWin.setAlwaysOnTop(item.checked, platform.alwaysOnTopLevel());
        }
        saveState({ settings });
      }
    },
    {
      label: "安静模式（少冒泡）",
      type: "checkbox",
      checked: settings.quiet,
      click: (item) => {
        settings.quiet = item.checked;
        win.webContents.send("quiet-changed", item.checked);
        saveState({ settings });
      }
    },
    {
      label: "低闪烁模式（省电）",
      type: "checkbox",
      checked: settings.lowFlash,
      click: (item) => {
        settings.lowFlash = item.checked;
        win.webContents.send("lowflash-changed", item.checked);
        saveState({ settings });
        gateLog(`[perf] lowFlash=${item.checked}`);
      }
    },
    {
      label: "开机自启",
      type: "checkbox",
      checked: platform.getLoginItem(),
      click: (item) => platform.setLoginItem(item.checked)
    },
    { label: "AI 设置（agnes / 自定义）", click: () => shell.openPath(aiConfig.pathOf(app.getPath("userData"))) },
    {
      label: "小闹钟",
      submenu: [
        {
          label: "整点报时",
          type: "checkbox",
          checked: !!(reminders && reminders.state.hourlyChime),
          click: (item) => reminders && reminders.set({ hourlyChime: item.checked })
        },
        {
          label: "起身喝水提醒",
          type: "checkbox",
          checked: !!(reminders && reminders.state.waterMin > 0),
          click: (item) => reminders && reminders.set({
            waterMin: item.checked ? 50 : 0
          })
        },
        { type: "separator" },
        {
          label: (() => {
            const s = reminders ? reminders.status() : { running: false };
            return s.running
              ? `番茄钟：${s.phase === "focus" ? "专注" : "休息"}中，还剩 ${s.leftMin} 分钟`
              : "番茄钟：开始专注 25 分钟";
          })(),
          click: () => {
            if (!reminders) return;
            if (reminders.status().running) reminders.stopPomodoro();
            else reminders.startPomodoro();
            createTray();
          }
        },
        { type: "separator" },
        {
          label: "夜间静音时段（23:00–08:00）",
          type: "checkbox",
          checked: !!(reminders && reminders.state.quietOn),
          click: (item) => reminders && reminders.set({ quietOn: item.checked })
        }
      ]
    },
    { type: "separator" },
    {
      label: "尺寸",
      submenu: [
        { label: "小一点", click: () => resizePet(Math.round(BASE_H * 0.7)) },
        { label: "默认（放大一倍）", click: () => resizePet(BASE_H) },
        { label: "再大一点", click: () => resizePet(Math.round(BASE_H * 1.35)) }
      ]
    },
    { type: "separator" },
    { label: "退出", click: () => app.quit() }
  ]);
}

function createTray() {
  if (tray) { tray.setContextMenu(buildTrayMenu()); return; }
  tray = new Tray(platform.trayIconPath() || makeTrayIcon());
  tray.setToolTip("蕾米莉亚桌宠");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", () => openChat()); // Windows 左键单击托盘直接开聊
}

// 右键宠物本体弹出的快捷菜单（自绘窗口）
// 原生 Menu.popup 在这个窗口上弹不出来：宿主是 WS_EX_NOACTIVATE + toolbar 的不可激活
// 窗口，菜单拿不到前台权，TrackPopupMenu 一调用就自己收了（实测连 #32768 菜单窗口都
// 没出现）—— 这就是"右键没反应"的真因。改成自绘：独立无边框小窗，贴着她弹，失焦即收。
let menuWin = null;
// 7 项 + 1 条分隔线 + 面板内边距，实测内容高约 196px。窗口给到 260 留足余量，
// 面板本身按内容自适应并贴底对齐（见 menu.html），多出来的高度是透明的 ——
// 既不会把最后一项「退出」裁掉，也不会多出一截空白面板。
// 6 项 + 1 条分隔线 + 面板内边距。面板本身按内容自适应高度、底部对齐，
// 这里给窗口留足余量 —— 永远不会裁掉最末的「退出」项。
const MENU_W = 156, MENU_H = 232;

function closePetMenu() {
  if (menuTopWatch) { clearInterval(menuTopWatch); menuTopWatch = null; }
  menuHealTries = 0;
  if (menuWin && !menuWin.isDestroyed()) menuWin.destroy();
  menuWin = null;
}

// 菜单窗口的置顶自愈。跟气泡是同一个坑：透明窗第一次合成时，Chromium 会重刷
// 扩展样式、把 WS_EX_TOPMOST 抹掉，于是菜单"visible=true focused=true"却看不见
// ——被底下的窗口盖住了。菜单只活 12 秒，没有自愈就等于一直不可见。
let menuTopWatch = null;
let menuHealTries = 0;
function healMenuTopmost(force) {
  if (!menuWin || menuWin.isDestroyed()) return;
  if (!force && menuWin.isAlwaysOnTop()) { menuHealTries = 0; return; }
  menuWin.setAlwaysOnTop(false);
  setTimeout(() => {
    if (!menuWin || menuWin.isDestroyed()) return;
    menuWin.setAlwaysOnTop(true, platform.alwaysOnTopLevel());
    const ok = menuWin.isAlwaysOnTop();
    if (!ok && menuHealTries < 6) {
      menuHealTries++;
      setTimeout(() => healMenuTopmost(true), 120);
    } else {
      if (menuHealTries || force) gateLog(`[input] menu topmost ok=${ok} tries=${menuHealTries}`);
      menuHealTries = 0;
    }
  }, 40);
}

function showPetContextMenu(x, y) {
  if (!win || win.isDestroyed()) return;
  if (menuWin && !menuWin.isDestroyed()) { closePetMenu(); return; }   // 再按一次右键收起
  const px = Number.isFinite(x) ? x : 0;
  const py = Number.isFinite(y) ? y : 0;
  const d = screen.getDisplayNearestPoint({ x: px, y: py });
  const wa = d.workArea;
  // 优先弹在光标的左上（她常驻右下角），越界自动夹回工作区
  const mx = Math.round(Math.max(wa.x + 6, Math.min(wa.x + wa.width - MENU_W - 6, px - MENU_W + 14)));
  const my = Math.round(Math.max(wa.y + 6, Math.min(wa.y + wa.height - MENU_H - 6, py - MENU_H + 20)));
  menuWin = new BrowserWindow({
    width: MENU_W,
    height: MENU_H,
    x: mx,
    y: my,
    ...platform.windowTypeOptions(),   // 工具窗口：不进任务栏、不进 Alt+Tab
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, "menu-preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  menuWin.setAlwaysOnTop(true, platform.alwaysOnTopLevel());
  menuWin.loadFile(path.join(__dirname, "renderer", "menu.html"));
  menuWin.webContents.on("did-finish-load", () => {
    if (!menuWin || menuWin.isDestroyed()) return;
    healMenuTopmost(true);
    // 菜单活着的这段时间里每 400ms 摸一次顶置位；已经是 TOPMOST 就立刻返回，
    // 只有真丢了才动样式 —— 不会造成通知区抖动。
    menuTopWatch = setInterval(() => healMenuTopmost(false), 400);
    gateLog(`[input] menu shown visible=${menuWin.isVisible()} focused=${menuWin.isFocused()}`);
  });
  // 取证：把菜单窗口本身截下来，核对 7 项有没有被裁（透明窗只能 capturePage）
  if (process.env.PET_MENU_SHOT) {
    const out = process.env.PET_MENU_SHOT;
    setTimeout(async () => {
      if (!menuWin || menuWin.isDestroyed()) return;
      try {
        const img = await menuWin.capturePage();
        fs.writeFileSync(out, img.toPNG());
        gateLog(`[gate] menu shot -> ${out}`);
      } catch (e) { gateLog(`[gate] menu shot failed: ${e.message}`); }
    }, 900);
  }
  // 测试态不禁用 blur 的话，外部截屏工具一激活控制台就会把菜单关掉，根本抓不到。
  if (!process.env.PET_TEST_MENU) {
    menuWin.on("blur", closePetMenu);
    setTimeout(() => closePetMenu(), 12000);   // 兜底：别留一个关不掉的菜单
  }
  menuWin.on("closed", () => { menuWin = null; });
  gateLog(`[input] pet menu at ${mx},${my}`);
}

// ---------- 页面避让监视器 ----------
// 用户诉求：只要前台窗口是"别的程序/页面"（不是蕾米莉亚自己，也不是她的对话·菜单·气泡窗），
// 她就从屏幕边悄悄探出大半身子看着你干啥，留一大半在屏幕里、不会"不见了"；
// 那个窗口关掉 / 回到桌面，或你点她一下，她就立刻滑回来。
// 判定：前台窗口所属进程是不是我们自己的 exe（所有 Electron 窗口同属一个 exe），
// 桌面/任务栏(Progman/WorkerW/Shell_TrayWnd) 也视为"安全"，不躲。
// 实现：PowerShell 自带、无需 Python/原生编译；常驻轮询前台窗口，只输出布尔事件(WIN 1/0)。
const WIN_WATCH_PS = `$code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WU {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
'@
Add-Type $code
$our = $env:REMILIA_EXE
$last = $null
while ($true) {
  $hwnd = [WU]::GetForegroundWindow()
  $hide = $false
  if ($hwnd -ne [IntPtr]::Zero) {
    $cls = New-Object System.Text.StringBuilder 256
    [void][WU]::GetClassName($hwnd, $cls, 256)
    $c = $cls.ToString()
    $wpid = 0
    [void][WU]::GetWindowThreadProcessId($hwnd, [ref]$wpid)
    $path = ""
    if ($wpid -gt 0) { try { $p = Get-Process -Id $wpid -ErrorAction SilentlyContinue; if ($p) { $path = $p.Path } } catch {} }
    if ($c -eq "Progman" -or $c -eq "WorkerW" -or $c -eq "Shell_TrayWnd") { $hide = $false }
    elseif ($path -and $our -and $path.Equals($our, [StringComparison]::OrdinalIgnoreCase)) { $hide = $false }
    else { $hide = $true }
  }
  if ($hide -ne $last) { $last = $hide; [Console]::Out.WriteLine(("WIN " + $(if($hide){1}else{0}))); [Console]::Out.Flush() }
  Start-Sleep -Milliseconds 300
}
`;

let winWatch = null;
function startWinWatch() {
  if (process.platform !== "win32" || !win || win.isDestroyed()) return;
  let tmp;
  try {
    tmp = path.join(app.getPath("temp"), "remilia-win-watch.ps1");
    fs.writeFileSync(tmp, WIN_WATCH_PS, { encoding: "utf8" });
  } catch (e) { gateLog(`[winwatch] write fail ${e}`); return; }
  let child;
  try {
    child = spawn("powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tmp],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        env: Object.assign({}, process.env, { REMILIA_EXE: process.execPath }) });
  } catch (e) { gateLog(`[winwatch] spawn fail ${e}`); return; }
  winWatch = child;
  gateLog(`[winwatch] started (our exe=${process.execPath})`);
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.indexOf("WIN ") === 0) onWinHide(line.split(" ")[1] === "1");
    }
  });
  child.stderr.on("data", (d) => gateLog(`[winwatch] ${String(d).trim()}`));
  child.on("exit", (c) => { gateLog(`[winwatch] exited ${c}`); if (winWatch === child) winWatch = null; });
  child.on("error", (e) => gateLog(`[winwatch] spawn err ${e}`));
  app.on("before-quit", () => { try { child.kill(); } catch (e) {} });
}

let pageHidden = false, pageUserReleased = false;
function onWinHide(on) {
  if (!win || win.isDestroyed()) return;
  gateLog(`[winwatch] hide=${on}`);
  pageHidden = on;
  if (!on) pageUserReleased = false;   // 页面关了/回到桌面：彻底复位
  const desired = pageHidden && !pageUserReleased;
  if (win && !win.isDestroyed()) win.webContents.send("pet:pagehide", { on: desired });
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.on("renderer-ready", (_e, payload) => {
    gateReady = true;
    gateLog(`[gate] G1 PASS frames=${JSON.stringify(payload && payload.frames)} ` +
            `renderer=${payload && payload.renderer} webgl=${payload && payload.webgl}`);
    startWinWatch();
  });
  ipcMain.on("renderer-error", (_e, payload) => {
    gateLog(`[gate] G1 FAIL ${JSON.stringify(payload)}`);
  });
  // 窗口移动：渲染进程按像素变化下发，可能一秒 60 条；这里累积后每 16ms 合并成
  // 一次 setBounds。逐条 setBounds 会让 DWM 每秒重排 60 次窗口，是画面/光标闪烁的主要来源。
  let pendingDX = 0, pendingDY = 0, moveTimer = null;
  function flushMove() {
    moveTimer = null;
    if (!win || win.isDestroyed()) return;
    const dx = pendingDX, dy = pendingDY;
    pendingDX = 0; pendingDY = 0;
    if (!dx && !dy) return;
    // PET_NO_MOVE=1 仅用于排查：跳过窗口位移，验证"移动是否导致窗口长大"
    if (process.env.PET_NO_MOVE === "1") return;
    // 关键：每次都把**已知正确的尺寸**一起显式写回去，绝不从 getBounds() 读。
    // 实测这个透明 + toolbar + noactivate 的窗口，每次 setPosition 都会把 DWM 的
    // 边框/阴影多算一点进 bounds（每次约 1 像素），而 getBounds() 又把这个膨胀值
    // 当权威值回写 —— 移动越快窗口越大（漂浮 4 秒从 170×40 涨到 200×82，
    // 也就是用户说的"会变大"）。钉住 expectedSize 就等于每帧自愈一次。
    const b = win.getBounds();
    const nx = Math.round(b.x + dx), ny = Math.round(b.y + dy);
    win.setBounds({ x: nx, y: ny, width: expectedSize.w, height: expectedSize.h });
    // 气泡窗口独立合成，必须显式跟着挪（同一次 tick 内下发，DWM 同一帧合成，看不出缝）
    if (bubbleWin && !bubbleWin.isDestroyed() && bubbleWin.isVisible()) {
      const g = bubbleGeometry({ x: nx, y: ny, width: expectedSize.w, height: expectedSize.h });
      bubbleWin.setBounds({ x: g.x, y: g.y, width: g.w, height: g.h });
    }
  }
  ipcMain.on("window:moveBy", (_e, dx, dy) => {
    if (!win || win.isDestroyed()) return;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    pendingDX += Math.round(dx);
    pendingDY += Math.round(dy);
    if (!moveTimer) moveTimer = setTimeout(flushMove, MOVE_FLUSH_MS);
  });
  ipcMain.handle("window:getMoveBounds", () => {
    const d = screen.getPrimaryDisplay();
    return { win: win.getBounds(), work: d.workArea };
  });
  // 物理/漂浮/攀爬需要窗口位置与所在显示器工作区
  ipcMain.handle("env:get", () => {
    if (!win) return null;
    const b = win.getBounds();
    const d = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    return { win: b, work: d.workArea };
  });
  ipcMain.on("window:setSize", (_e, pt) => resizePet(pt));
  // 气泡：角色窗口的渲染进程决定说什么，主进程负责画到独立的气泡窗口里
  ipcMain.on("pet:bubble", (_e, payload) => {
    const text = payload && payload.text;
    if (!text) return;
    showBubbleText(text, payload.ms);
  });
  ipcMain.on("pet:contextmenu", (_e, x, y) => showPetContextMenu(x, y));
  // 页面避让：渲染器说"用户点她一下把她叫回来了"，主进程标记已主动放行，
  // 直到那个页面真正关闭（WIN 0）才复位，避免她又立刻缩回去。
  ipcMain.on("pet:pageclick", () => {
    if (pageHidden && !pageUserReleased) {
      pageUserReleased = true;
      if (win && !win.isDestroyed()) win.webContents.send("pet:pagehide", { on: false });
      gateLog("[winwatch] user clicked pet -> released");
    }
  });
  ipcMain.on("menu:close", () => closePetMenu());
  ipcMain.on("menu:action", (_e, act) => {
    closePetMenu();
    const send = (a) => { if (win && !win.isDestroyed()) win.webContents.send("pet:action", a); };
    if (act === "chat") return openChat();
    if (act === "sleep") { if (win && !win.isDestroyed()) win.webContents.send("pet:sleep"); return; }
    if (act === "hide") {
      petHidden = true;
      if (win && !win.isDestroyed()) win.hide();
      if (bubbleWin && !bubbleWin.isDestroyed()) bubbleWin.hide();
      return;
    }
    if (act === "quit") return app.quit();
    // float / neko / roll 等动作全部走和托盘菜单相同的通道
    send(act);
  });
  ipcMain.handle("settings:get", () => settings);
  ipcMain.handle("app:onboarded", () => !!loadState().onboarded);
  ipcMain.on("app:onboarded", () => saveState({ onboarded: true }));

  // ---- 对话 ----
  ipcMain.handle("chat:open", () => { openChat(); return true; });  ipcMain.handle("chat:history", () => history);
  ipcMain.handle("chat:clear", () => { history = []; saveHistory(); return true; });
  ipcMain.handle("chat:send", async (_e, text) => {
    const cfg = aiConfig.load(app.getPath("userData"));
    const userMsg = { role: "user", text: String(text || "").slice(0, 500), at: Date.now() };
    history.push(userMsg);
    const out = await brain.reply(app.getPath("userData"), cfg, userMsg.text, history);
    const petMsg = { role: "pet", text: out.text, mood: out.mood, at: Date.now() };
    history.push(petMsg);
    saveHistory();
    // 让桌宠本体同步说话、做动作
    if (win && !win.isDestroyed()) win.webContents.send("pet:say", { text: out.text, mood: out.mood });
    if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send("chat:reply", petMsg);
    return petMsg;
  });
  ipcMain.handle("ai:config:get", () => {
    const cfg = aiConfig.load(app.getPath("userData"));
    return { ...cfg, apiKey: cfg.apiKey ? "****" + cfg.apiKey.slice(-4) : "" };
  });
  ipcMain.handle("ai:config:set", (_e, patch) => {
    const clean = { ...(patch || {}) };
    // 面板回传的是脱敏串（"****abcd"）。不处理的话一保存就把真 Key 覆盖成星号，
    // 用户会莫名其妙地"昨天还能聊，今天就不行了"。
    if (typeof clean.apiKey === "string" && clean.apiKey.startsWith("****")) delete clean.apiKey;
    const saved = aiConfig.save(app.getPath("userData"), clean);
    return { ...saved, apiKey: saved.apiKey ? "****" + saved.apiKey.slice(-4) : "" };
  });
  ipcMain.handle("ai:config:test", async (_e, patch) => {
    const clean = { ...(patch || {}) };
    if (typeof clean.apiKey === "string" && clean.apiKey.startsWith("****")) delete clean.apiKey;
    const merged = { ...aiConfig.load(app.getPath("userData")), ...clean };
    const r = await brain.testConnection(merged);
    gateLog(`[ai] test ok=${r.ok} ${r.ok ? "ms=" + r.ms : (r.reason || "")}`);
    return r;
  });
  ipcMain.handle("ai:config:open", () => {
    shell.openPath(aiConfig.pathOf(app.getPath("userData")));
    return true;
  });

  // G4 取证：截取宠物窗口存到 userData
  ipcMain.handle("app:capture", async () => {
    if (!win) return null;
    try {
      const img = await win.capturePage();
      const p = path.join(app.getPath("userData"), "pet-capture.png");
      fs.writeFileSync(p, img.toPNG());
      return p;
    } catch { return null; }
  });
}

// ---------- 应用生命周期 ----------
// PET_ALLOW_MULTI 仅用于验收：上一个验证实例偶尔会因为权限原因杀不掉、
// 一直占着单实例锁，导致新代码根本起不来（只能测到旧版本）。设了这个变量
// 就跳过单实例锁，起一个并行的独立实例；正式运行不设它。
const gotLock = process.env.PET_ALLOW_MULTI === "1" ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // 她已经在跑了，用户又双击了一次图标 —— 以前这里什么也不做，新进程静默退出，
  // 用户的体感是"双击没反应，坏了"。现在把藏起来的她叫回屏幕，顺便冒句台词。
  app.on("second-instance", () => {
    if (!win || win.isDestroyed()) return;
    petHidden = false;
    win.showInactive();
    if (settings.alwaysOnTop) {
      win.setAlwaysOnTop(false);
      setTimeout(() => {
        if (win && !win.isDestroyed() && settings.alwaysOnTop) {
          win.setAlwaysOnTop(true, platform.alwaysOnTopLevel());
        }
      }, 40);
    }
    showBubbleText("我在这儿呢～一直没走");
    gateLog("[gate] second-instance: brought the pet back to screen");
  });
  app.whenReady().then(() => {
    const st = loadState();
    if (st.settings && typeof st.settings === "object") {
      settings = { ...settings, ...st.settings };
    }
    // v1 -> v2：老版本没有低闪烁开关，默认补上（保留用户既有的穿透/安静偏好）
    if ((st.settingsVersion || 1) < SETTINGS_VERSION) {
      settings.lowFlash = true;
      saveState({ settings, settingsVersion: SETTINGS_VERSION });
    }
    loadHistory();
    // 首次运行即落配置文件，方便托盘「AI 设置」直接打开
    aiConfig.load(app.getPath("userData"));
    gateLog(`[gate] app starting ${app.getVersion()}`);
    gateLog(`[gate] test-env force=${process.env.PET_FORCE_STATE || "-"} ` +
            `say=${process.env.PET_SAY ? "yes" : "-"} shot=${process.env.PET_SHOT ? "yes" : "-"} ` +
            `bubbleShot=${process.env.PET_BUBBLE_SHOT ? "yes" : "-"} menuShot=${process.env.PET_MENU_SHOT ? "yes" : "-"}`);
    gateLog(`[gate] userData: ${app.getPath("userData")}`);
    gateLog(`[gate] ai-config: ${aiConfig.pathOf(app.getPath("userData"))}`);

    // 验收用：PET_LOGIN_TEST=on|off 只改开机自启写盘结果然后立刻退出，
    // 便于在命令行里核对注册表到底有没有被写对（不需要留着窗口观察）。
    if (process.env.PET_LOGIN_TEST) {
      const mode = process.env.PET_LOGIN_TEST;
      if (mode === "on") platform.setLoginItem(true);
      if (mode === "off") platform.setLoginItem(false);
      gateLog(`[login] mode=${mode} getLoginItem=${platform.getLoginItem()} ` +
              `packaged=${app.isPackaged} exe=${process.execPath} ` +
              `args=${app.isPackaged ? "-" : app.getAppPath()}`);
      setTimeout(() => app.quit(), 300);
      return;
    }

    registerIpc();
    createWindow();
    initReminders();          // 必须在 createTray 之前：托盘的勾选状态要读它
    createTray();
    startPeekHintWatch();
    startBubbleTopWatch();
    warmUpBubble();
  });

  app.on("window-all-closed", () => {
    // 桌宠常驻：关窗不退出，从托盘退出
  });
}
