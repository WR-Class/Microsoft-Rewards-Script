#!/usr/bin/env node
// RUN-END 部分和的回归测试（对应 lib/parser.js 的 PARTIAL_*_RE / isPartialSum）。
//
// 背景：bot 的 RUN-END 行在账号被排除时会带括注，括注说明同一行里那个数字是**部分和**：
//   「（另有 N 个账号基线未知，未计入）」  挂在 原余额
//   「（另有 N 个账号余额未知，未计入）」  挂在 现余额
// 括注必须是非捕获的，否则消费方的下标会整体平移；也正因为它非捕获，解析器需要
// 用独立正则把注解再取一次。以前没取，运行记录页把一个 9/10 账号余额未知的部分和
// 当成"现余额 0"显示（runs 表 2026-10-12T00:20Z 那行，对应日志 2026-10-12.log:6405）。
//
//   node tools/test-parser-runend.mjs          -> 只跑固定用例
//   node tools/test-parser-runend.mjs --logs   -> 再把 logs/*.log 里每条 RUN-END 重解析一遍
//                                                 （验不变量，不需要联网、不需要 bot 在跑）
// 全部通过时 exit 0，任一断言不成立 exit 1。

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { parseLine } = require(path.join(here, "..", "lib", "parser.js"));

let pass = 0;
const failures = [];

// 与 local/test-parser-zh.js 同一种行构造，好让两边可以互相搬运用例。
const TS = "2026-10-12T13:32:56.707000000Z ";
const app = (message) =>
  `${TS}[2026/10/12 13:32:56] [MAIN] [INFO] MAIN [RUN-END] ${message}`;

function assertFields(name, line, expected) {
  const got = parseLine(line);
  if (got === null) {
    failures.push(`${name}: parseLine returned null`);
    return;
  }
  const bad = [];
  for (const [key, want] of Object.entries(expected)) {
    if (got[key] !== want) {
      bad.push(`${key}: want ${JSON.stringify(want)}, got ${JSON.stringify(got[key])}`);
    }
  }
  if (bad.length) failures.push(`${name}: ${bad.join("; ")}`);
  else pass += 1;
}

const check = (name, message, expected) => assertFields(name, app(message), expected);

// ── 固定用例 ────────────────────────────────────────────────────────────────
// 四条中文消息体逐字取自真实日志：
// logs/2026-10-12.log:6405、:16111，logs/2026-10-13.log:7416、:7901
check(
  "两种注解都有 -> 三个字段全 null",
  "全部账户完成 | 处理账户数=10 | 获得积分=0 | 原余额=0（另有 9 个账号基线未知，未计入） | 现余额=0（另有 9 个账号余额未知，未计入） | 运行分钟数=312.0",
  { kind: "run-end", accountsProcessed: 10, totalGained: null, oldTotal: null, newTotal: null, runtimeMin: 312 }
);
check(
  "只有基线未知 -> 现余额仍保留真值",
  "全部账户完成 | 处理账户数=10 | 获得积分=0 | 原余额=0（另有 10 个账号基线未知，未计入） | 现余额=6751 | 运行分钟数=418.2",
  { kind: "run-end", accountsProcessed: 10, totalGained: null, oldTotal: null, newTotal: 6751, runtimeMin: 418.2 }
);
check(
  "单账号被排除（N=1 也要置 null）",
  "全部账户完成 | 处理账户数=1 | 获得积分=0 | 原余额=0（另有 1 个账号基线未知，未计入） | 现余额=470 | 运行分钟数=24.4",
  { kind: "run-end", accountsProcessed: 1, totalGained: null, oldTotal: null, newTotal: 470, runtimeMin: 24.4 }
);
check(
  "没有注解 -> 数字照旧保留",
  "全部账户完成 | 处理账户数=1 | 获得积分=30 | 原余额=265 | 现余额=295 | 运行分钟数=42.9",
  { kind: "run-end", accountsProcessed: 1, totalGained: 30, oldTotal: 265, newTotal: 295, runtimeMin: 42.9 }
);
check(
  "英文形态不受影响",
  "Completed all accounts | accountsProcessed=2 | pointsGained=200 | previousBalance=2000 | currentBalance=2200 | runtimeMinutes=30.1",
  { kind: "run-end", accountsProcessed: 2, totalGained: 200, oldTotal: 2000, newTotal: 2200, runtimeMin: 30.1 }
);

