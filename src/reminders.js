/**
 * reminders.js - 实用小功能：整点报时 / 久坐喝水提醒 / 番茄钟 / 夜间静音
 *
 * 设计要点
 * ---------
 * 1) **单一节拍**：只有一个 20 秒的 setInterval，所有功能都在里面按"绝对时间"判定。
 *    不用一堆 setTimeout 串起来 —— 电脑休眠/唤醒后 setTimeout 会一次性挤着触发，
 *    表现为"一开机她连珠炮说十句话"。
 * 2) **错过就跳过**：每个功能记录"上次触发的时间点"，醒来后只判断"现在是不是又到点了"，
 *    不补发历史提醒。
 * 3) **静音时段不憋着**：静音期间照样推进时间戳，只是不冒泡。否则 8 点一到会把整夜
 *    攒下来的提醒全吐出来。
 * 4) 全部台词走桌宠气泡通道（say），不弹任何系统通知 —— 不抢焦点、不进通知中心。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const TICK_MS = 20 * 1000;

const DEFAULTS = {
  hourlyChime: true,        // 整点报时
  waterMin: 50,             // 喝水/起身提醒间隔（分钟），0 = 关闭
  quietStart: 23,           // 夜间静音开始（整点，含）
  quietEnd: 8,              // 夜间静音结束（整点，不含）
  quietOn: true,
  pomodoroFocus: 25,        // 番茄钟专注分钟
  pomodoroBreak: 5,         // 番茄钟休息分钟
  pomodoroAutoBreak: true   // 专注结束自动进休息
};

function pad2(n) { return String(n).padStart(2, "0"); }

function hourText(h) {
  const names = ["零", "一", "两", "三", "四", "五", "六", "七", "八", "九", "十",
    "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
    "二十一", "二十二", "二十三"];
  return names[h] || String(h);
}

// 整点台词：按时间段给不同的口气，避免每晚同一句
const HOURLY_LINES = {
  lateNight: ["已经%s点啦，主人还不睡吗……", "都%s点了哦，熬夜会变丑的（才不是关心你）"],
  morning: ["%s点了，新的一天开始咯～", "早上%s点，红茶泡好了没有呀"],
  noon: ["%s点整，该吃午饭了吧？", "%s点了，主人不饿吗，我都饿了"],
  afternoon: ["%s点了，下午也要加油哦", "叮～%s点整，喝口水再继续吧"],
  evening: ["%s点了，太阳都下山啦", "%s点整，今天过得怎么样？"],
  night: ["%s点了，差不多该收工了吧", "%s点整……主人，别熬太晚"]
};

function hourlyLine(h, rnd) {
  let bucket;
  if (h >= 0 && h < 6) bucket = "lateNight";
  else if (h >= 6 && h < 11) bucket = "morning";
  else if (h >= 11 && h < 14) bucket = "noon";
  else if (h >= 14 && h < 18) bucket = "afternoon";
  else if (h >= 18 && h < 22) bucket = "evening";
  else bucket = "night";
  const pool = HOURLY_LINES[bucket];
  return pool[Math.floor(rnd() * pool.length)].replace("%s", hourText(h));
}

const WATER_LINES = [
  "该喝口水啦～红茶也行，我不拦你",
  "起来走两步吧，坐太久腰会酸的",
  "喝水时间到！我也去倒一杯",
  "主人，肩膀是不是僵了？转一转吧",
  "已经坐了好一会儿了，站起来伸个懒腰～"
];

const FOCUS_START_LINES = [
  "番茄钟开始！这%s分钟我陪你，不许摸鱼哦",
  "好，专注%s分钟，我盯着你呢"
];
const FOCUS_DONE_LINES = [
  "%s分钟到啦！休息一下，看看远处",
  "时间到～起来动一动，我等你回来"
];
const BREAK_DONE_LINES = [
  "休息结束，继续加油吧！",
  "好啦，回来干活～我数到三哦"
];

function createReminders(opts) {
  const say = opts.say;                    // (text, ms) => void
  const isHidden = opts.isHidden || (() => false);
  const onChange = opts.onChange || (() => {});
  const log = opts.log || (() => {});
  const rnd = opts.random || Math.random;
  // 时钟可注入：验收时用模拟时间一天一天地跑，比等 50 分钟才看到一条喝水提醒靠谱得多
  const clock = opts.clock || (() => new Date());
  const nowMs = () => clock().getTime();

  const st = {
    ...DEFAULTS,
    ...(opts.initial || {}),
    pomodoroRunning: false,
    pomodoroPhase: null,     // "focus" | "break"
    pomodoroEndsAt: 0
  };

  let timer = null;
  let lastHourKey = null;    // "2026-10-27T20" —— 保证每个整点只报一次
  let lastWaterAt = nowMs();
  let lastPomodoroTick = 0;

  function persist() {
    const { pomodoroRunning, pomodoroPhase, pomodoroEndsAt, ...cfg } = st;
    onChange(cfg);
  }

  function inQuiet(now) {
    if (!st.quietOn) return false;
    const h = now.getHours();
    const s = st.quietStart, e = st.quietEnd;
    if (s === e) return false;
    return s < e ? (h >= s && h < e) : (h >= s || h < e);   // 支持跨零点
  }

  function speak(text, ms) {
    if (isHidden()) return;
    try { say(text, ms || 4200); } catch { /* 气泡失败不影响计时 */ }
  }

  function tick() {
    const now = clock();
    const quiet = inQuiet(now);

    // --- 整点报时 ---
    const hourKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}`;
    if (now.getMinutes() === 0 && hourKey !== lastHourKey) {
      lastHourKey = hourKey;
      if (st.hourlyChime && !quiet) speak(hourlyLine(now.getHours(), rnd), 4600);
    }

    // --- 久坐 / 喝水提醒 ---
    if (st.waterMin > 0) {
      if (now.getTime() - lastWaterAt >= st.waterMin * 60000) {
        lastWaterAt = now.getTime();      // 静音期间也推进，避免醒来连发
        if (!quiet) speak(WATER_LINES[Math.floor(rnd() * WATER_LINES.length)], 4600);
      }
    }

    // --- 番茄钟 ---
    if (st.pomodoroRunning && st.pomodoroEndsAt) {
      const left = st.pomodoroEndsAt - now.getTime();
      // 每整分钟报一次剩余（仅专注阶段，且距离上次播报 >50s）
      if (st.pomodoroPhase === "focus" && left > 60000 && left < 5 * 60000 &&
          now.getTime() - lastPomodoroTick > 50000) {
        lastPomodoroTick = now.getTime();
        const mins = Math.ceil(left / 60000);
        if (!quiet) speak(`还有${mins}分钟，坚持住～`, 3600);
      }
      if (left <= 0) {
        if (st.pomodoroPhase === "focus") {
          if (!quiet) {
            speak(FOCUS_DONE_LINES[Math.floor(rnd() * FOCUS_DONE_LINES.length)]
              .replace("%s", String(st.pomodoroFocus)), 5000);
          }
          if (st.pomodoroAutoBreak) {
            st.pomodoroPhase = "break";
            st.pomodoroEndsAt = now.getTime() + st.pomodoroBreak * 60000;
          } else {
            stopPomodoro(true);
          }
        } else {
          if (!quiet) speak(BREAK_DONE_LINES[Math.floor(rnd() * BREAK_DONE_LINES.length)], 4600);
          stopPomodoro(true);
        }
      }
    }
  }

  function start() {
    if (timer) return;
    lastWaterAt = nowMs();
    const now = clock();
    lastHourKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}`;
    timer = setInterval(tick, TICK_MS);
    log(`[remind] started hourly=${st.hourlyChime} water=${st.waterMin}min ` +
        `quiet=${st.quietOn ? st.quietStart + "-" + st.quietEnd : "off"}`);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function startPomodoro() {
    st.pomodoroRunning = true;
    st.pomodoroPhase = "focus";
    st.pomodoroEndsAt = nowMs() + st.pomodoroFocus * 60000;
    lastPomodoroTick = nowMs();
    speak(FOCUS_START_LINES[Math.floor(rnd() * FOCUS_START_LINES.length)]
      .replace("%s", String(st.pomodoroFocus)), 4200);
    log(`[remind] pomodoro start -> ${st.pomodoroFocus}min`);
    onChange(cfgOf());
  }

  function stopPomodoro(silent) {
    if (!st.pomodoroRunning) return;
    st.pomodoroRunning = false;
    st.pomodoroPhase = null;
    st.pomodoroEndsAt = 0;
    if (!silent) log("[remind] pomodoro stopped by user");
    onChange(cfgOf());
  }

  function cfgOf() {
    const { pomodoroRunning, pomodoroPhase, pomodoroEndsAt, ...cfg } = st;
    return cfg;
  }

  function set(patch) {
    Object.assign(st, patch);
    if ("waterMin" in patch) lastWaterAt = nowMs();   // 改间隔后重新起算
    log(`[remind] cfg ${JSON.stringify(patch)}`);
    persist();
  }

  function status() {
    let leftMin = 0;
    if (st.pomodoroRunning && st.pomodoroEndsAt) {
      leftMin = Math.max(0, Math.ceil((st.pomodoroEndsAt - nowMs()) / 60000));
    }
    return { running: st.pomodoroRunning, phase: st.pomodoroPhase, leftMin };
  }

  return {
    start, stop, set, status, startPomodoro, stopPomodoro,
    state: st, config: cfgOf,
    _tick: tick          // 验收脚本用模拟时钟手动驱动，不进正常路径
  };
}

module.exports = { createReminders, DEFAULTS };
