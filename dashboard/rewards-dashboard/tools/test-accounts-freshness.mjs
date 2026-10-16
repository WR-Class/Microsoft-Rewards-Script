#!/usr/bin/env node
// 卡片"最后结果"：谁更新谁说了算，包括"没有错误"。
// 缺陷：当天桌面端成功并拿到积分，卡片仍挂着前一天的 EMAIL_VERIFICATION_INPUT。
// 成因：① ACCOUNT-START 不清 last_error；② 合并按空值回退，而 API 的历史整轮结束才写入。
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { createRequire } from "node:module"; import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-")); // require 之前
const require = createRequire(import.meta.url);
const { Store } = require(path.join(here, "..", "lib", "store.js")); const { mergeAccounts } = require(path.join(here, "..", "lib", "accounts.js"));
let pass = 0; const fails = [];
const assert = (n, ok, d = "") => { if (ok) pass++; else fails.push(n + (d ? `: ${d}` : "")); };
const Y = "2026-10-15T13:46:02.317Z", T = "2026-10-16T02:15:10.409Z";
const OLD = "Login failed or aborted at state: EMAIL_VERIFICATION_INPUT | 最后阶段=桌面端";
// ① ACCOUNT-START 必须清掉上一轮的判决
const store = new Store();
const row = () => store.snapshotAccounts().find((r) => r.email === "a@e.com");
store.apply({ kind: "account-error", email: "a@e.com", ts: Y, error: OLD });
assert("前置 ERROR 记下 last_error", row().lastError === OLD);
store.apply({ kind: "account-start", email: "a@e.com", userName: "a", ts: T });
assert("START 清空且状态 running", row().lastError === null && row().status === "running", JSON.stringify(row().lastError));
// ② 合并：谁的时间更新，谁单独说了算
const merged = (l, api) => mergeAccounts([{ email: "a@e.com", lastRunAt: api.lastRunAt, lastError: api.lastError }], l ? [{ email: "a@e.com", ...l }] : [], {}, [])[0];
const cases = [
  ["今天成功/API 停在昨天 -> 不显示", { status: "success", lastEndAt: T, lastError: null }, { lastRunAt: Y, lastError: OLD }, null],
  ["进行中 -> 不显示上一轮", { status: "running", lastStartAt: T, lastEndAt: Y, lastError: null }, { lastRunAt: Y, lastError: OLD }, null],
  ["本轮真失败 -> 显示本轮", { status: "error", lastEndAt: T, lastError: "本轮失败" }, { lastRunAt: Y, lastError: OLD }, "本轮失败"],
  ["API 才是新的 -> 用 API", { status: "success", lastEndAt: Y, lastError: null }, { lastRunAt: T, lastError: "API 报错" }, "API 报错"],
  ["从没观测过 -> 回退 API（原行为）", null, { lastRunAt: Y, lastError: OLD }, OLD],
];
for (const [n, l, api, want] of cases) assert(n, merged(l, api).lastError === want, `期望 ${JSON.stringify(want)}`);
for (const f of fails) console.log(`  FAIL ${f}`);
console.log(`${pass} 通过，${fails.length} 失败`); try { store.close(); } catch {} try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch {} process.exit(fails.length ? 1 : 0);
