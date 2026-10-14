#!/usr/bin/env node
// 「今日获得积分」的回归测试（对应 public/util.js 的 sumTodayGained / bucketByDay）。
//
// 卡片上那个数 = 每个账号"今天"的余额增量之和。它必须同时满足这几条，缺一条这个数就会
// 变成"看起来合理但错"的数：
//   1. 看的是**余额变化**，不是行里自报的 gained —— 自报值只覆盖一次运行干的事，
//      会漏掉延迟到账/兑换/Xbox 等来源；
//   2. 同一个账号一天里被检查几次都一样：跑 3 次不重复计数，跑 1 次不漏。这正是换掉
//      "上次运行获得积分"的原因 —— 那个数会因为某个号出错重跑而从 10 个号塌成 1 个号；
//   3. 今天没被观测到的账号算"不知道"，不进合计；一个都没有时 observed=0（调用方显示 –）；
//   4. 余额读不到（points=null）的行不能凭空造出一次暴跌；
//   5. 跨午夜按**面板时区**（Asia/Shanghai）分天，不按 UTC。
//
// 还有一条是拿真实故障换来的（2026-10-14）：账号名单与历史必须**同源**。摘要接口
// /api/summary 的账号对象没有 key 字段（只有 email/userName/…），拿它去查 /api/accounts
// 的 histories 不会报错，只是 10 个账号全部落空，卡片显示成 –。
//
//   node tools/test-today-gained.mjs          -> 只跑固定用例（不联网、不需要 bot/面板在跑）
//   node tools/test-today-gained.mjs --live   -> 再对面板的 /api/accounts 实算一次
//                                                （需要面板在跑；会检查实盘载荷里有没有缺 key 的账号）
// 全部通过时 exit 0，任一断言不成立 exit 1。

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { sumTodayGained, setTimeZone } = await import(
  pathToFileURL(path.join(here, "..", "public", "util.js")).href
);

// 时区显式钉住：面板时区由后端下发，测试不能跟着本机走，否则换台机器结论就变。
setTimeZone("Asia/Shanghai");

let pass = 0;
const failures = [];
function check(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass += 1;
    return;
  }
  failures.push(`${name}: want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

// 历史行的真实形状：ts 是 UTC 的 ISO，points 是那一刻读到的余额，gained 是脚本自报的
// 本次获得（上游从 2026-10-12 起经常写 null）。
const sh = (local) => new Date(`${local}+08:00`).toISOString();
const row = (local, points, gained = null) => ({ ts: sh(local), points, gained });
const keys = (histories) => Object.keys(histories).map((key) => ({ key }));
const NOW = new Date("2026-10-14T20:00:00+08:00");

// 1. 余额差，而不是自报的 gained（这里每行的 gained 都是 null）
const A = {
  "a@x": [row("2026-10-13T09:00:00", 100), row("2026-10-14T09:00:00", 130)],
  "b@x": [row("2026-10-14T10:00:00", 500), row("2026-10-14T18:00:00", 560)],
};
check("A 余额差（gained 全为 null）", sumTodayGained(keys(A), A, NOW), {
  todayKey: "2026-10-14",
  gained: 90,
  observed: 2,
});

// 2. 一天跑几次都一样
const B3 = {
  "c@x": [row("2026-10-14T08:00:00", 200), row("2026-10-14T12:00:00", 230), row("2026-10-14T19:00:00", 260)],
};
const B1 = { "c@x": [row("2026-10-14T08:00:00", 200), row("2026-10-14T19:00:00", 260)] };
check("B 一天跑 3 次不重复计数", sumTodayGained(keys(B3), B3, NOW).gained, 60);
check("B 少跑两次结果不变", sumTodayGained(keys(B1), B1, NOW).gained, sumTodayGained(keys(B3), B3, NOW).gained);

// 3. 不知道 ≠ 0
const C = { "d@x": [row("2026-10-13T09:00:00", 300), row("2026-10-13T18:00:00", 320)] };
check("C 只有昨天的账号不进合计", sumTodayGained(keys(C), C, NOW), {
  todayKey: "2026-10-14",
  gained: 0,
  observed: 0,
});
check("C 一个账号都没有", sumTodayGained([], {}, NOW).observed, 0);
check("C 有账号但没有历史", sumTodayGained([{ key: "e@x" }], {}, NOW).observed, 0);

// 4. 名单与历史同源（真发生过的 bug：摘要接口的账号对象没有 key）
const D = { "a@x": [row("2026-10-14T09:00:00", 130)] };
check("D 摘要接口形状的名单（无 key）全部落空", sumTodayGained([{ email: "a@x" }, { email: "b@x" }], D, NOW).observed, 0);
check("D 账号接口形状的名单（有 key）查得到", sumTodayGained([{ key: "a@x" }, { key: "b@x" }], D, NOW).observed, 1);

// 5. 余额读不到的行跳过（既不累加，也不推进比较链）
const E = {
  "f@x": [row("2026-10-14T08:00:00", 400), row("2026-10-14T09:00:00", null), row("2026-10-14T10:00:00", 450)],
};
check("E points=null 的行不算成 0", sumTodayGained(keys(E), E, NOW).gained, 50);

// 6. 跨午夜按面板时区分天
const F = { "g@x": [row("2026-10-14T22:00:00", 700), row("2026-10-15T00:30:00", 740)] };
check("F 那条的 UTC 日期仍是 10-14（按 UTC 分天会算错）", row("2026-10-15T00:30:00", 740).ts.slice(0, 10), "2026-10-14");
check("F 上海 10-14 当天只算到 22:00 那条", sumTodayGained(keys(F), F, new Date("2026-10-14T23:00:00+08:00")).gained, 0);
check("F 上海 10-15 那条的增量归到 10-15", sumTodayGained(keys(F), F, new Date("2026-10-15T01:00:00+08:00")).gained, 40);

console.log(`    固定用例：通过 ${pass}，失败 ${failures.length}`);
for (const f of failures) console.log(`    ❌ ${f}`);

// --live：对面板的实时载荷再算一次，并检查实盘载荷里有没有缺 key 的账号
if (process.argv.includes("--live")) {
  const base = process.env.PANEL_URL || "http://127.0.0.1:8890";
  const payload = await (await fetch(`${base}/api/accounts`)).json();
  const accounts = payload.accounts || [];
  const histories = payload.histories || {};
  const missing = accounts.filter((a) => !a.key).length;
  if (missing) {
    failures.push(`--live: ${missing}/${accounts.length} 个账号没有 key 字段 —— 名单与历史不同源，卡片会显示成 –`);
  }
  const live = sumTodayGained(accounts, histories);
  console.log(
    `    实算（${base}）：今天 ${live.todayKey}，${live.observed}/${accounts.length} 个账号有观测，` +
      `合计 ${live.gained} -> 卡片显示 ${live.observed ? live.gained.toLocaleString() : "–"}`,
  );
  for (const a of accounts) {
    const one = sumTodayGained([a], histories);
    console.log(`      ${String(a.key || a.email).padEnd(34)}${one.observed ? String(one.gained).padStart(5) : "    –"}`);
  }
}

if (failures.length) {
  console.log("    ❌ 有断言不成立");
  process.exit(1);
}
console.log("    ✅ 全部通过");
