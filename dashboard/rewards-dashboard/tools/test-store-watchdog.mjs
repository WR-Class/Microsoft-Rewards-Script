#!/usr/bin/env node
// 看门狗判据 + RUN-END 复用被抢先关掉的行 —— 回归测试（lib/store.js）。
//
// 两个已发生的缺陷：
//   ① _tryCloseStaleNoActivityRun 以前拿 activity 表判断"运行还活着"。activity 只在
//      账号边界等少数事件落库（实测一次 410 分钟的运行只落了 9 条），而实测单账号耗时
//      113~156 分钟是常态 —— 于是把正在正常跑的运行判成 stalled。
//   ② 那个误判之后，真 RUN-END 到达时 findRunningRun 已为空，insertOrphanRunEnd 又建了
//      一行 start_ts 为 null 的孤儿。同一次运行在运行记录页出现两遍（实测 2026-10-10）。
//
//   node tools/test-store-watchdog.mjs   -> exit 0 when every assertion holds
//
// 用临时 DATA_DIR，不碰 data/dashboard.sqlite。时间用相对偏移造，不写死日期。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// store.js 在模块加载时读 DATA_DIR —— 必须在 require 之前设好。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "store-watchdog-"));
process.env.DATA_DIR = tmp;

const require = createRequire(import.meta.url);
const { Store } = require(path.join(here, "..", "lib", "store.js"));

const MIN = 60 * 1000;
const ago = (min) => new Date(Date.now() - min * MIN).toISOString();

let pass = 0;
const failures = [];
function assert(name, ok, detail = "") {
  if (ok) pass += 1;
  else failures.push(`${name}${detail ? `: ${detail}` : ""}`);
}

const store = new Store();
const runRow = (id) => store.db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
const countRuns = () => store.db.prepare("SELECT COUNT(*) c FROM runs").get().c;
const orphanCount = () =>
  store.db.prepare("SELECT COUNT(*) c FROM runs WHERE start_ts IS NULL").get().c;

// ── ① 看门狗：只有 activity 旧、事件新时，绝不能判 stalled ─────────────────────
store.db
  .prepare("INSERT INTO runs (id, status, start_ts, total_accounts) VALUES (?, 'running', ?, 3)")
  .run("run-a", ago(200));
// 旧判据会看到的东西：最后一条活动在 200 分钟前 —— 那时候它必然误判。
store.stmts.insertActivity.run(
  ago(200),
  "INFO",
  "ACCOUNT-END",
  "account-end",
  null,
  null,
  "a@example.com",
  "fixture",
  null,
);
assert("前置：run-a 是 running", runRow("run-a").status === "running");

store._lastEventTs = Date.now() - 5 * MIN;
store._tryCloseStaleNoActivityRun();
assert(
  "事件是 5 分钟前的（activity 是 200 分钟前）-> 不判 stalled",
  runRow("run-a").status === "running",
  `status=${runRow("run-a").status}`,
);

store._lastEventTs = Date.now() - 200 * MIN;
store._tryCloseStaleNoActivityRun();
assert(
  "事件也变旧了 -> 该判 stalled（看门狗本身没被废掉）",
  runRow("run-a").status === "stalled",
  `status=${runRow("run-a").status}`,
);

// ── ② RUN-END 复用被抢先关掉的行，而不是另建孤儿 ──────────────────────────────
const startB = ago(400);
store.db
  .prepare(
    "INSERT INTO runs (id, status, start_ts, end_ts, accounts_processed, total_accounts, runtime_min) VALUES (?, 'stalled', ?, ?, 2, 3, 370)",
  )
  .run("run-b", startB, ago(30));

const beforeB = countRuns();
store.apply({
  kind: "run-end",
  ts: ago(29), // 比 run-b 的 end_ts 晚 1 分钟
  accountsProcessed: 3,
  totalGained: 590,
  oldTotal: 0,
  newTotal: 590,
  runtimeMin: 421.8,
});
const b = runRow("run-b");
assert("复用：没有新建行", countRuns() === beforeB, `runs=${countRuns()} 期望=${beforeB}`);
assert("复用：stalled 行变成了 done", b.status === "done", `status=${b.status}`);
assert(
  "复用：RUN-END 的数值写进了那一行",
  b.accounts_processed === 3 &&
    b.total_gained === 590 &&
    b.old_total === 0 &&
    b.new_total === 590 &&
    b.runtime_min === 421.8,
  JSON.stringify({
    acct: b.accounts_processed,
    gained: b.total_gained,
    old: b.old_total,
    new: b.new_total,
    min: b.runtime_min,
  }),
);
assert(
  "复用：start_ts 保留（这正是孤儿行没有的那个字段）",
  b.start_ts === startB,
  `start_ts=${b.start_ts} 期望=${startB}`,
);
assert("复用：没有产生 start_ts 为 null 的孤儿", orphanCount() === 0, `orphans=${orphanCount()}`);

// ── ③ 负向对照：近邻没有 stalled 行时，仍按原样插孤儿（case a 没被破坏）──────
// 把 run-b 推到复用窗口（6 小时）之外。
store.db.prepare("UPDATE runs SET end_ts = ? WHERE id = 'run-b'").run(ago(8 * 60));
const beforeC = countRuns();
store.apply({
  kind: "run-end",
  ts: ago(10),
  accountsProcessed: 1,
  totalGained: 5,
  oldTotal: null,
  newTotal: 5,
  runtimeMin: 10,
});
assert("窗口外：新建了一行", countRuns() === beforeC + 1, `runs=${countRuns()} 期望=${beforeC + 1}`);
assert("窗口外：新行是 start_ts 为 null 的孤儿", orphanCount() === 1, `orphans=${orphanCount()}`);

console.log("");
if (failures.length) {
  console.log(`store watchdog: ${pass} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  x ${f}`);
} else {
  console.log(`store watchdog: ${pass}/${pass} passed`);
}

// 先关数据库句柄再删临时目录：Windows 上句柄没关会 EPERM，
// 而那个异常会把退出码变成 1 —— 让一个全过的测试看起来是失败的。
try {
  store.db.close();
} catch {
  /* 已经关了就算了 */
}
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* 临时目录删不掉无所谓，绝不能因此改变退出码 */
}
process.exit(failures.length ? 1 : 0);
