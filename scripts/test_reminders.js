/**
 * test_reminders.js - 提醒模块的离线验收（不启动 Electron）
 *
 * 用可注入时钟把 26 小时压缩成几万次 tick，逐条断言：
 *   1. 每个整点只报一次（不重不漏）
 *   2. 夜间静音时段（23:00-08:00，跨零点）一条都不冒
 *   3. 静音期间不"憋着"，08:00 之后不会补发一堆
 *   4. 喝水提醒按间隔稳定触发
 *   5. 番茄钟 专注 → 休息 → 自动停，相位与剩余时间正确
 *
 * 跑法：node scripts/test_reminders.js
 */
const { createReminders } = require("../src/reminders");

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}  ${detail || ""}`);
  }
}

function makeClock(startISO) {
  let t = new Date(startISO).getTime();
  return {
    now: () => new Date(t),
    advance: (ms) => { t += ms; }
  };
}

function makeRig(startISO, opts) {
  const clock = makeClock(startISO);
  const said = [];
  const r = createReminders({
    clock: clock.now,
    say: (text) => said.push({ at: clock.now(), text }),
    onChange: () => {},
    log: () => {},
    random: () => 0,              // 固定取台词库第一条，结果可复现
    initial: opts || {}
  });
  return { clock, said, r };
}

// 以 20 秒为一步跑 minutes 分钟
function run(rig, minutes) {
  const steps = Math.round((minutes * 60000) / 20000);
  for (let i = 0; i < steps; i++) {
    rig.clock.advance(20000);
    rig.r._tick();
  }
}

// ---------- 场景 1：08:00 起跑 26 小时，覆盖一夜静音 ----------
console.log("\n[1] 26 小时连续运行（08:00 起，静音 23:00-08:00）");
{
  const rig = makeRig("2026-10-27T08:00:00", { waterMin: 50, quietOn: true });
  // 起点本身不是整点触发点（节拍推进后才判断），先跑满 26 小时
  run(rig, 26 * 60);

  const hours = new Set();
  let quietLeak = 0;
  let nightTotal = 0;
  for (const s of rig.said) {
    const h = s.at.getHours();
    if (s.text.includes("点")) hours.add(`${s.at.toDateString()} ${h}`);
    const quiet = (h >= 23 || h < 8);
    if (quiet) { quietLeak++; nightTotal++; }
  }

  check("静音时段（23:00-08:00）零冒泡", quietLeak === 0, `漏了 ${quietLeak} 条`);
  // 26 小时里清醒时段是 8:00-23:00，共 15 小时，去掉首尾应覆盖 14~15 个整点
  check("整点报时覆盖到大部分清醒整点", hours.size >= 14, `只覆盖 ${hours.size} 个整点`);
  // 不做"补发"检查：08:00 之后 3 分钟内不该出现 3 条以上
  const morning = rig.said.filter((s) => {
    const h = s.at.getHours(), m = s.at.getMinutes();
    return h === 8 && m <= 3;
  });
  check("08:00 后没有补发堆积（3 分钟内 <=2 条）", morning.length <= 2, `实际 ${morning.length} 条`);
  console.log(`      （整段共冒泡 ${rig.said.length} 条）`);
}

// ---------- 场景 2：每个整点只报一次 ----------
console.log("\n[2] 整点去重");
{
  const rig = makeRig("2026-10-27T09:59:00", { waterMin: 0, quietOn: false });
  run(rig, 62);                       // 跨过 10:00 这一分钟
  const at10 = rig.said.filter((s) => s.at.getHours() === 10 && s.at.getMinutes() < 20);
  check("10 点整只报一次", at10.length === 1, `实际 ${at10.length} 条：${at10.map(s => s.text).join(" / ")}`);
}

// ---------- 场景 3：喝水提醒间隔 ----------
console.log("\n[3] 喝水提醒间隔 50 分钟");
{
  const rig = makeRig("2026-10-27T10:00:00", { waterMin: 50, hourlyChime: false, quietOn: false });
  run(rig, 170);                      // 170 分钟 -> 预期 3 次（50/100/150）
  check("170 分钟内触发 3 次", rig.said.length === 3, `实际 ${rig.said.length} 次`);
  const gaps = [];
  for (let i = 1; i < rig.said.length; i++) {
    gaps.push(Math.round((rig.said[i].at - rig.said[i - 1].at) / 60000));
  }
  check("间隔稳定在 50 分钟（±1）", gaps.every((g) => Math.abs(g - 50) <= 1), `实际 ${gaps.join(",")}`);
}

// ---------- 场景 4：番茄钟 ----------
console.log("\n[4] 番茄钟 25 分钟专注 + 5 分钟休息");
{
  const rig = makeRig("2026-10-27T14:00:00", { hourlyChime: false, waterMin: 0, quietOn: false });
  rig.r.startPomodoro();
  check("启动后处于专注相", rig.r.status().running && rig.r.status().phase === "focus",
        JSON.stringify(rig.r.status()));
  check("剩余约 25 分钟", Math.abs(rig.r.status().leftMin - 25) <= 1,
        `实际 ${rig.r.status().leftMin}`);

  run(rig, 26);                       // 跑过专注结束点
  check("26 分钟后进入休息相", rig.r.status().phase === "break", JSON.stringify(rig.r.status()));
  const done = rig.said.some((s) => /分钟到啦|时间到/.test(s.text));
  check("播报了「专注结束」提示", done, rig.said.map(s => s.text).join(" / "));

  run(rig, 6);                        // 跑完休息
  check("休息结束后自动停止", rig.r.status().running === false, JSON.stringify(rig.r.status()));
  const back = rig.said.some((s) => /休息结束|回来干活/.test(s.text));
  check("播报了「休息结束」提示", back, rig.said.map(s => s.text).join(" / "));
}

// ---------- 场景 5：静音跨零点 ----------
console.log("\n[5] 静音时段跨零点判定");
{
  const probes = [
    ["2026-10-27T22:59:00", false, "22:59 不静音"],
    ["2026-10-27T23:00:00", true, "23:00 静音"],
    ["2026-10-28T00:30:00", true, "00:30 静音（跨零点）"],
    ["2026-10-28T07:59:00", true, "07:59 静音"],
    ["2026-10-28T08:00:00", false, "08:00 解除静音"]
  ];
  for (const [iso, wantQuiet, label] of probes) {
    // 用 3 秒的喝水间隔做探针，只推进 5 秒 —— 时间必须停在同一个分钟里，
    // 否则探针自己就把时钟推过了边界（第一版就是这么误报的）。
    const rig2 = makeRig(iso, { waterMin: 0.05, hourlyChime: false, quietOn: true });
    rig2.r.set({ waterMin: 0.05 });
    rig2.clock.advance(5 * 1000);
    rig2.r._tick();
    const spoke = rig2.said.length > 0;
    check(label, spoke === !wantQuiet, `冒泡=${spoke}，期望=${!wantQuiet}`);
  }
}

console.log("");
if (failures) {
  console.log(`RESULT: ${failures} 项失败`);
  process.exit(1);
}
console.log("RESULT: 全部通过");
