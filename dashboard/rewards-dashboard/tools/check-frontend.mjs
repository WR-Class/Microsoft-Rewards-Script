#!/usr/bin/env node
// 前端静态检查 —— 拦住"改界面时静默弄坏代码"的问题。
//
// 用法（在 dashboard/rewards-dashboard/ 下）：
//   node tools/check-frontend.mjs
//
// 它不做构建、不联网、不改文件，只读 public/ 下的源码，几秒钟跑完。
// 配套文档：dashboard/docs/designer-guardrails.md
//
// 为什么需要它：它查的这几类问题**都不会报错**。不抛异常、控制台不红字，
// 只是某个按钮点不动、某张图不渲染、某个日期差一格、某段样式静默失效。
// 跑一次几秒钟，比在浏览器里逐页点便宜得多。

import fs from "node:fs";
import path from "node:path";

// ── 输出记号 ─────────────────────────────────────────────────────────────────
// 让任何人都能直接看懂该不该动手，不用去猜严重程度。
const MARK = {
  fail: "❌ 必须修",
  warn: "⚠  看一眼",
  info: "ℹ  仅告知",
  ok: "✅ 没问题",
};

const root = path.resolve(import.meta.dirname, "..");
const publicDir = path.join(root, "public");

let failures = 0;
let warnings = 0;
let infos = 0;

const fail = (msg, detail) => { failures++; console.log(`  ${MARK.fail}  ${msg}`); if (detail) console.log(`        ${detail}`); };
const warn = (msg, detail) => { warnings++; console.log(`  ${MARK.warn}  ${msg}`); if (detail) console.log(`        ${detail}`); };
const info = (msg, detail) => { infos++; console.log(`  ${MARK.info}  ${msg}`); if (detail) console.log(`        ${detail}`); };
const ok = (msg) => console.log(`  ${MARK.ok}  ${msg}`);
const why = (msg) => console.log(`        为什么查：${msg}`);
const todo = (msg) => console.log(`        怎么办：${msg}`);

// ── 工具 ─────────────────────────────────────────────────────────────────────

// 注释剥离。必须做，而且必须**每个检查都做**。
// 这个仓库的注释里会讨论被禁止的写法（"写成 U.tzDayKey 会抛错"、
// "原来是 setHours(12) + setDate(...)"），不剥就会把说明文字本身当成违规。
// 实测被这件事骗过五次，所以这里不给自己留后路。
const stripJs = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const stripCss = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const read = (p) => fs.readFileSync(p, "utf8");
const rel = (p) => path.relative(publicDir, p);

const allFiles = walk(publicDir);
const jsFiles = allFiles.filter((f) => f.endsWith(".js"));
const indexHtml = path.join(publicDir, "index.html");

// 被"检查 class 有没有人用"这个用途共享的语料：
// 除 sw.js 之外的全部前端 js + index.html，都剥过注释。
const haystack = [
  ...jsFiles.filter((f) => path.basename(f) !== "sw.js").map((f) => stripJs(read(f))),
  fs.existsSync(indexHtml) ? stripJs(read(indexHtml)) : "",
].join("\n");

console.log("前端静态检查");
console.log(`扫描 ${jsFiles.length} 个 js + style.css + index.html（目录：public/）`);
console.log("");
console.log("记号说明：❌ 必须修（会让本脚本以非 0 退出）｜⚠ 需要人看一眼｜ℹ 只是告知｜✅ 没问题");

// ── [1] 模块作用域 ───────────────────────────────────────────────────────────
console.log("\n[1] 模块作用域：用了 U.xxx 的模块，必须 import * as U");
why("前端有两种导入写法（import * as U / 具名导入），混用会抛 ReferenceError。");
why("它只在**渲染那一步**才炸，而且被外层的 catch 吞掉，面板上显示成「xxx 刷新失败：U is not defined」。");
{
  const users = [];
  const offenders = [];
  for (const f of jsFiles) {
    const code = stripJs(read(f));
    if (!/(^|[^\w.$])U\.[A-Za-z_$]/.test(code)) continue;
    users.push(rel(f));
    if (!/import\s+\*\s+as\s+U\s+from/.test(code)) offenders.push(rel(f));
  }
  console.log(`        使用 U. 的模块：${users.join("、") || "无"}`);
  if (offenders.length) {
    fail(`用了 U. 但没 import * as U：${offenders.join("、")}`);
    todo("在该文件顶部加 import * as U from \"../util.js\"（或改成具名导入并把 U.xxx 改掉）。");
  } else {
    ok("所有用到 U. 的模块都正确导入了");
  }
}

