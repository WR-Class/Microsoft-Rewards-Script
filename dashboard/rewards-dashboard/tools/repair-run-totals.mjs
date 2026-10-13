#!/usr/bin/env node
// 用日志里的 RUN-END 行重算 runs 表的总计字段。
//
// 为什么需要：lib/parser.js 以前把 RUN-END 行的「（另有 N 个账号…未计入）」括注丢掉，
// 于是把部分和当总量落库（例如 9/10 账号余额未知却存成 new_total=0）。修复只防新增，
// 已经写进去的旧行不会自己变。这个工具按权威来源（日志的 RUN-END 行）把旧行重算一遍。
//
// 匹配键：按 end_ts 找最近的 run，容差 TOLERANCE_MS。
// 实测 19 条 RUN-END 行：最近的 end_ts 最远差 829ms，次近的至少差 36.2 秒，
// 且任意两个 end_ts 的最小间隔是 36.2 秒 —— 所以 ±5 秒是下方 6 倍、上方 7 倍余量。
// 不用精确等值：DB 的 end_ts 由另一条路径的时间戳生成，实测会出现 1ms 级偏差
//（如 row .516 vs 日志行 .517），精确等值只能命中 8/19。
// 只改有 RUN-END 行的记录；崩溃/停止/中断那些没有 RUN-END 的行是另一套来源
// （store.js 用 account_history 推导），这里不碰。
//
//   node tools/repair-run-totals.mjs           -> 干跑，只打印将要改什么
//   node tools/repair-run-totals.mjs --apply   -> 真写（单事务）
//
// 日志时间戳是本地时间（机器 TZ = UTC+8），runs.end_ts 是 UTC，转换偏移见 TZ_OFFSET_HOURS。

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const TZ_OFFSET_HOURS = 8;

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { parseLine } = require(path.join(here, "..", "lib", "parser.js"));
const { DatabaseSync } = require("node:sqlite");

const panelDir = path.join(here, "..");
const botDir = path.join(panelDir, "..", "..");
const logsDir = path.join(botDir, "logs");
const dbPath = path.join(panelDir, "data", "dashboard.sqlite");
const apply = process.argv.includes("--apply");

const show = (v) => (v === null || v === undefined ? "null" : String(v));

// ── 1. 把 logs/*.log 里每条 RUN-END 行解析成权威值 ────────────────────────────
function authoritativeRunEnds() {
  const out = [];
  const files = fs
    .readdirSync(logsDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f))
    .sort();
  for (const f of files) {
    for (const raw of fs.readFileSync(path.join(logsDir, f), "utf8").split(/\r?\n/)) {
      if (!raw.includes("[RUN-END]")) continue;
      const head = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d+) /.exec(raw);
      if (!head) {
        out.push({ file: f, ms: null, raw, bad: "时间戳解析失败" });
        continue;
      }
      // 本地时间 -> UTC：把本地墙上时间当 UTC 解析，再减去偏移。
      const ms = Date.parse(`${head[1]}T${head[2]}Z`) - TZ_OFFSET_HOURS * 3600 * 1000;
      const ev = parseLine(`${head[1]}T${head[2]}Z ${raw.slice(head[0].length)}`);
      out.push({
        file: f,
        ms,
        raw,
        msg: raw.replace(/^.*\[RUN-END\] /, ""),
        annotated: /未计入/.test(raw),
        gained: ev ? ev.totalGained : undefined,
        old: ev ? ev.oldTotal : undefined,
        now: ev ? ev.newTotal : undefined,
        bad: ev ? null : "parseLine 返回 null",
      });
    }
  }
  return out;
}

