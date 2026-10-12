"use strict";

// 启动时从日志文件补录事件。
//
// 为什么需要这个：面板的账号状态**只由实时事件驱动** ——
//   EventHub -> hub.on("entry") -> entryToDockerLine(entry) -> parseLine -> store.apply
// EventHub 的 replay 选项只把历史发给新连上的浏览器，**不回写 SQLite**。
// 而控制 API 的日志缓冲区只有 2000 行（2026-10-12 当天日志 6116 行）。
//
// 后果：只要漏掉一条结束行，那个账号就永远停在 running，而且**重启也救不回来**。
// 2026-10-12 当天 7 条 ACCOUNT-END 全部因为上游把 原余额/现余额 写成 null
// 而匹配失败，于是当天每一个跑完的账号都卡住了。
//
// 日志文件是唯一的事实源，而且和面板在同一台机器、同一个仓库，所以直接读它。
//
// **必须走和实时完全相同的转换链**：文件行 -> entry 对象 -> entryToDockerLine()
// -> parseLine()。不能把文件行直接丢给 parseLine —— parseLine 要求行首有一个
// Docker 风格的 RFC3339Nano 时间戳，而日志文件里没有，那样会静默地全解析成 null
// （这个坑我踩过一次：14510 行读进来，解析出 0 条事件）。
//
// 两个必须守住的约束：
//
// 1) **必须在 EventHub 连上游之前跑完。** store.apply 有时间戳单调去重
//    （event.ts <= lastTs 就丢弃），实时事件先到的话补录会被整批丢掉。
//
// 2) **必须从 store.lastTs 往后补，不能整个文件重放。** 否则每次重启都会把
//    当天所有事件重新应用一遍，account_history 这类按 (email, ts) 追加的表
//    可能被重复写入，每日图表就会翻倍。

const fs = require("node:fs");
const path = require("node:path");
const { parseLine } = require("./parser");
const { entryToDockerLine } = require("./apiClient");

// 默认看最近两个日志文件：跨零点的一轮运行会横跨两个文件。
const DEFAULT_DAYS = 2;
// 每个文件最多读多少行（从尾部截）。当天 6116 行，给足余量但不无限读。
const DEFAULT_MAX_LINES = 40000;
// 尾部读取的字节上限，避免超大文件被整个读进内存。
const MAX_TAIL_BYTES = 8 * 1024 * 1024;

// Logger.ts 写文件时在行首加的本地时间戳：
//   2026-10-12 08:20:58.065 [2026/10/12 08:20:58] [MAIN] [INFO] MAIN [RUN-START] ...
// 第一段是文件前缀，第二段起才是 parseLine 认识的应用行。
const FILE_LINE_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s(\[[\s\S]*)$/;

/**
 * 日志目录的解析顺序：显式覆盖 -> 从机器人的 .env 路径推 -> 同机同仓库的默认位置。
 * 面板位于 <bot>/dashboard/rewards-dashboard，所以默认位置是 <bot>/logs。
 */
function resolveLogDir({ botEnvPath = "", panelDir = __dirname, override = "" } = {}) {
  if (override) return path.resolve(override);
  if (botEnvPath) {
    return path.join(path.dirname(path.resolve(botEnvPath)), "logs");
  }
  return path.resolve(panelDir, "..", "..", "logs");
}

/**
 * 把日志行的本地时间戳转成 UTC ISO。
 *
 * 用本地时间构造（new Date(y, m-1, d, ...)）而不是 Date.parse("YYYY-MM-DD HH:MM:SS")，
 * 因为后者的行为依赖实现。前提是面板进程的 TZ 和机器一致 —— 这里 .env 设的是
 * TZ=Asia/Shanghai，机器也是 China Standard Time，所以成立。
 * 不一致的话事件时间会整体偏移，顺序仍然对，但历史时间戳会错。
 */
function localStampToUtcIso(stamp) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(stamp);
  if (!m) return null;
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
    Number(m[7]),
  );
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 从文件尾部读最多 maxLines 行；从中间截断时丢掉第一个不完整的行。 */
function readTailLines(file, maxLines = DEFAULT_MAX_LINES) {
  let fd = null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) return [];
    const start = Math.max(0, stat.size - MAX_TAIL_BYTES);
    const length = stat.size - start;
    fd = fs.openSync(file, "r");
    const buf = Buffer.allocUnsafe(length);
    fs.readSync(fd, buf, 0, length, start);
    let text = buf.toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    const lines = text.split(/\r?\n/);
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 关闭失败不值得中断启动 */
      }
    }
  }
}

