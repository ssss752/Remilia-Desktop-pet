// renderer.js — 蕾米莉亚：帧动画引擎 + 状态机 + 气泡 + 拖拽物理 + 漂浮/攀爬/撒娇 + AI 对话联动。
(() => {
  const cfgUrl = new URL("./config.json", location.href);
  const stage = document.getElementById("stage");
  const petEl = document.getElementById("pet");   // 角色本体（占满整个窗口）：形变只作用于它
  const imgA = document.getElementById("frameA");
  const imgB = document.getElementById("frameB");
  let showLayer = imgA, hideLayer = imgB;

  // ---- Live2D 式网格变形渲染（无 WebGL 时回退 <img>，保证永远能启动） ----
  const glCanvas = document.getElementById("gl");
  const live = (window.Live2DPet && glCanvas) ? new Live2DPet(glCanvas) : null;
  const useLive = !!(live && live.init());
  if (useLive) { imgA.style.display = "none"; imgB.style.display = "none"; }
  let mouseNX = 0.5, mouseNY = 0.5;   // 归一化鼠标（头部跟随）
  let frameDir = 1;                   // 往复播放方向
  const ENERGY = { idle: 0.7, fly: 1.25, float: 1.0, sleep: 0.35,
    drag: 1.3, greet: 1.0, interact: 1.0, neko: 1.0, paw: 1.15, fall: 1.1,
    pout: 0.8, roll: 1.2, drop: 0.9, peek: 0.6, crouch: 0.55 };

  let config = null;
  const frames = {};   // state -> [Image...]
  const lines = {};    // state -> [string...]
  let state = "idle";
  let frameIdx = 0;
  let lastFrameAt = 0;
  let lastTick = performance.now();
  let flyRemain = 0;
  let sleepSince = performance.now();
  let lastBubbleAt = 0;
  let sleepEnteredAt = 0;
  let quiet = false;
  let flyDir = 1;
  const reducedMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  // ---------- 物理状态 ----------
  const ph = {
    x: 0, y: 0, sentX: 0, sentY: 0, w: 128, h: 128,
    vx: 0, vy: 0, groundY: 0, work: null, airborne: false, ready: false
  };
  let dragging = false, pressed = false;
  let pointerVel = { x: 0, y: 0, t: performance.now() };
  let tilt = 0, squashAt = -1;

  // 角色在窗口里靠左，且占一个正方形 —— 角色宽度恒等于窗口高度。
  // 水平边界必须按**角色**算而不是按窗口算：窗口右侧那一大截是气泡区，
  // 按窗口算的话她永远走不到屏幕右边缘，攀爬也会离边缘差一大截。
  function petWidth() { return ph.h; }
  function workRight() {
    return ph.work ? ph.work.x + ph.work.width - petWidth() : 1e9;
  }

  // ---------- 行为调度 ----------
  let floatCtl = null;   // { until, phase, drift }
  let peekCtl = null;    // { side, phase, stayUntil, targetX, landState }
  let retreating = false, retreatTarget = null;  // 全屏避让（旧）：平移到最近边角等待
  let pageHiding = false;                        // 页面避让：前台是别的窗口时滑到屏幕边藏着
  let peekCaughtUntil = 0;   // 刚被抓包的冷却窗：这段时间里不许节拍器换动作
  let landingUntil = 0;      // 落地后抱头蹲防的停留截止时间（到了才起身回 idle）
  let riseAt = -1;           // 起身瞬间的时间戳：复用 squash 通道做负值（竖向拉伸）

  // 动作节拍器：每个动作（含散步/飞行/扒边偷看）停留满 15 秒再换下一个，
  // 左键点击可以立刻打断切下一个。用「洗牌袋」保证轮换不连续重复。
  const ACTION_POOL = ["idle", "fly", "neko", "float", "paw", "interact", "flyTop", "roll", "pout", "peek"];
  let ACTION_MS = 15000;      // 动作保持时长，启动时用 config.behaviors.actionHoldMs 覆盖
  let actionUntil = 0;
  let actionBag = [];

  const randRange = (r) => (Array.isArray(r) ? r[0] + Math.random() * (r[1] - r[0]) : r);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------- 素材加载与 G1/G2 运行时校验 ----------
  // 支持「帧目录别名」：某些状态不需要新素材，只是换一套控制逻辑去演同一批帧。
  // 例：peek（扒着屏幕边缘偷看）直接复用 grip 的「双手抓边」帧 —— 重新解一遍
  // 同一批 512x512 图纯属浪费显存，所以加载时先跳过别名状态，最后再指过去。
  async function loadAll() {
    const states = Object.keys(config.animations);
    const aliasOf = {};
    for (const st of states) {
      const sp = config.animations[st];
      if (sp && sp.frames) aliasOf[st] = sp.frames;
    }
    const real = states.filter((st) => !aliasOf[st]);
    const report = {};
    let ok = true;
    for (const st of real) {
      const list = [];
      let i = 0;
      while (true) {
        const url = new URL(`../../assets/pet/${st}/frame_${String(i).padStart(3, "0")}.png`, location.href);
        try {
          const img = await loadImage(url.href);
          if (!img.naturalWidth || img.naturalWidth <= 0) throw new Error("naturalWidth=0");
          if (img.naturalWidth !== config.canvas.width) throw new Error(`size ${img.naturalWidth}!=${config.canvas.width}`);
          list.push(img);
          i++;
          if (i > 64) break;
        } catch { break; }
      }
      if (list.length === 0) {
        const fb = await loadImage(new URL("../../assets/fallback/pet.svg", location.href).href);
        list.push(fb);
        ok = false;
        report[st] = "fallback";
      } else {
        report[st] = list.length;
      }
      frames[st] = list;
    }
    // 别名状态：直接指向已加载的帧数组（同一个 Image 对象，零额外解码）
    for (const st of Object.keys(aliasOf)) {
      const src = aliasOf[st];
      frames[st] = frames[src] || frames.idle || [];
      report[st] = "alias:" + src;
      if (!frames[st].length) { ok = false; report[st] = "alias-missing:" + src; }
    }
    const lang = (config && config.language) || "zh";
    const suffix = lang === "en" ? "_en" : "";
    for (const st of states) {
      try {
        const res = await fetch(new URL(`../../assets/bubbles/${st}${suffix}.txt`, location.href));
        if (res.ok) {
          lines[st] = (await res.text()).split("\n").map((s) => s.trim()).filter(Boolean);
        }
      } catch { /* 无台词也可运行 */ }
    }
    if (ok) window.petAPI.rendererReady({ frames: report, configVersion: config.version, renderer: useLive ? "webgl-live2d" : "img", webgl: useLive });
    else window.petAPI.rendererError({ frames: report, reason: "some states missing, fallback engaged" });
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("load fail"));
      img.src = url;
    });
  }

  // ---------- 帧播放 ----------
  // Live2D 路径：硬切帧（帧内绝不叠化，否则 180ms 叠化 > 125ms 帧间隔 = 永久重影=「糊」）。
  // 回退路径：保留 crossfade，但仅在状态切换时调用（帧内推进见 tick，同样硬切）。
  function showFrame(img, fade) {
    if (useLive) { live.setFrame(img); return; }
    if (!fade) { showLayer.src = img.src; showLayer.style.opacity = 1; return; }
    if (showLayer.src === img.src) { showLayer.style.opacity = 1; return; }
    hideLayer.src = img.src;
    hideLayer.style.opacity = 0;
    hideLayer.classList.remove("hidden");
    const from = showLayer, to = hideLayer;
    requestAnimationFrame(() => { to.style.opacity = 1; from.style.opacity = 0; });
    showLayer = to; hideLayer = from;
  }

  // 帧推进：loop 且 pingpong 的状态做往复播放（1→2→3→4→3→2），消除循环首尾跳变，更连贯。
  // 非 loop 的一次性动作（比猫耳/挥爪/打滚…）播完**停在最后一帧**，不自动回 idle ——
  // 由动作节拍器在 15s 后统一换下一个。停在末帧时 Live2D 的呼吸/摇摆/眨眼仍在跑，
  // 所以看着是「保持这个姿势轻轻呼吸」，不是卡住。
  function advanceFrame(spec, len) {
    if (spec.pingpong && spec.loop && len > 2) {
      frameIdx += frameDir;
      if (frameIdx >= len) { frameIdx = len - 2; frameDir = -1; }
      else if (frameIdx < 0) { frameIdx = 1; frameDir = 1; }
    } else {
      frameIdx++;
      if (frameIdx >= len) {
        if (spec.loop) frameIdx = 0;
        else frameIdx = len - 1;      // 停末帧，等节拍器
      }
    }
  }

  // 头部跟随鼠标（Live2D 参数）
  document.addEventListener("mousemove", (e) => {
    mouseNX = e.clientX / Math.max(1, window.innerWidth);
    mouseNY = e.clientY / Math.max(1, window.innerHeight);
  });

  // ---------- 状态机 ----------
  const PRIORITY = {
    greet: 4, interact: 4, neko: 4, paw: 4, pout: 4, roll: 4,
    drop: 3, fall: 3, crouch: 3,
    drag: 2, peek: 2,
    fly: 1, float: 1,
    idle: 0,
    sleep: -1
  };
  function canInterrupt(cur, next) {
    if (cur === next) return true;
    // 抓起永远是最高优先：优先级表里 drag 只有 2，比蹲防(3)、打招呼(4)都低，
    // 结果就是"她正蹲着的时候抓起来，画面不变，松手才变成被拎着"（用户实测反馈）。
    // 鼠标按下去拖起来是主人的直接操作，没有任何动作有资格拒绝它 —— 这里特判，
    // 而不是把 drag 提到 9，因为 PRIORITY 还参与别处的"谁该让位给谁"判断。
    if (next === "drag") return true;
    return (PRIORITY[next] ?? 0) >= (PRIORITY[cur] ?? 0);
  }

  function setState(next) {
    const spec = config.animations[next];
    if (!spec) return;
    if (state !== next) {
      // 离开某个状态时清理它的控制器
      if (state === "float" && next !== "float") { floatCtl = null; flyFlap = 0; }
      if (state === "peek" && next !== "peek") peekCtl = null;
      state = next;
      frameIdx = 0;
      frameDir = 1;
      lastFrameAt = 0;
      if (next === "fly" && flyRemain <= 0) flyRemain = 2000 + Math.random() * 3000;
      // 落地：hard landing（fall）蹲得更久，普通落地（drop）蹲一小会儿。
      // 这段时间里她保持抱头蹲防，不会被 15s 节拍器拽走。
      if (next === "drop" || next === "fall" || next === "crouch") {
        const lb = (config.behaviors && config.behaviors.landing) || {};
        const hold = next === "fall" ? (lb.hardHoldMs || 3400) : (lb.crouchHoldMs || 2200);
        landingUntil = performance.now() + hold;
        console.log(`[land] ${next} -> crouch, hold ${hold}ms`);
      } else {
        landingUntil = 0;
      }
      if (next === "idle") sleepSince = performance.now();
      if (next === "sleep") {
        sleepEnteredAt = performance.now();
        actionUntil = performance.now() + 3600e3;   // 睡下就不再按 15s 节拍换动作
        showBubble("Zzz…");
      }
      else if (lines[next] && lines[next].length) showBubble(pick(lines[next]));
    }
  }

  // ---------- 动作节拍 ----------
  function shuffleBag() {
    actionBag = ACTION_POOL.filter((s) => frames[s] && frames[s].length);
    if (!actionBag.length) return;
    for (let i = actionBag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = actionBag[i]; actionBag[i] = actionBag[j]; actionBag[j] = t;
    }
    if (actionBag[0] === state && actionBag.length > 1) {
      const t = actionBag[0]; actionBag[0] = actionBag[1]; actionBag[1] = t;
    }
  }

  function applyAction(name) {
    actionUntil = performance.now() + ACTION_MS;
    if (name === "float") { startFloat(ACTION_MS, {}); return; }
    if (name === "flyTop") { startFloat(ACTION_MS, { toTop: true }); return; }
    if (name === "peek") { startPeek(); return; }
    if (name === "fly") {
      flyDir = Math.random() < 0.5 ? -1 : 1;
      flyRemain = ACTION_MS;
    }
    setState(name);
  }

  function nextAction() {
    if (!config) return;
    if (!actionBag.length) shuffleBag();
    if (!actionBag.length) return;
    applyAction(actionBag.shift());
  }

  // 唤醒（双击 / 托盘）后重新起节拍，否则会立刻被节拍器切走
  function wakeUp(stateName) {
    setState(stateName || "greet");
    actionUntil = performance.now() + ACTION_MS;
  }

  // ---------- 悬浮：她是飞行生物，常态不踩地 ----------
  // 「离桌面一段小高度巡航」这件事必须只有一份真值，否则到处判断会互相打架。
  // 约定：ph.y 仍是窗口左上角；restY() 是"她现在该待的 y"。
  //   hoverNow 平滑趋近 hoverTarget()，所以起飞/落地都是缓的，不会瞬移。
  // 只有两种情况会把 restY() 压回真正的地面：坠落中、以及正在蹲防/睡觉/被拖。
  let hoverNow = 0;                       // 当前离地高度（DIP），平滑值
  function flyHoverPx() {
    const f = (config.behaviors && config.behaviors.fly) || {};
    return f.hoverHeight != null ? f.hoverHeight : 12;
  }
  function hoverTarget() {
    if (dragging || ph.airborne) return 0;
    if (state === "sleep" || state === "crouch" || state === "drop" ||
        state === "fall" || state === "drag") return 0;
    return flyHoverPx();
  }
  function restY() { return ph.groundY - hoverNow; }
  // 巡航高度（不含平滑）：mouseup 判断"是不是在半空松手"要用它
  function cruiseY() { return ph.groundY - flyHoverPx(); }

  // ---------- 位置同步 ----------
  function selfMoving() {
    return dragging || ph.airborne || state === "fly" || state === "float" ||
      state === "peek" || state === "flyTop";
  }
  async function syncEnv() {
    const e = await window.petAPI.getEnv();
    if (!e || !config) return;
    ph.w = e.win.width; ph.h = e.win.height;
    ph.work = e.work;
    ph.groundY = e.work.y + e.work.height - ph.h - (config.behaviors.groundOffsetPx || 0);
    if (!ph.ready) {
      ph.x = e.win.x; ph.y = e.win.y; ph.sentX = e.win.x; ph.sentY = e.win.y; ph.ready = true;
    } else if (!selfMoving()) {
      ph.x = e.win.x; ph.y = e.win.y; ph.sentX = e.win.x; ph.sentY = e.win.y;
    }
  }

  // 浮点累积 + 整数下发，避免每帧取整漂移
  function move(dx, dy) {
    ph.x += dx; ph.y += dy;
    const ix = Math.round(ph.x), iy = Math.round(ph.y);
    const rdx = ix - ph.sentX, rdy = iy - ph.sentY;
    if (rdx || rdy) {
      window.petAPI.moveBy(rdx, rdy);
      ph.sentX = ix; ph.sentY = iy;
    }
  }

  function clampToWorkArea() {
    if (!ph.work) return;
    const left = ph.work.x, right = ph.work.x + ph.work.width - petWidth();
    if (ph.x < left) { ph.x = left; move(0, 0); }
    if (ph.x > right) { ph.x = right; move(0, 0); }
    if (ph.y > ph.groundY) { ph.y = ph.groundY; move(0, 0); }
    if (ph.y < ph.work.y) { ph.y = ph.work.y; move(0, 0); }
  }

  // ---------- 展翅飞行 ----------
  // 「往上飞」必须是翅膀扇出来的，不是整体平移：升力跟着扇翅相位走（每次下扑给一次
  // 升力脉冲），身体朝前进方向微倾，翅膀形变由 live2d 的 wingFlap 驱动（flap 越大振幅
  // 越大、频率越高）。三段式：起飞 → 悬停巡航 → 滑降落地。
  let flyFlap = 0;      // 0..1 扇翅强度，喂给网格形变
  // 两种飞法共用同一套控制器：
  //   float  —— 原地起飞、在离地 hoverHeight 处盘旋；
  //   flyTop —— 一路扇到屏幕顶部再贴着顶边盘旋（这是原来"爬上去"那个动作的替身）。
  // 参数走 opts，不再另开一套状态机 —— 飞行的物理只有一份，改一个地方就够了。
  function startFloat(durationOverride, opts) {
    if (!frames.float || !frames.float.length) return;
    if (ph.airborne || state === "float" || state === "flyTop") return;
    const o = opts || {};
    const f = config.behaviors.float;
    const petH = petWidth();
    const topY = (ph.work ? ph.work.y : 0) + Math.round(petH * (f.topMarginRatio || 0.08));
    floatCtl = {
      until: performance.now() + (durationOverride || randRange(f.durationMs)),
      phase: "ascend",
      hoverY: o.toTop ? topY : ph.groundY - f.hoverHeight,
      drift: (Math.random() < 0.5 ? -1 : 1) * f.driftSpeed,
      flapPhase: 0,
      toTop: !!o.toTop
    };
    flyFlap = 1;
    setState(o.toTop ? "flyTop" : "float");
    if (o.toTop) console.log(`[fly] toTop -> hoverY=${Math.round(floatCtl.hoverY)} (petH=${Math.round(petH)})`);
  }

  function floatStep(dt) {
    const f = config.behaviors.float;
    const now = performance.now();
    if (!floatCtl) { setState("idle"); return; }
    // 扇翅相位与 live2d 的 flapFreq(Hz)=0.9+flap*0.9 保持同频，
    // 这样"翅膀在扇"和"身体被顶上去"是同一件事，不是两段互不相干的动画。
    floatCtl.flapPhase += dt * Math.PI * 2 * (0.9 + flyFlap * 0.9);

    if (floatCtl.phase === "ascend") {
      flyFlap = 1;
      // 升力 = 基础 + 下扑脉冲：高度曲线一跳一跳往上，看得出是翅膀顶起来的
      const pulse = Math.max(0, Math.sin(floatCtl.flapPhase));
      move(0, -(55 + 165 * pulse) * dt);
      if (ph.y <= floatCtl.hoverY) { ph.y = floatCtl.hoverY; floatCtl.phase = "hover"; }
    } else if (floatCtl.phase === "hover") {
      flyFlap = 0.62;
      const bob = Math.sin(floatCtl.flapPhase * 0.5) * (f.bobAmp || 5);
      move(0, (floatCtl.hoverY + bob - ph.y) * Math.min(1, dt * 3.2));
      if (now > floatCtl.until) floatCtl.phase = "descend";
    } else {
      // descend：收翅滑降，落地判定交给 physics
      flyFlap = 0.75;
      move(0, 78 * dt);
      if (ph.y >= ph.groundY - 1) {
        ph.y = ph.groundY;
        ph.airborne = false;
        ph.vy = 0;
        squashAt = now;
        floatCtl = null;
        flyFlap = 0;
        setState("drop");
        actionUntil = now + 2200;          // 落地喘口气再换动作
        return;
      }
    }
    // 横向巡航 + 撞边折返（贴着屏幕飞，不越界）
    let dx = floatCtl.drift * dt;
    if (ph.work) {
      const left = ph.work.x, right = ph.work.x + ph.work.width - petWidth();
      if (ph.x + dx < left) { floatCtl.drift = Math.abs(floatCtl.drift); dx = Math.abs(dx); }
      if (ph.x + dx > right) { floatCtl.drift = -Math.abs(floatCtl.drift); dx = -Math.abs(dx); }
    }
    move(dx, 0);
  }

  // ---------- 屏幕边缘偷看 ----------
  // 「点开别的页面的时候，她把半个身子藏到屏幕外面偷瞄你在干什么，被点破还嘴硬」。
  // 姿势直接复用 grip 那组帧（双手扒着边缘、脸朝前）—— 视觉上就是扒着屏幕边框。
  // 关键是**窗口真的挪到屏幕外**：系统会把屏幕外的部分裁掉，露在里面的才是"半个身子"。
  // 所以 peek 期间必须豁免 clampToWorkArea，否则每一帧都会被拉回工作区里，
  // 变成"贴着边缘站着"而不是"藏了一半"。
  function peekEdgeX(side) {
    if (!ph.work) return ph.x;
    return side === "left" ? ph.work.x : ph.work.x + ph.work.width - petWidth();
  }
  function peekHideX(side) {
    const p = config.behaviors.peek || {};
    const r = p.hideRatio || 0.55;
    return peekEdgeX(side) + (side === "left" ? -petWidth() * r : petWidth() * r);
  }

  function startPeek(opts) {
    if (!frames.peek || !frames.peek.length) return false;
    if (!ph.work || dragging || ph.airborne) return false;
    if (state === "float" || state === "flyTop" || state === "peek") return false;
    const p = config.behaviors.peek || {};
    // 就近躲：她要藏到离自己最近的那条边。跨整个屏幕溜到另一边不但要走二十几秒
    // （toEdge 期间是爬行帧，看着像发神经），也不像"偷看"——偷看是悄悄侧身躲到旁边。
    // 留 20% 换边，保留一点不可预测。
    const leftHide = peekHideX("left"), rightHide = peekHideX("right");
    const nearest = Math.abs(leftHide - ph.x) <= Math.abs(rightHide - ph.x) ? "left" : "right";
    const side = Math.random() < (p.preferNearest ?? 0.8)
      ? nearest
      : (nearest === "left" ? "right" : "left");
    peekCtl = {
      side,
      phase: "toEdge",
      stayUntil: 0,
      targetX: peekHideX(side),
      landState: "idle",
      fast: false
    };
    console.log(`[peek] start side=${side} from x=${Math.round(ph.x)} -> ${Math.round(peekCtl.targetX)}`);
    setState("peek");
    return true;
  }

  // 页面避让：主进程发现前台是"别的窗口/页面"时调用，替代原来的全屏避让。
  // 复用偷看那套"滑到屏幕边、留一大半在屏幕里"的动作，但保持隐藏（held）直到
  // 主进程放行（页面关了 / 回到桌面）或用户点她一下 → 立刻"跳出来"。
  function startPageHide() {
    if (pageHiding) return true;
    if (!frames.peek || !frames.peek.length || !ph.work) return false;
    if (dragging || ph.airborne) return false;
    const p = config.behaviors.peek || {};
    if (state === "peek") {
      // 已经在偷看（自主触发）就顺势转成被页面叫走的常驻藏法
      if (peekCtl) peekCtl.held = true;
      pageHiding = true;
      return true;
    }
    const leftHide = peekHideX("left"), rightHide = peekHideX("right");
    const nearest = Math.abs(leftHide - ph.x) <= Math.abs(rightHide - ph.x) ? "left" : "right";
    const side = Math.random() < (p.preferNearest ?? 0.8)
      ? nearest
      : (nearest === "left" ? "right" : "left");
    peekCtl = {
      side,
      phase: "toEdge",
      stayUntil: 0,
      targetX: peekHideX(side),
      landState: "idle",
      fast: false,
      held: true
    };
    pageHiding = true;
    console.log(`[pagehide] start side=${side} from x=${Math.round(ph.x)} -> ${Math.round(peekCtl.targetX)}`);
    setState("peek");
    return true;
  }

  function endPageHide() {
    if (!pageHiding) return;
    pageHiding = false;
    if (state === "peek" && peekCtl && peekCtl.phase !== "back") {
      peekCtl.phase = "back";
      peekCtl.landState = "idle";
      peekCtl.fast = true;   // 页面关了/点她：立刻滑回来
    }
    console.log("[pagehide] end");
  }

  // 被当场点破：立刻往回收，嘴硬一句。这里**不能**直接 setState —— 那样会清掉
  // peekCtl，人就卡在屏幕外半截，下一帧被 clamp 一拉就是"瞬移"。等收回来再换状态。
  function caughtPeek() {
    if (state !== "peek" || !peekCtl) return false;
    if (peekCtl.phase === "back") return true;
    showBubble("才，才没有想看你在干什么呢！", 4400);
    peekCtl.phase = "back";
    peekCtl.fast = true;
    peekCtl.landState = "pout";
    // 抓包冷却：mouseup 里有一个"200ms 后切下一个动作"的兜底定时器，等它响的时候
    // 她已经是 pout 了，光判 state==="peek" 拦不住 —— 会被拽去攀爬，刚赌气就跑了。
    peekCaughtUntil = performance.now() + 3200;
    console.log(`[peek] caught at x=${Math.round(ph.x)} side=${peekCtl.side}`);
    return true;
  }

  function peekStep(dt) {
    if (!peekCtl || !ph.work) { setState("idle"); return; }
    const p = config.behaviors.peek || {};
    const edgeX = peekEdgeX(peekCtl.side);
    const now = performance.now();

    if (peekCtl.phase === "toEdge") {
      // 溜到边缘：比散步快一点，像"偷偷摸过去"
      const dx = edgeX - ph.x;
      const sp = (p.toEdgeSpeed || 72) * dt;
      move(Math.sign(dx) * Math.min(Math.abs(dx), sp), 0);
      if (Math.abs(edgeX - ph.x) < 3) {
        peekCtl.phase = "slide";
        peekCtl.slideFrom = ph.x;
        peekCtl.slideAt = now;
      }
    } else if (peekCtl.phase === "slide") {
      // 探出去：身体一点点挪到屏幕外，只剩一小半露在里面
      const k = Math.min(1, (now - peekCtl.slideAt) / (p.slideInMs || 520));
      const ease = 1 - Math.pow(1 - k, 3);          // easeOutCubic：探头是"探"，不是"滑行"
      move(peekCtl.slideFrom + (peekCtl.targetX - peekCtl.slideFrom) * ease - ph.x, 0);
      if (k >= 1) {
        peekCtl.phase = "stay";
        peekCtl.stayUntil = now + randRange(p.stayMs || [9000, 18000]);
        console.log(`[peek] hidden at x=${Math.round(ph.x)} side=${peekCtl.side} ` +
                    `visible=${Math.round(petWidth() * (1 - (p.hideRatio || 0.55)))}px`);
      }
    } else if (peekCtl.phase === "stay") {
      // 探头探脑：在藏好的位置附近小幅呼吸式晃动，看着像真的在偷瞄
      const wob = Math.sin(now / 900) * petWidth() * 0.035;
      move(peekCtl.targetX + wob - ph.x, 0);
      // held（页面避让）时一直待着，等主进程/点击放行；自主偷看才按 stayMs 自动回来
      if (!peekCtl.held && now > peekCtl.stayUntil) { peekCtl.phase = "back"; peekCtl.landState = "idle"; }
    } else {
      // back：缩回屏幕里。被点破时（fast）收得急一点，还带点赌气的意思
      const backX = peekCtl.side === "left"
        ? ph.work.x
        : ph.work.x + ph.work.width - petWidth();
      const sp = (peekCtl.fast ? 210 : 150) * dt;
      const dx = backX - ph.x;
      move(Math.sign(dx) * Math.min(Math.abs(dx), sp), 0);
      if (Math.abs(backX - ph.x) < 3) {
        ph.x = backX;
        move(0, 0);
        const land = peekCtl.landState || "idle";
        const fast = peekCtl.fast;
        peekCtl = null;
        console.log(`[peek] back in at x=${Math.round(ph.x)} -> ${land}`);
        setState(land);
        // 被抓包后停在"生气"姿势久一点，别马上又去干别的
        actionUntil = performance.now() + (fast && land === "pout" ? 7000 : ACTION_MS);
      }
    }
  }

  // ---------- 物理主循环 ----------
  function physics(dt) {
    if (!ph.ready || !ph.work) return;
    const b = config.behaviors.physics || {};
    const gravity = b.gravity || 1500;

    // 悬浮高度先更新：physics 里所有"贴地"判断都用 restY()，不直接用 groundY
    const ht = hoverTarget();
    // 起飞要慢（看得出是扇翅膀升上去的），往下归零要快（坠落/蹲防不能拖泥带水）
    const kHover = ht > hoverNow ? 2.6 : 9.0;
    hoverNow += (ht - hoverNow) * Math.min(1, dt * kHover);

    if (dragging) { clampToWorkArea(); return; }
    if (retreating && retreatTarget) {
      // 全屏避让：平滑平移到边角并保持，不接其他位移逻辑
      const k = Math.min(1, dt * 6);
      ph.x += (retreatTarget.x - ph.x) * k;
      ph.y += (retreatTarget.y - ph.y) * k;
      move(0, 0);
      return;
    }
    if (state === "float" || state === "flyTop") { floatStep(dt); return; }
    if (state === "peek") { peekStep(dt); return; }   // peek 期间窗口会合法地待在屏幕外

    // 屏幕外自愈：偷看被外部状态打断（双击睡着、被托盘切动作…）时 peekCtl 会被清掉，
    // 人就留在屏幕外了。clampToWorkArea 是硬赋值 —— 会一帧内瞬移几十像素，很扎眼。
    // 这里先平滑滑回来，再让下面的逻辑正常接管。
    if (ph.work) {
      const rgt = ph.work.x + ph.work.width - petWidth();
      if (ph.x < ph.work.x - 1 || ph.x > rgt + 1) {
        const target = clamp(ph.x, ph.work.x, rgt);
        ph.x += (target - ph.x) * Math.min(1, dt * 9);
        move(0, 0);
        return;
      }
    }

    if (!ph.airborne) {
      const rest = restY();
      // 悬空自愈：动作被打断（飞行中途被切走）时她可能停在半空。现在常态就是
      // 悬浮，所以判据换成"离巡航高度太远"——差得不多就是正常浮着，差得多才是掉了。
      if (ph.y < rest - 40) { ph.airborne = true; ph.vy = 0; }
      else {
        // 平滑贴到巡航高度：睡下时缓缓沉到桌面，醒来时缓缓升起来
        const dy = rest - ph.y;
        if (Math.abs(dy) > 0.4) move(0, dy * Math.min(1, dt * 9));
        clampToWorkArea();
        return;
      }
    }

    ph.vy += gravity * dt;
    ph.vx *= Math.max(0, 1 - (b.airDragPerSec || 0.35) * dt);
    move(ph.vx * dt, ph.vy * dt);

    // 左右碰壁反弹
    if (ph.work) {
      const left = ph.work.x, right = ph.work.x + ph.work.width - petWidth();
      if (ph.x < left) { ph.x = left; ph.vx = Math.abs(ph.vx) * 0.55; }
      if (ph.x > right) { ph.x = right; ph.vx = -Math.abs(ph.vx) * 0.55; }
    }
    // 落地
    if (ph.y >= ph.groundY) {
      const impact = ph.vy;
      ph.y = ph.groundY;
      ph.vy = 0;
      ph.vx *= 0.25;
      ph.airborne = false;
      squashAt = performance.now();
      if (impact > (b.hardLandingSpeed || 950)) setState("fall");
      else setState("drop");
    }
  }

  // ---------- 姿态：甩动倾斜 + 落地压扁（Live2D 时喂给网格变形，否则 CSS transform） ----------
  function applyTransform() {
    const b = config.behaviors.physics || {};
    const maxTilt = b.maxTiltDeg || 18;
    let target = 0;
    if (dragging || ph.airborne) target = clamp(ph.vx / 55, -maxTilt, maxTilt);
    // 飞行时朝前进方向压一点坡度 —— 是"在飞"而不是"被吊着平移"
    if (state === "float" && floatCtl) target = clamp(floatCtl.drift * 0.85, -7, 7);
    // 偷看时朝屏幕内侧歪一点：人是"斜着探进来"的，直挺挺站着不像偷看
    if (state === "peek" && peekCtl) target = peekCtl.side === "left" ? 5 : -5;
    tilt += (target - tilt) * 0.18;
    let squash = 0;
    if (squashAt > 0) {
      const age = (performance.now() - squashAt) / 280;
      if (age < 1) squash = 1 - age;
      else squashAt = -1;
    }
    // 起身：负的 squash = 竖向拉伸，蹲久了猛地站起来的那一下弹性。
    // 同样绕脚底，所以是"往上长"，不是整个人被拉大。
    if (riseAt > 0) {
      const riseMs = ((config.behaviors && config.behaviors.landing) || {}).riseMs || 320;
      const rage = (performance.now() - riseAt) / riseMs;
      if (rage < 1) squash -= 0.55 * (1 - rage);
      else riseAt = -1;
    }
    // 翅膀扇动强度：飞行时由 floatStep 按阶段给（起飞满、悬停中、滑降偏高），
    // 攀爬/下落/被拽着时中高（她在使劲扇），日常只留一点轻微扇动，让她一直"活着"
    // 移动飞行时中速振翅（0.55）：比静止的轻扇明显，又不到升空那种全力扑打，
    // 这样"她在飞着挪位置"和"她浮在原地"一眼能分出来。
    const flap = (state === "float" || state === "flyTop") ? flyFlap
      : state === "fly" ? 0.55
        : (state === "fall" || state === "drag") ? 0.34
          : 0.10;
    if (useLive) {
      // 偷看时脑袋朝屏幕里侧偏 —— 眼睛在往里瞅，这是"偷看"最关键的读画面信号
      const hx = (state === "peek" && peekCtl)
        ? (peekCtl.side === "left" ? 13 : -13)
        : (mouseNX - 0.5) * 16;
      const hy = (state === "peek") ? 4 : (mouseNY - 0.5) * 9;
      live.feed({
        tilt, squash, vx: ph.vx, flap,
        energy: ENERGY[state] ?? 0.9,
        headDX: hx, headDY: hy
      });
      petEl.style.transform = "";      // 形变交给 WebGL 网格，别两套叠加
      return;
    }
    // 回退路径（无 WebGL）：横向补偿从 0.16 降到 0.09 —— 落地压扁时横向
    // 拉伸过大会让人以为"她突然变胖变大了"
    const sx = 1 + 0.09 * squash, sy = 1 - 0.20 * squash;
    const press = pressed ? 0.94 : 1;
    // 只作用于角色区：气泡不跟着旋转/缩放
    petEl.style.transform = `rotate(${tilt.toFixed(2)}deg) scale(${(sx * press).toFixed(3)}, ${(sy * press).toFixed(3)})`;
  }

  // ---------- 主动撒娇 ----------
  // 原来的「每 70~150 秒随机撒娇」已由 15 秒动作节拍接管 —— 节拍池里就含
  // neko/paw/roll/pout/interact，不再单独随机打断。

  // ---------- 渲染节流 / 空闲冻结（治「屏幕角落 + 鼠标一直闪」） ----------
  // 透明 + 置顶窗口每绘制一帧，DWM 就要重新合成一次这块区域。60fps 常开绘制在
  // Windows 上会表现为桌宠所在的角落持续闪、光标经过时也闪。因此按活动度降帧，
  // 并在长时间无人理会时彻底停止绘制（窗口保持最后一帧，合成器零负载）。
  let lowFlash = true;
  let lastRenderAt = 0;
  let lastInputAt = performance.now();
  let frozen = false;

  function renderIntervalMs() {
    if (!lowFlash) return 0;                    // 关闭低闪烁：全速 60fps
    if (dragging || ph.airborne || state === "fly" || state === "float" ||
        state === "flyTop" || state === "peek" || state === "drag" ||
        state === "drop" || state === "fall" || state === "crouch") {
      return 1000 / 30;                         // 有位移：30fps 足够跟手
    }
    if (state === "idle") return 1000 / 12;     // 待机呼吸：12fps
    if (state === "sleep") return 1000 / 6;     // 睡觉：6fps
    return 1000 / 20;                           // 一次性动作（打招呼/撒娇/挥爪/滚）
  }

  function shouldRender(now) {
    const iv = renderIntervalMs();
    if (!iv) { frozen = false; return true; }
    const still = !dragging && !ph.airborne && Math.abs(tilt) < 0.05 && squashAt < 0;
    const quietFor = now - lastInputAt;
    if (still && ((state === "sleep" && quietFor > 8000) || (state === "idle" && quietFor > 12000))) {
      // 冻结：不再逐帧 draw。但每 3 秒补一帧，防止 GPU 上下文重建后画布空白
      if (now - lastRenderAt > 3000) { lastRenderAt = now; frozen = false; return true; }
      frozen = true;
      return false;
    }
    frozen = false;
    if (now - lastRenderAt < iv) return false;
    lastRenderAt = now;
    return true;
  }

  // 任何用户动作都解除冻结，并立即续上主循环（否则要等冻结时的 200ms 轮询才醒，
  // 鼠标划过会看到「愣一下」）。tickToken 保证同一时刻只有一条 tick 链。
  function wake() {
    lastInputAt = performance.now();
    if (frozen) { frozen = false; lastRenderAt = 0; scheduleTick(); }
  }
  ["mousemove", "mousedown", "wheel", "keydown"].forEach((t) => {
    window.addEventListener(t, wake, { capture: true, passive: true });
  });

  // 绘制探针：每 4 秒汇报一次实际 rAF / draw 次数，用来验证低闪烁模式真的生效
  let perfRaf = 0, perfDraw = 0, perfSince = performance.now();
  function perfReport(now) {
    if (now - perfSince < 4000) return;
    const sec = (now - perfSince) / 1000;
    console.log(`[perf] ${sec.toFixed(1)}s raf=${perfRaf} draw=${perfDraw} ` +
      `state=${state} frozen=${frozen} lowFlash=${lowFlash}`);
    perfRaf = 0; perfDraw = 0; perfSince = now;
  }

  // ---------- 主循环 ----------
  function tick(now) {
    perfRaf++;
    const dt = Math.min(0.05, (now - lastTick) / 1000) || 0.016;
    lastTick = now;

    // 偷看分两段演：溜向边缘的时候用 fly 的帧（她是扇着翅膀滑过去的），
    // 藏好之后才换成扒边的帧。如果全程用扒边帧横着移动，看着像贴地飘过去。
    const visual = (state === "peek" && peekCtl && peekCtl.phase === "toEdge") ? "fly" : state;
    const spec = config.animations[visual];
    if (spec) {
      const interval = 1000 / (spec.fps || 4);
      if (now - lastFrameAt >= interval) {
        lastFrameAt = now;
        const fr = frames[visual];
        if (fr && fr.length) {
          showFrame(fr[frameIdx]);
          advanceFrame(spec, fr.length);
        }
      }
    }

    physics(dt);
    applyTransform();
    if (useLive && shouldRender(now)) { live.render(now); perfDraw++; }
    perfReport(now);

    const behaviors = config.behaviors || {};

    // 飞行位移与贴边反弹
    if (state === "fly") {
      const speed = (config.animations.fly.moveSpeed || 130) * dt;
      move(flyDir * speed, 0);
      flyRemain -= dt * 1000;
      const left = ph.work ? ph.work.x : 0;
      const right = ph.work ? ph.work.x + ph.work.width - petWidth() : 1e9;
      if ((flyDir < 0 && ph.x <= left + 1) || (flyDir > 0 && ph.x >= right - 1)) flyDir *= -1;
      if (flyRemain <= 0) setState("idle");
    }

    // 落地反应：抱头蹲防蹲够了就弹起来站好。
    // 起身走 riseAt（负 squash = 竖向拉伸，绕脚底向上长），不是硬切回 idle。
    if ((state === "drop" || state === "fall" || state === "crouch") &&
        landingUntil > 0 && now >= landingUntil && !ph.airborne && !dragging) {
      landingUntil = 0;
      riseAt = now;
      console.log(`[land] crouch hold done -> rise back to idle`);
      setState("idle");
      actionUntil = now + 2600;      // 刚起身站好，别立刻被节拍器拽去干别的
    }

    // 睡眠随机自动醒（双击睡下的，过一会儿自己醒，不然就睡死了）
    if (state === "sleep" && behaviors.sleepAutoWakeSec) {
      if (now - sleepEnteredAt > behaviors.sleepAutoWakeSec * 1000) {
        setState("idle");
        actionUntil = now + ACTION_MS;
      }
    }
    // 闲置气泡：只是冒句台词，不换动作
    const idleBubbleMs = (behaviors.idleBubbleSec ?? 8) * 1000;
    if (state === "idle" && !quiet && idleBubbleMs > 0 && now - lastBubbleAt > idleBubbleMs && lines.idle && lines.idle.length) {
      showBubble(pick(lines.idle));
      lastBubbleAt = now;
    }

    // 动作节拍：满 15 秒换下一个动作。拖拽/飞行/攀爬/偷看/睡觉期间不打断，
    // 等它们自己走完再切（否则会把动作拦腰截断，甚至把角色卡在半空/屏幕外）。
    const busy = dragging || ph.airborne || state === "sleep" || state === "flyTop" ||
      state === "drag" || state === "float" || state === "peek" ||
      state === "drop" || state === "fall" || state === "crouch";
    if (!busy && now >= actionUntil) nextAction();

    scheduleTick();
  }

  let tickToken = 0;
  function scheduleTick() {
    // 冻结/睡眠时不必 60fps 空转，降到低频轮询；wake() 会立刻接管
    const token = ++tickToken;
    if (state === "sleep") {
      setTimeout(() => { if (token === tickToken) tick(performance.now()); }, 400);
    } else if (frozen) {
      setTimeout(() => { if (token === tickToken) tick(performance.now()); }, 200);
    } else {
      requestAnimationFrame((t) => { if (token === tickToken) tick(t); });
    }
  }

  // ---------- 气泡 ----------
  // 气泡由主进程画在**独立**的透明窗口里（那个窗口永久穿透）。这里只决定"说什么"。
  const usedLines = [];
  function pick(arr) {
    if (usedLines.length >= arr.length) usedLines.length = 0;
    let idx;
    do { idx = Math.floor(Math.random() * arr.length); } while (usedLines.includes(idx) && arr.length > 1);
    usedLines.push(idx);
    return arr[idx];
  }
  function showBubble(text, ms) {
    if (!config.bubble || !config.bubble.enabled) return;
    window.petAPI.bubble(text, ms || config.bubble.showMs || 2500);
  }
  const shorten = (t) => (t.length > 26 ? t.slice(0, 25) + "…" : t);

  // ---------- 拖拽 + 甩动物理 + 点击 ----------
  let moved = false;
  let lastPos = null;
  let lastClickUpAt = 0;
  const DRAG_THRESHOLD = 4;

  document.addEventListener("mousedown", (e) => {
    pressed = true; dragging = false; moved = false;
    lastPos = { x: e.screenX, y: e.screenY };
    pointerVel = { x: 0, y: 0, t: performance.now() };
    stage.classList.add("pressed");
    console.log(`[input] mousedown ${e.screenX},${e.screenY} state=${state}`);
    // 页面避让时，点她一下立刻"跳出来"（同时通知主进程：用户已主动把她叫回来）
    if (pageHiding) {
      endPageHide();
      if (window.petAPI && window.petAPI.pageClick) window.petAPI.pageClick();
      console.log("[input] pagehide dismissed by click");
    }
    // 全屏避让（旧）时，点她一下立刻解除退避
    else if (retreating) { retreating = false; retreatTarget = null; console.log("[input] retreat dismissed by click"); }
    // 自主偷看被当场点破：立刻往回收，嘴硬一句。要放在 mousedown 上 —— 要的就是
    // "手指刚碰上去她就缩回去"的反应速度，等 mouseup 就慢半拍了。
    else if (state === "peek") caughtPeek();
  });
  // 诊断：pointerdown 与 mousedown 是两条不同的派发路径，哪条到了说明输入链路通到哪一层
  document.addEventListener("pointerdown", (e) => {
    console.log(`[input] pointerdown btn=${e.button} at ${Math.round(e.clientX)},${Math.round(e.clientY)}`);
  }, true);

  window.addEventListener("mousemove", (e) => {
    if (!pressed) return;
    const dx = e.screenX - lastPos.x, dy = e.screenY - lastPos.y;
    const nowT = performance.now();
    const dt = Math.max(1, nowT - pointerVel.t) / 1000;
    if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      moved = true; dragging = true;
      // 抓手必须是"按下就变被拎着"，不能等松手 —— 记一条 from/now 便于验收，
      // 之前 drag 优先级只有 2，蹲防(3)/打招呼(4) 时抓起来画面不变（用户实测反馈）。
      const fromState = state;
      if (canInterrupt(state, "drag")) setState("drag");
      console.log(`[input] drag start from=${fromState} now=${state}`);
      document.body.classList.add("dragging");
      floatCtl = null;
    }
    if (moved) {
      // 指数平滑的手速，用于松手后的惯性
      pointerVel.x = pointerVel.x * 0.6 + (dx / dt) * 0.4;
      pointerVel.y = pointerVel.y * 0.6 + (dy / dt) * 0.4;
      pointerVel.t = nowT;
      ph.vx = pointerVel.x; ph.vy = pointerVel.y;
      window.petAPI.moveBy(dx, dy);
      ph.x += dx; ph.y += dy;
      ph.sentX = Math.round(ph.x); ph.sentY = Math.round(ph.y);
      lastPos = { x: e.screenX, y: e.screenY };
    }
  });

  window.addEventListener("mouseup", async () => {
    if (!pressed) return;
    pressed = false;
    stage.classList.remove("pressed");
    document.body.classList.remove("dragging");
    console.log(`[input] mouseup moved=${moved}`);
    const b = config.behaviors.physics || {};
    if (moved) {
      dragging = false;
      const speed = Math.hypot(ph.vx, ph.vy);
      // 判据换成"离巡航高度有多远"：她平时就浮在 groundY 上方十几像素，
      // 用 groundY 去比会永远成立，轻轻一放也会被当成甩出去。
      const aboveGround = cruiseY() - ph.y > 6;
      if (speed > (b.flingMinSpeed || 260) || aboveGround) {
        // 甩出去 / 半空松手 → 进入抛物线，落地判定在 physics
        ph.airborne = true;
        ph.vx = ph.vx * (b.flingBoost || 1.2);
        ph.vy = ph.vy * (b.flingBoost || 1.2);
        setState("drag");
      } else {
        // 轻放：直接回到巡航高度接着悬停，不用落地蹲防（那是高处坠落才有的仪式）
        ph.airborne = false;
        ph.vx = 0; ph.vy = 0;
        hoverNow = flyHoverPx();
        ph.y = ph.groundY - hoverNow; move(0, 0);
        setState("idle");
      }
      return;
    }

    // ---- 单击 / 双击 ----
    // 不能用浏览器合成的 dblclick：她这个窗口是可激活但通常处于未激活状态，
    // 点她的第一下会先激活窗口，Windows/Chromium 会把这次按下**重放一遍** ——
    // 实测一次真实点击产生两个 pointerdown/mousedown，clickCount 直接变成 2，
    // 于是"点她一下"被判成双击、人直接睡着了。这里自己数 mouseup 的间隔，
    // 一次真实点击只会有一次 mouseup，重放的那次不会跟着来。
    const nowT = performance.now();
    const isDouble = nowT - lastClickUpAt < 320;
    lastClickUpAt = nowT;
    setTimeout(() => {
      if (state === "drag" || state === "peek") return;   // 正在拖/正在往回收，别管
      if (nowT < peekCaughtUntil) return;                 // 刚被抓包，让她站着赌气
      if (isDouble) {
        if (state === "sleep") wakeUp("greet"); else setState("sleep");
        return;
      }
      if (state === "sleep") { wakeUp("greet"); return; }
      if (ph.airborne) return;
      nextAction();
    }, 200);
  });

  // ---------- 命中区域（穿透判定）----------
  // ---------- 悬停高亮 ----------
  // 窗口现在就是角色本体，鼠标进出直接由 DOM 事件判断即可（不再有窗口级穿透开关）。
  petEl.addEventListener("mouseenter", () => stage.classList.add("grab-hint"));
  petEl.addEventListener("mouseleave", () => stage.classList.remove("grab-hint"));

  window.petAPI.getSettings().then((s) => {
    if (s && s.quiet) quiet = true;
    if (s && typeof s.lowFlash === "boolean") lowFlash = s.lowFlash;
  });
  window.petAPI.onClickThroughChanged(() => { /* 旧开关已废弃：角色本体窗口不再穿透 */ });
  window.petAPI.onQuietChanged((on) => { quiet = on; });
  window.petAPI.onLowFlashChanged((on) => {
    lowFlash = !!on;
    frozen = false;
    lastRenderAt = 0;
  });
  document.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    console.log(`[input] contextmenu at ${e.screenX},${e.screenY}`);
    window.petAPI.contextMenu(e.screenX, e.screenY);
  });
  window.petAPI.onPetSleep(() => {
    if (state === "sleep") wakeUp("greet"); else setState("sleep");
  });

  // ---------- AI 对话联动 ----------
  const MOOD_STATE = {
    happy: "interact", shy: "neko", pout: "pout", sleepy: "sleep",
    excited: "roll", playful: "paw", comfort: "interact"
  };
  window.petAPI.onSay((payload) => {
    if (!payload || !payload.text) return;
    if (state === "sleep") setState("idle");
    showBubble(shorten(payload.text), 4200);
    const st = MOOD_STATE[payload.mood] || "interact";
    if (frames[st] && state !== "drag") {
      setState(st);
      actionUntil = performance.now() + ACTION_MS;   // 说话引起的动作，也保持满 15 秒
    }
    sleepSince = performance.now();
  });

  // 托盘「让它表演一个」：手动触发，同样并入节拍
  window.petAPI.onAction((name) => {
    if (name === "__fling") {
      // 仅验收用：把她抬到半空、交给物理引擎自己摔下来。
      // 这样走的是真实路径（重力 → impact 判定 → drop/fall → 抱头蹲防），
      // 而不是直接摆一个蹲的姿势糊弄过去。
      ph.y = Math.max((ph.work ? ph.work.y : 0) + 8, ph.groundY - 420);
      ph.vy = 0;
      ph.airborne = true;
      setState("drag");
      console.log(`[land] fling test: released at y=${Math.round(ph.y)} groundY=${Math.round(ph.groundY)}`);
      return;
    }
    if (state === "sleep") setState("idle");
    if (name === "float" || name === "flyTop" || (frames[name] && frames[name].length)) {
      applyAction(name);
    }
  });

  // 主进程侧的光标探测：主人连续很久没碰她（在忙别的窗口），她就溜到屏幕边上偷看一眼。
  // 只在她闲着的时候才响应，正在飞/正在爬/正在被拖的时候一律不打断。
  if (window.petAPI.onPeekHint) {
    window.petAPI.onPeekHint(() => {
      if (state !== "idle" || pageHiding) return;
      if (startPeek()) actionUntil = performance.now() + ACTION_MS;
    });
  }
  if (window.petAPI.onRetreat) {
    window.petAPI.onRetreat((p) => {
      if (p && p.on) { retreating = true; retreatTarget = { x: p.x, y: p.y }; }
      else { retreating = false; retreatTarget = null; }
      console.log(`[retreat] ${p && p.on ? "to corner x=" + p.x + " y=" + p.y : "resume"}`);
    });
  }
  // 页面避让：主进程说"前台是别的窗口"→ 滑到屏幕边藏着；说"回来了"→ 出来
  if (window.petAPI.onPageHide) {
    window.petAPI.onPageHide((p) => {
      if (p && p.on) startPageHide();
      else endPageHide();
    });
  }

  // ---------- 首次引导 ----------
  async function runOnboarding() {
    const seq = [
      "拖我到处走～松手我会掉下来哦",
      "点我一下，我会换姿势给你看",
      "双击让我睡觉，右键有菜单",
      "想聊天就点托盘那个小粉点"
    ];
    for (const t of seq) {
      showBubble(t);
      await new Promise((r) => setTimeout(r, 2800));
    }
    window.petAPI.markOnboarded();
  }

  // ---------- 启动 ----------
  fetch(cfgUrl).then((r) => r.json()).then(async (c) => {
    config = c;
    if (c.behaviors && Number.isFinite(c.behaviors.actionHoldMs)) ACTION_MS = c.behaviors.actionHoldMs;
    if (useLive) {
      live.resize();
      window.addEventListener("resize", () => live.resize());
    }
    await syncEnv();
    // 600ms 一次 getBounds + getDisplayNearestPoint 会周期性惊动窗口系统；
    // 位置同步对延迟不敏感，放宽到 2.5s，显示器热插拔最多 2.5s 内自愈。
    setInterval(syncEnv, 2500);
    await loadAll();
    applyAction("greet");     // 先打个招呼，同时起 15 秒动作节拍
    scheduleTick();
    if (config.bubble && config.bubble.enabled) {
      window.petAPI.getOnboarded().then((done) => { if (!done) runOnboarding(); });
    }
  });
})();