// ── [2] 时区 ─────────────────────────────────────────────────────────────────
console.log("\n[2] 时区：日期键不能用浏览器本地日历算");
why("面板的 TZ 固定为 Asia/Shanghai，而历史数据的 ts 是 UTC。用浏览器本地日历做日期加减时，");
why("浏览器不在 +8 时整列日期键会偏移一天（实测 UTC-4 会偏一天），热力图整张网格跟着偏一格。");
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
    const r = rel(f);
    if (r === "util.js") continue; // util.js 是时区工具本身的所在地
    stripJs(read(f)).split(/\r?\n/).forEach((line, i) => {
      for (const [re, name] of patterns)
        if (re.test(line)) hits.push(`${r}:${i + 1}  ${name}  ${line.trim().slice(0, 70)}`);
    });
  }
  if (hits.length) {
    warn(`发现 ${hits.length} 处本地日期 getter：`);
    for (const h of hits.slice(0, 20)) console.log(`        ${h}`);
    if (hits.length > 20) console.log(`        …另有 ${hits.length - 20} 处`);
    todo("确认它们不是在算日期键。日期键请用 U.tzDayKey()，加减请用 U.keyAddDays()/U.recentDayKeys()。");
  } else {
    ok("没有本地日期 getter");
  }
}

// ── [3] i18n ─────────────────────────────────────────────────────────────────
console.log("\n[3] i18n：public/zh-cn.js 里不能有重复 key");
why("同一个 key 定义两次时，后一条静默覆盖前一条。两处译文一样就看不出来，");
why("改了其中一条才发现没生效 —— 而界面上只会显示另一条。");
{
  const file = path.join(publicDir, "zh-cn.js");
  if (!fs.existsSync(file)) {
    fail("找不到 public/zh-cn.js");
  } else {
    const seen = new Set();
    const dups = [];
    const re = /^\s*"((?:[^"\\]|\\.)*)"\s*:/gm;
    let m;
    const src = read(file);
    while ((m = re.exec(src))) {
      if (seen.has(m[1])) dups.push(m[1]);
      else seen.add(m[1]);
    }
    console.log(`        字典条目 ${seen.size} 条`);
    if (dups.length) {
      fail(`重复 key：${[...new Set(dups)].join("、")}`);
      todo("删掉后出现的那一条（保留靠前的那组里的定义）。");
    } else {
      ok("没有重复 key");
    }
  }
}

// ── [4] CSS 里有没有"没人用"的规则 ───────────────────────────────────────────
console.log("\n[4] CSS 死规则：style.css 定义了、但前端从来不用的 class");
why("最常见的原因是**在 JS 里改了 class 名、CSS 没跟着改** —— 那条样式就静默失效了，");
why("页面看起来只是「没生效」，没有任何报错。另一种原因是历史遗留的死代码，无害但会一直堆着。");
why("判断「用过」的口径：名字字面出现在 js/html 里，或由模板串动态拼出（如 heatmap-level-${n} 这种）。");
{
  const cssFile = path.join(publicDir, "style.css");
  const rawCss = fs.existsSync(cssFile) ? read(cssFile) : "";
  const css = stripCss(rawCss);
  const cssClasses = new Set();
  for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) cssClasses.add(m[1]);

  // 动态构造的前缀：`heatmap-level-${level}` 这种，前缀连到 - 为止。
  const dynamicPrefixes = new Set();
  for (const m of haystack.matchAll(/([A-Za-z][\w-]*-)\$\{/g)) dynamicPrefixes.add(m[1]);

  const cssLines = rawCss.split(/\r?\n/);
  const unused = [];
  for (const c of cssClasses) {
    if (new RegExp(`\\b${c.replace(/-/g, "\\-")}\\b`).test(haystack)) continue;
    // 允许被动态拼出：该 class 在某个 - 边界上的前缀 + ${ 出现在前端
    const prefixes = [];
    for (let i = 0; i < c.length; i++) if (c[i] === "-") prefixes.push(c.slice(0, i + 1));
    if (prefixes.some((p) => dynamicPrefixes.has(p))) continue;
    const lineNo = cssLines.findIndex((l) => new RegExp(`\\.${c}(?![\\w-])`).test(l)) + 1;
    unused.push({ c, lineNo });
  }

  console.log(`        style.css 定义 ${cssClasses.size} 个 class；动态构造的前缀 ${dynamicPrefixes.size} 个`);
  if (unused.length) {
    warn(`${unused.length} 个 class 没人用：`);
    for (const u of unused) console.log(`        style.css:${u.lineNo}  .${u.c}`);
    todo("逐个确认：如果这个名字是刚在 JS 里改过的，把 CSS 里的旧名一起改掉；");
    todo("如果确实没人要了，删掉这条规则（git 里还能找回来）。");
  } else {
    ok("每个 class 都有人用（字面引用或动态拼出）");
  }
}