// ── 真实日志全量重解析（--logs）─────────────────────────────────────────────
// 不变量，故意不用生产代码那两条正则去判断"有没有注解"：
//   ① 只要行里有任何「另有 N 个账号…未计入」，差额就不可信 -> totalGained 必须 null。
//      这一条不依赖注解的具体措辞，所以将来 bot 换了说法（"另有 N 个账号口径未知"之类）
//      也会被抓住。
//   ② 带「基线未知」注解 -> oldTotal 必须 null；带「余额未知」注解 -> newTotal 必须 null。
//   ③ 没有注解的字段必须等于行里写的那个数（双向核对，防止"一律置 null"式的过度修复）。
const ANY_ANNOTATION = /另有 \d+ 个账号[^）]*未计入/;

function numberIn(msg, label) {
  const m = new RegExp(`${label}=(-?\\d+|null)`).exec(msg);
  if (!m) return undefined;
  return m[1] === "null" ? null : Number(m[1]);
}

function sweepLogs(logsDir) {
  const files = fs
    .readdirSync(logsDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f))
    .sort();
  let lines = 0;
  let annotated = 0;
  for (const f of files) {
    for (const raw of fs.readFileSync(path.join(logsDir, f), "utf8").split(/\r?\n/)) {
      if (!raw.includes("[RUN-END]")) continue;
      lines += 1;
      const head = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d+) (.*)$/.exec(raw);
      const got = parseLine(head ? `${head[1]}T${head[2]}Z ${head[3]}` : raw);
      if (got === null) {
        failures.push(`${f}: RUN-END 行解析失败: ${raw.slice(0, 100)}`);
        continue;
      }
      const msg = raw.replace(/^.*\[RUN-END\] /, "");
      const hasAny = ANY_ANNOTATION.test(msg);
      if (hasAny) annotated += 1;

      if (hasAny && got.totalGained !== null) {
        failures.push(`${f}: 有"未计入"注解但 totalGained=${JSON.stringify(got.totalGained)}`);
      } else if (!hasAny && got.totalGained !== numberIn(msg, "获得积分")) {
        failures.push(`${f}: 无注解，totalGained 与行内数值不符（${JSON.stringify(got.totalGained)} vs ${numberIn(msg, "获得积分")}）`);
      } else {
        pass += 1;
      }

      const baselineUnknown = /另有 \d+ 个账号基线未知/.test(msg);
      const balanceUnknown = /另有 \d+ 个账号余额未知/.test(msg);
      assertFields(
        `${f} oldTotal`,
        head ? `${head[1]}T${head[2]}Z ${head[3]}` : raw,
        { oldTotal: baselineUnknown ? null : numberIn(msg, "原余额") }
      );
      assertFields(
        `${f} newTotal`,
        head ? `${head[1]}T${head[2]}Z ${head[3]}` : raw,
        { newTotal: balanceUnknown ? null : numberIn(msg, "现余额") }
      );
    }
  }
  console.log(
    `    扫了 ${files.length} 个日志文件、${lines} 条 RUN-END 行，其中带"未计入"注解的 ${annotated} 条`
  );
}

if (process.argv.includes("--logs")) {
  const logsDir = path.join(here, "..", "..", "..", "logs");
  if (fs.existsSync(logsDir)) {
    sweepLogs(logsDir);
  } else {
    console.log(`    （跳过 --logs：没找到 ${logsDir}）`);
  }
}

console.log("");
if (failures.length) {
  console.log(`run-end parser: ${pass} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  x ${f}`);
  process.exit(1);
}
console.log(`run-end parser: ${pass}/${pass} passed`);
