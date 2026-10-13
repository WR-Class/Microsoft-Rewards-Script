#!/usr/bin/env node
// 前端静态检查：拦住"改界面时静默弄坏代码"的几类问题。
// 配套文档：dashboard/docs/designer-guardrails.md
//
// 用法（在 dashboard/rewards-dashboard/ 下）：
//   node tools/check-frontend.mjs
//
// 退出码非 0 = 有 ❌。⚠ 是给人看的清单，不影响退出码。
//
// 为什么需要它：这几类错误都是**静默**的 —— 不报错，只是按钮点不动、
// 图表不渲染、日期差一格。跑一次几秒钟，比在浏览器里逐页点便宜。

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const publicDir = path.join(root, "public");

let failed = false;
const fail = (msg) => { failed = true; console.log("  ❌ " + msg); };
const warn = (msg) => console.log("  ⚠  " + msg);
const info = (msg) => console.log("  ·  " + msg);

// 注释剥离：本仓库的注释里会**讨论**被禁止的写法（例如说明"写成 U.tzDayKey 会抛错"），
// 不剥就会把自己的说明文字当成违规。实测被这件事骗过两次。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const jsFiles = walk(publicDir).filter((f) => f.endsWith(".js"));
console.log(`扫描 ${jsFiles.length} 个前端 js：${path.relative(root, publicDir)}\n`);

// ── 1. U. 越界引用 ────────────────────────────────────────────────────────────
// 用了 U.xxx 却没有 import * as U —— 抛 ReferenceError，且只在渲染那一步炸。
console.log("[1] 模块作用域：用了 U. 就必须 import * as U");
{
  const users = [], offenders = [];
  for (const f of jsFiles) {
    const code = stripComments(fs.readFileSync(f, "utf8"));
    const uses = /(^|[^\w.$])U\.[A-Za-z_$]/.test(code);
    if (!uses) continue;
    users.push(path.relative(publicDir, f));
    if (!/import\s+\*\s+as\s+U\s+from/.test(code)) offenders.push(path.relative(publicDir, f));
  }
  info(`使用 U. 的模块：${users.join(", ") || "无"}`);
  if (offenders.length) fail(`用了 U. 但没 import * as U：${offenders.join(", ")}`);
  else console.log("  ✅ 无越界引用");
}

// ── 2. 浏览器本地日期 getter ──────────────────────────────────────────────────
// 面板 TZ 是 Asia/Shanghai。用本地日历算日期键，浏览器不在 +8 时整张网格偏一格。
console.log("\n[2] 时区：public/ 里不应出现浏览器本地日期 getter");
{
  const patterns = [
    [/\.getDay\s*\(\)/, "getDay()"],
    [/\.getMonth\s*\(\)/, "getMonth()"],
    [/\.getDate\s*\(\)/, "getDate()"],
    [/setDate\s*\(/, "setDate()"],
    [/toLocaleDateString\s*\(/, "toLocaleDateString()"],
  ];
  const hits = [];
  for (const f of jsFiles) {
    const rel = path.relative(publicDir, f);
    if (rel === "util.js") continue; // util.js 是时区工具本身的所在地
    const lines = stripComments(fs.readFileSync(f, "utf8")).split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const [re, name] of patterns) if (re.test(line)) hits.push(`${rel}:${i + 1}  ${name}  ${line.trim().slice(0, 70)}`);
    });
  }
  if (hits.length) {
    warn(`发现 ${hits.length} 处，人工确认它们不是在算日期键：`);
    for (const h of hits.slice(0, 20)) console.log("      " + h);
    if (hits.length > 20) console.log(`      …还有 ${hits.length - 20} 处`);
    console.log("     （日期键请用 U.tzDayKey()，日期加减请用纯 UTC 的键运算）");
  } else console.log("  ✅ 未发现");
}

// ── 3. i18n 字典：重复 key ────────────────────────────────────────────────────
// 同一个 key 在 zh-cn.js 里出现两次时后者覆盖前者，前一条译文静默失效。
console.log("\n[3] i18n：zh-cn.js 里不能有重复 key");
{
  const file = path.join(publicDir, "zh-cn.js");
  if (!fs.existsSync(file)) fail("找不到 public/zh-cn.js");
  else {
    const seen = new Map(), dups = [];
    const re = /^\s*"((?:[^"\\]|\\.)*)"\s*:/gm;
    let m;
    const src = fs.readFileSync(file, "utf8");
    while ((m = re.exec(src))) {
      const key = m[1];
      if (seen.has(key)) dups.push(key);
      else seen.set(key, true);
    }
    info(`字典条目 ${seen.size} 条`);
    if (dups.length) fail(`重复 key：${[...new Set(dups)].join(", ")}`);
    else console.log("  ✅ 无重复");
  }
}

// ── 4. JS 钩子 class（⚠ 供人工确认）──────────────────────────────────────────
// 视图模板里的 class 名如果不在 style.css 里，多半是改名时漏了一处。
console.log("\n[4] class 钩子：JS 模板里用到、但 style.css 里没有的 class");
{
  const cssFile = path.join(publicDir, "style.css");
  const css = fs.existsSync(cssFile) ? fs.readFileSync(cssFile, "utf8") : "";
  const known = new Set();
  for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) known.add(m[1]);
  const htmlFile = path.join(publicDir, "index.html");
  if (fs.existsSync(htmlFile))
    for (const m of fs.readFileSync(htmlFile, "utf8").matchAll(/class="([^"]*)"/g))
      for (const c of m[1].split(/\s+/)) if (c) known.add(c);

  const missing = new Set();
  for (const f of jsFiles) {
    const rel = path.relative(publicDir, f);
    if (rel === "sw.js") continue;
    const code = stripComments(fs.readFileSync(f, "utf8"));
    for (const m of code.matchAll(/class="([^"$]*)"/g))
      for (const c of m[1].split(/\s+/)) if (c && !known.has(c)) missing.add(c);
  }
  if (missing.size) {
    warn(`${missing.size} 个 class 在 JS 模板里出现但 CSS/HTML 里没有（可能是改名漏改，也可能是动态拼接）：`);
    console.log("      " + [...missing].sort().join(", "));
  } else console.log("  ✅ 未发现");
}

console.log(failed ? "\n=> 有 ❌，先修再提交" : "\n=> 通过（⚠ 项需人工过一眼）");
process.exit(failed ? 1 : 0);