// ── [5] JS 模板里的 class 分类 ───────────────────────────────────────────────
console.log("\n[5] JS 模板里用到、但没有 CSS 规则的 class（分类告知，不是错误）");
why("这类 class 有三种完全不同的来源，混在一起看没有意义，所以分开列。");
why("三种都不是错误 —— 这一节是给设计师的参考：哪些名字目前没有任何样式。");
{
  const css = fs.existsSync(path.join(publicDir, "style.css")) ? stripCss(read(path.join(publicDir, "style.css"))) : "";
  const known = new Set();
  for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) known.add(m[1]);
  if (fs.existsSync(indexHtml))
    for (const m of read(indexHtml).matchAll(/class="([^"]*)"/g))
      for (const c of m[1].split(/\s+/)) if (c) known.add(c);

  const hook = new Map();     // 被 JS 选择器使用 —— 有意的钩子
  const inline = new Map();   // 同一个标签上带 style= —— 样式写在标签上
  const semantic = new Map(); // 什么都没有 —— 目前没有任何样式

  for (const f of jsFiles) {
    const r = rel(f);
    if (r === "sw.js") continue;
    const src = stripJs(read(f));
    for (const m of src.matchAll(/class="([^"$]*)"/g)) {
      // 取这个 class 所在的那个标签：往前找 <，往后找 >
      const start = src.lastIndexOf("<", m.index);
      const end = src.indexOf(">", m.index + m[0].length);
      const tag = start >= 0 && end > start ? src.slice(start, end) : "";
      const hasInlineStyle = /style\s*=/.test(tag);
      const line = src.slice(0, m.index).split(/\r?\n/).length;
      for (const c of m[1].split(/\s+/)) {
        if (!c || known.has(c)) continue;
        const where = `${r}:${line}`;
        if (hasInlineStyle) { if (!inline.has(c)) inline.set(c, where); continue; }
        // 是否被 JS 当选择器用
        const used = src.split(/\r?\n/).some((l) =>
          new RegExp(`\\b${c}\\b`).test(l) &&
          /querySelector|closest|matches|classList|\$\$?\(|getElementsBy/.test(l));
        const bucket = used ? hook : semantic;
        if (!bucket.has(c)) bucket.set(c, where);
      }
    }
  }

  const show = (title, map, note) => {
    console.log(`        ${title}（${map.size} 个）${note}`);
    for (const [c, where] of [...map].sort()) console.log(`            .${c}   ${where}`);
  };
  show("① JS 钩子", hook, " — 正常：JS 靠它找元素，样式由同标签上的其它 class 提供");
  show("② 自带内联样式", inline, " — 正常：样式就写在那个标签的 style= 上");
  show("③ 无任何样式", semantic, " — 目前没有 CSS 规则，也没有 JS 用它");
  if (hook.size + inline.size + semantic.size === 0) ok("没有这类 class");
  else {
    info(`共 ${hook.size + inline.size + semantic.size} 个，其中只有 ③ 需要考虑要不要加样式`);
    if (semantic.size) todo("要给 ③ 加样式，就在 style.css 里写规则；不改也没问题，它们只是语义标记。");
  }
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────
console.log("");
console.log("─".repeat(60));
if (failures) {
  console.log(`结果：${MARK.fail} ${failures} 项，${MARK.warn} ${warnings} 项，${MARK.info} ${infos} 项`);
  console.log("有 ❌，先修再提交。");
} else {
  console.log(`结果：${MARK.ok} 没有必须修的问题（${MARK.warn} ${warnings} 项，${MARK.info} ${infos} 项）`);
  if (warnings) console.log("⚠ 项请人过一眼，它们可能是问题，也可能是有意为之。");
}
process.exit(failures ? 1 : 0);