/** 目录里最新的 N 个 YYYY-MM-DD.log，按文件名升序（= 时间升序）。 */
function listRecentLogFiles(dir, days = DEFAULT_DAYS) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.log$/.test(n))
    .sort()
    .slice(-Math.max(1, days))
    .map((n) => path.join(dir, n));
}

/**
 * 把日志文件里"store 还不知道的账号终态"补上。
 *
 * 关键：**不能用全局水位当起点。** store.lastTs 是"见过的最新事件"，
 * 面板一直在收实时事件，水位已经推到当前时刻；而漏掉的结束行远早于它，
 * 于是整批被跳过（实测：读 14517 行、跳过 14517 行、应用 0 条）。
 * 水位是全局的，而漏事件是**按账号**发生的，两者不是一回事。
 *
 * 所以这里做按账号对账，而不是重放事件流：
 *   1) 先从日志里取每个账号**最后一条终态事件**（account-end / account-error）；
 *   2) 再和 store 的账号行比：只有"行里还是 running，且该终态事件比行的
 *      lastStartAt 新"才补这一条。
 *
 * 只补终态事件，不补 account-start / run-start / generic 这些 —— 它们不影响
 * "谁还在跑"这个判断，补进去反而可能把已经推进的状态往回退。
 * 这样也天然幂等：补完行就不再是 running，下次启动不会重复补，
 * account_history 也不会被重复写入。
 *
 * @param rows store.snapshotAccounts() 的结果（{email, status, lastStartAt} 必需）
 * @param apply 收到 (event, { backfill: true })，必须转交给 store.apply
 */