// ── 2. 与 runs 表按 end_ts 毫秒对齐 ──────────────────────────────────────────
const runEnds = authoritativeRunEnds();
if (runEnds.some((e) => e.bad)) {
  for (const e of runEnds.filter((x) => x.bad)) {
    console.log(`  !! ${e.file}: ${e.bad} —— ${e.raw.slice(0, 100)}`);
  }
  console.log("有 RUN-END 行解析不了，先修解析再回来修数据。退出。");
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 8000");

const rows = db
  .prepare("SELECT id, status, start_ts, end_ts, total_gained, old_total, new_total FROM runs")
  .all();

const TOLERANCE_MS = 5000;
const withEnd = rows
  .map((r) => ({ ...r, endMs: r.end_ts ? Date.parse(r.end_ts) : NaN }))
  .filter((r) => !Number.isNaN(r.endMs));

const planned = [];
const problems = [];
for (const e of runEnds) {
  const ranked = withEnd
    .map((r) => ({ r, diff: Math.abs(r.endMs - e.ms) }))
    .sort((a, b) => a.diff - b.diff);
  const first = ranked[0];
  const second = ranked[1];
  if (!first || first.diff > TOLERANCE_MS) {
    problems.push(`${e.file} ${new Date(e.ms).toISOString()} 最近的一行 end_ts 差了 ${first ? first.diff : "-"}ms，超出容差`);
    continue;
  }
  if (second && second.diff - first.diff < 1000) {
    problems.push(`${e.file} ${new Date(e.ms).toISOString()} 最近与次近只差 ${second.diff - first.diff}ms，不敢猜是哪一行`);
    continue;
  }
  const r = first.r;
  const want = { total_gained: e.gained, old_total: e.old, new_total: e.now };
  const changed = Object.keys(want).filter((k) => r[k] !== want[k]);
  if (changed.length) planned.push({ row: r, end: e, want, changed });
}

console.log("");
console.log(`RUN-END 行 ${runEnds.length} 条，其中带"未计入"注解的 ${runEnds.filter((e) => e.annotated).length} 条`);
console.log(`命中唯一 run 的 ${runEnds.length - problems.length} 条；需要改的 ${planned.length} 行；对不上的 ${problems.length} 条`);
for (const p of problems) console.log(`  ?? ${p}（没有 RUN-END 的行不在这里，属正常）`);

if (!planned.length) {
  console.log("\n没有要改的行。");
  db.close();
  process.exit(0);
}

console.log("");
console.log("将要修改（字段: 旧 -> 新；只列真正变的字段）：");
for (const p of planned) {
  const r = p.row;
  const parts = p.changed.map((k) => {
    const label = { total_gained: "gained", old_total: "old", new_total: "new" }[k];
    return `${label} ${show(r[k])} -> ${show(p.want[k])}`;
  });
  console.log(`  ${String(r.status).padEnd(9)} ${new Date(p.end.ms).toISOString()}  (${p.end.annotated ? "有注解" : "无注解"})`);
  console.log(`    ${parts.join(" ; ")}`);
  console.log(`    原文: ${p.end.msg}`);
}

if (!apply) {
  console.log("\n干跑结束，什么都没写。加 --apply 才真改。");
  db.close();
  process.exit(0);
}

const upd = db.prepare(
  "UPDATE runs SET total_gained = ?, old_total = ?, new_total = ? WHERE id = ?"
);
db.exec("BEGIN IMMEDIATE");
try {
  for (const p of planned) {
    upd.run(p.want.total_gained, p.want.old_total, p.want.new_total, p.row.id);
  }
  db.exec("COMMIT");
  console.log(`\n已写入 ${planned.length} 行。`);
} catch (err) {
  db.exec("ROLLBACK");
  console.log(`\n写入失败，已回滚：${err.message}`);
  db.close();
  process.exit(1);
}

// 写后复核：重读一遍，确认每行都等于权威值。
const after = db.prepare("SELECT id, total_gained, old_total, new_total FROM runs").all();
const byId = new Map(after.map((r) => [r.id, r]));
let bad = 0;
for (const p of planned) {
  const a = byId.get(p.row.id);
  if (a.total_gained !== p.want.total_gained || a.old_total !== p.want.old_total || a.new_total !== p.want.new_total) {
    bad += 1;
    console.log(`  !! 复核不符: ${p.row.id}`);
  }
}
console.log(bad ? `复核发现 ${bad} 行不符` : `复核通过：${planned.length} 行都等于日志里的权威值`);
db.close();
process.exit(bad ? 1 : 0);