function replayLogFiles({
  dir,
  days = DEFAULT_DAYS,
  maxLines = DEFAULT_MAX_LINES,
  rows = [],
  apply,
  hasHistory = null,
  recordHistory = null,
  log = () => {},
}) {
  const files = listRecentLogFiles(dir, days);
  if (!files.length) {
    log("warn", `日志补录：${dir} 下没有找到 YYYY-MM-DD.log，跳过`);
    return { files: [], lines: 0, malformed: 0, terminal: 0, applied: 0, unmatched: 0 };
  }

  // 第一步：扫日志，留下每个账号最后一条终态事件。
  const latest = new Map();
  // 每一条终态都留一份（按 (email, ts) 去重）。latest 只用来把账号状态推到最新，
  // 历史表却需要当天更早那几次结束 —— 否则"今天"的差值会从好几天前算起。
  const allTerminal = [];
  const seenTerminal = new Set();
  let lines = 0;
  let malformed = 0;
  let terminal = 0;
  let seq = 0;

  for (const file of files) {
    for (const raw of readTailLines(file, maxLines)) {
      lines++;
      const m = FILE_LINE_RE.exec(raw);
      if (!m) {
        malformed++;
        continue;
      }
      const stamp = m[1];
      const appLine = m[2];
      const utc = localStampToUtcIso(stamp);
      if (!utc) {
        malformed++;
        continue;
      }

      // 造 entry 再走实时的同一个转换函数：raw 给应用行，receivedAt 给事件时间，
      // id 单调递增，让 entryToDockerLine 合成的纳秒部分保持顺序。
      seq++;
      const line = entryToDockerLine({
        raw: appLine,
        ts: appLine.slice(1, appLine.indexOf("]")),
        receivedAt: utc,
        id: seq,
      });
      if (!line) {
        malformed++;
        continue;
      }

      let event = null;
      try {
        event = parseLine(line);
      } catch {
        continue; // 单行解析失败不影响整体补录
      }
      if (!event || !event.email) continue;
      // 余额读数（account-balance-read）不是终态事件，但它是历史里唯一能补上"余额"的
      // 来源 —— 上游在基线不可信时只给读数、不给差额，而 store 的历史行需要 points。
      // 让它走同一套补录机器（同样受 hasHistory 幂等判据和 lastStartAt 时间护栏约束），
      // 只是不计入"终态 N 条"的统计，也不参与"这个账号结束了吗"的判断。
      const isBalanceRead = event.kind === "account-balance-read";
      if (!isBalanceRead && event.kind !== "account-end" && event.kind !== "account-error") {
        continue;
      }
      if (!isBalanceRead) terminal++;

      const prev = latest.get(event.email);
      if (!prev || Date.parse(event.ts) >= Date.parse(prev.ts)) {
        latest.set(event.email, event);
      }
      const terminalKey = `${event.email.trim().toLowerCase()}\u0000${event.ts}`;
      if (!seenTerminal.has(terminalKey)) {
        seenTerminal.add(terminalKey);
        allTerminal.push(event);
      }
    }
  }

  // 第二步：和 store 的行对账。
  const byEmail = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = typeof row?.email === "string" ? row.email.trim().toLowerCase() : "";
    if (key) byEmail.set(key, row);
  }

  let applied = 0;
  let unmatched = 0;
  const appliedKeys = new Set(); // 整条 apply 刚写过的历史行，第三遍要跳过
  for (const [email, event] of latest) {
    const row = byEmail.get(email.trim().toLowerCase());
    if (!row) {
      unmatched++; // store 里没有这个账号，交给实时路径处理
      continue;
    }
    // **判据不是 status，也不是 lastEndAt。** 这两个都会被 store 的清理路径污染：
    // 一轮被中断时 markAccountCompletedWithoutResult 会把还卡在 running 的账号直接
    // 标成 success，并把 last_end_at 写成这次的时间 —— 而**不写 account_history**。
    // 于是"状态已经是 success"和"last_end_at 很新"都恰恰是"这条结束行还没被应用"的
    // 信号，而不是"不需要补"的信号。实测 2026-10-12：两种判据各让补录应用 0 条。
    //
    // 该问的是：这条结束在历史里到底有没有？有就跳过，没有就补。这样天然幂等，
    // 也不依赖任何会被别处改写的字段。hasHistory 由调用方用 store 的历史表建索引；
    // 没传就退回旧的 status 判据（宁可少补，也不要重复插）。
    if (typeof hasHistory === "function") {
      if (hasHistory(email, event.ts)) continue;
    } else if (row.status !== "running") {
      continue;
    }
    // 终态事件必须发生在这行记录的这次开始之后，否则是更早一轮的历史，
    // 补进去会把当前状态往回退。
    if (row.lastStartAt && Date.parse(event.ts) < Date.parse(row.lastStartAt)) {
      continue;
    }
    try {
      // store.apply 的返回值是"状态是否变化"，不是"是否写入成功" ——
      // account-end 可能写进去了却返回 false。所以只以"没抛异常"为准，
      // 否则日志里会出现"应用 0 条"而状态其实已经改了的误导性输出。
      apply(event, { backfill: true });
      applied++;
      appliedKeys.add(`${email.trim().toLowerCase()}\u0000${event.ts}`);
    } catch (e) {
      log("warn", `日志补录：${email} 应用失败 ${e.message}`);
    }
  }

  // 第三步：把**当天更早那些**结束补进历史表 —— 只写历史，不动账号状态。
  // 上面的整条 apply 一个账号只推最新一条（而且受 lastStartAt 守卫，免得把账号
  // 状态往回退），所以更早的结束只能走这条只写历史的路。没有 recordHistory
  // 就整段跳过：宁可少补，也不要重复插。
  let historyAdded = 0;
  if (typeof recordHistory === "function" && typeof hasHistory === "function") {
    for (const event of allTerminal) {
      if (event.kind !== "account-end") continue; // account-error 不进历史表
      const key = `${event.email.trim().toLowerCase()}\u0000${event.ts}`;
      if (appliedKeys.has(key)) continue; // 刚被整条 apply 写过，别插第二遍
      if (hasHistory(event.email, event.ts)) continue; // 早就有了
      try {
        recordHistory(event);
        historyAdded++;
      } catch (e) {
        log("warn", `日志补录：${event.email} 写历史失败 ${e.message}`);
      }
    }
  }

  return { files, lines, malformed, terminal, applied, historyAdded, unmatched };
}

module.exports = {
  resolveLogDir,
  localStampToUtcIso,
  listRecentLogFiles,
  readTailLines,
  replayLogFiles,
  DEFAULT_DAYS,
  DEFAULT_MAX_LINES,
};
