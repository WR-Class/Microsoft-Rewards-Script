"use strict";

// Docker prepends an RFC3339Nano timestamp (because we request timestamps=1),
// e.g: "2026-07-01T12:03:12.123456789Z <rest of line>"
const DOCKER_TS_RE = /^(\S+)\s([\s\S]*)$/;

// App log format (src/logging/Logger.ts):
// [localTime] [userName] [LEVEL] PLATFORM [TITLE] message
const APP_LINE_RE =
  /^\[([^\]]+)\]\s\[([^\]]+)\]\s\[([^\]]+)\]\s(\S+)\s\[([^\]]+)\]\s([\s\S]*)$/;

// The chiihero "V4-china" branch keeps every log TITLE in ASCII
// (ACCOUNT-START, RUN-END, ...) - so the title dispatch below is unchanged -
// but translates the message BODIES to Chinese. Every pattern in this file
// therefore accepts both wordings, with the language-specific labels wrapped
// in non-capturing groups: the capture-group count and order stay exactly
// what the switch branches below expect, so no call site had to change.
const ACCOUNT_START_RE =
  /^(?:Starting account|开始处理账户):\s*(\S+)\s*\|\s*geoLocale:\s*(.*?)(?:\s*\|\s*locale:.*)?$/;
// 上游在数字位置写 "null" 时，必须变成真正的 null 而不是 0 或 NaN。
// Number("null") === NaN，会让下游拿到一个既不是数字也不是"未知"的值。
const numOrNull = (s) => (s === "null" ? null : Number(s));

// 上游 src/index.ts 在"基线未知"（部分仪表板 / flyout 回退）时会把数字写成 null
// 而不是数字。原先这里只认 \d+，于是这些行完全匹配不上 —— 结束事件不触发，
// 账号就永远停在 running。实测 2026-10-12 全天 7 条结束行，7 条全是 null 形式，
// 也就是说这一天所有跑完的账号都卡住了。
const ACCOUNT_END_RE =
  /^(?:Completed account|账户完成):\s*(\S+)\s*\|\s*(?:pointsGained|获得积分)=(-?\d+|null)\s*\|\s*(?:previousBalance|原余额)=(\d+|null)\s*\|\s*(?:currentBalance|现余额)=(\d+|null)\s*\|\s*(?:durationSeconds|持续秒数)=([\d.]+)$/;

// 上游在基线未知时**不再发 ACCOUNT-END**，改发一条 FLOW 级别的 WARN：
//   积分已收集（基线未知，不报差额） | 现余额=500 | 账户=x@outlook.com
// 账户在**最后**，且没有获得积分/原余额/持续秒数 —— 差额是"不知道"（null），
// 余额是读到的真值。
//
// 实测 2026-10-12：这条行当天出现 26 次，一条都没被识别，于是 account-end
// 事件数为 0，account_history 从 10-11 起再没写进新行，而 accounts 表靠清理
// 路径照常更新 —— 面板于是显示"成功 + 今天没有运行"。所以这不是文案问题，
// 是整个结束事件消失了。括号里的话用 [^）]* 放宽，别把措辞钉死。
// bot: src/browser/ReactFunc.ts —— 解析任务子项后发一条
//   已解析任务子项 | 总数=3 | 可上报=1
// 可上报 = 未完成且未锁定未禁用（上游 reportable = !!hash && !isCompleted && !isLocked
// && !isDisabled，L718），所以 已完成 = 总数 - 可上报。
//
// 为什么不用"任务列表 | 父任务=N | 未完成=M"那条：它的 complete 依赖抓取片段里出现
// "2 / 3 tasks" 形式的进度文本（ReactFunc.ts:771-772）。实测 4 天 135 行、10 个账号，
// 一次都没匹配到 —— 未完成恒等于父任务，完成数恒为 0。那条行的数字是死的。
// 这条是活的：196 行里 133 行 可上报==总数、63 行 可上报<总数，且随着账号跑起来
// 可上报单调减少（05:06 总38/可上报21 -> 11:26 总35/可上报13）。
//
// 两个数字必须来自同一行：父任务（MOBILE 2 / DESKTOP 3）与子项总数（1~5）粒度不同，
// 跨行相减没有意义。
const TASK_ITEMS_RE = /^已解析任务子项\s*\|\s*总数=(\d+)\s*\|\s*可上报=(\d+)\s*$/;
const FLOW_POINTS_COLLECTED_RE =
  /^积分已收集（[^）]*）\s*\|\s*(?:currentBalance|现余额)=(-?\d+|null)\s*\|\s*(?:account|账户)=(\S+)$/;
// English "email: message"; the fork logs "email | 错误=message".
// 「初始余额不可信（部分仪表板）| 读到=N | 本轮不报差额 | 账户=x」：上游自己说开局余额
// 不可信，所以本轮不报差额。但"读到"的那个值是目前唯一能填上余额的读数 —— 按
// "读数是读数、差额是结论"的原则接住它：只记一条余额快照，绝不当作一次完成。
const FLOW_INITIAL_UNTRUSTED_RE =
  /^初始余额不可信（[^）]*）\|\s*读到=(-?\d+|null)\s*\|\s*本轮不报差额\s*\|\s*账户=(\S+@\S+)\s*$/;
const ACCOUNT_ERR_RE = /^(\S+@\S+)(?::\s*|\s*\|\s*错误=)([\s\S]*)$/;

// src/index.ts's per-account flow wrapper (Mobile.ts / Desktop.ts) logs this
// under title FLOW at ERROR level when an account's automation throws -
// e.g. a login timeout - but does NOT also log a titled ACCOUNT-ERROR line
// for it. That means an account that dies this way looks, to everything
// keyed off the ACCOUNT-ERROR title (account resolution counts, the
// dashboard's own "is this account still running" check), exactly like a
// worker that's still silently in progress - it never leaves 'running'.
// Observed in production for both the mobile and desktop flow wrappers, so
// this is treated as an equally authoritative account-level failure signal.
// English "Mobile flow failed for email: reason"; the fork logs
// "email 的移动端流程失败: reason" (or 桌面端 for the desktop wrapper). The
// prefix is optional so the fork's bare "email 的...流程失败" form is caught
// too - this pattern exists precisely to stop a dead account from sitting in
// 'running' forever, so under-matching is the expensive failure here.
const FLOW_FAILED_RE =
  /^(?:(?:Mobile|Desktop) flow failed for\s)?(\S+@\S+)\s*(?::|的[^:]*流程失败:)\s*([\s\S]*)$/;
const RUN_START_RE =
  /^(?:Starting Microsoft Rewards Script|启动微软奖励脚本)\s*\|\s*v([\w.\-]+)\s*\|\s*(?:Accounts|账户数):\s*(\d+)\s*\|\s*(?:Clusters|集群数):\s*(\d+)$/;
// 同一原因：全部账户完成那一行现在可能带 "（另有 N 个账号基线未知，未计入）" 这种
// 括注，夹在数字和 " | " 之间，所以每个数字后面都允许一个可选的中文括注；
// 数字本身也可能是 null。
const RUN_END_RE =
  /^(?:Completed all accounts|全部账户完成)\s*\|\s*(?:accountsProcessed|处理账户数)=(\d+)\s*\|\s*(?:pointsGained|获得积分)=(-?\d+|null)(?:（[^）]*）)?\s*\|\s*(?:previousBalance|原余额)=(\d+|null)(?:（[^）]*）)?\s*\|\s*(?:currentBalance|现余额)=(\d+|null)(?:（[^）]*）)?\s*\|\s*(?:runtimeMinutes|运行分钟数)=([\d.]+)$/;
// RUN-END 行里的「（另有 N 个账号基线未知，未计入）」/「（另有 N 个账号余额未知，未计入）」
// 说明同一行里那个数字是**部分和**，不是总量。上面两个可选括注把注解吞掉了（它们必须非捕获，
// 否则 am[3]/am[4]/am[5] 会整体平移 —— 同样的理由见 scripts/api/logParser.js 的 RUN-END 注释），
// 所以这里用独立正则把注解再取一次。
// 实测：库里有 8 行 new_total=0，其中 runs 表 2026-10-12T00:20Z 那条对应的日志行写着
// 「现余额=0（另有 9 个账号余额未知，未计入）」—— 9/10 未知的部分和被当成"现余额 0"显示。
const PARTIAL_BASELINE_RE = /（另有 (\d+) 个账号基线未知，未计入）/;
const PARTIAL_BALANCE_RE = /（另有 (\d+) 个账号余额未知，未计入）/;
function isPartialSum(re, message) {
  const m = re.exec(message);
  return !!(m && Number(m[1]) > 0);
}
// src/index.ts's waitBeforeNextAccount() - with accountDelay, accounts start
// one at a time now rather than together, so this wait can be a large
// fraction of the run's total time.
const ACCOUNT_DELAY_RE =
  /^(?:Waiting|等待)\s*([\d.]+)\s*(?:seconds before starting the next account|秒后开始下一个账户)(?:\s*\((\S+@\S+)\))?$/;
const STREAK_PROTECTION_RE =
  /^(?:Snapshot complete|快照完成)\s\|\soffers=(\d+)\s\|\s(?:reportable|可上报)=(\d+)\s\|\sstreaks=(\d+)\s\|\s(?:streakProtectionEnabled|连续保护已启用)=(true|false)\s\|\s(?:streakProtectionRemainingDays|连续保护剩余天数)=(\d+|null)\s\|\s(?:streakCounter|连续计数)=(\d+|null)\s\|\s(?:level|等级)=([^|]+)\s\|\s(?:account|账户)=(\S+@\S+)$/;

// src/browser/auth/methods/PasswordlessLogin.ts - the only login flow that
// logs an actual value a human needs to act on before the bot can proceed
// (TOTP-with-secret is auto-filled and deliberately never logged; manual
// TOTP/email code entry waits on a raw stdin prompt with no code the bot
// itself knows, so there's nothing to surface for those).
const LOGIN_NUMBER_RE =
  /^(?:Please approve login and select number|请批准登录并选择数字):\s*(\d+)$/;
const LOGIN_NUMBER_RESOLVED_RE =
  /^(?:Approval detected|Login approved successfully|Login approval failed or timed out|Approval timeout after \d+ seconds!|检测到批准|登录批准成功|\d+\s*秒后批准超时!|批准请求已过期.*)$/;

// scripts/docker/run_daily.sh wraps the actual `npm start` in a flock-style
// lockfile and echoes its own lifecycle lines directly to stdout (not
// through Logger.ts), format: "[<bash date>] [run_daily.sh] <message>".
// `release_lock` runs via `trap ... EXIT INT TERM`, so "Lock released" fires
// even if npm start crashes outright - making this a much more reliable
// "is a run currently in progress" signal than the app's own RUN-START/
// RUN-END, which a hard crash could skip entirely.
const WRAPPER_LINE_RE = /^\[[^\]]*\]\s\[run_daily\.sh\]\s([\s\S]*)$/;
const WRAPPER_LOCK_ACQUIRED_RE =
  /^Lock acquired successfully\s\(PID:\s*(\d+)\)$/;
const WRAPPER_LOCK_RELEASED_RE = /^Lock released\s\(PID:\s*(\d+)\)$/;
// "Script finished" is printed right before the wrapper's natural exit
// (which is what triggers the EXIT trap that logs "Lock released"). Kept as
// its own event kind (see store.js) rather than folded into "Lock released",
// because "Lock released" fires from the EXIT trap even after a crash/kill,
// so it can't be trusted as completion evidence by itself either.
const WRAPPER_SCRIPT_FINISHED_RE = /^Script finished$/;
// Explicit successful completion signal from the API-triggered execution
// path. Distinguished from WRAPPER_SCRIPT_FINISHED_RE because "Script
// finished" alone is weaker evidence - some wrapper versions print it
// unconditionally on the way out, including right after a failure.
const WRAPPER_SCRIPT_COMPLETED_RE =
  /^Script completed successfully(?:\s*\(via API\))?\.?$/;
// Mirrors WRAPPER_SCRIPT_COMPLETED_RE's optional "(via API)" qualifier -
// observed in production as "ERROR: Script failed (via API)!" when the run
// was invoked through the Control API, vs. the bare form for a cron-invoked
// run.
const WRAPPER_SCRIPT_FAILED_RE = /^ERROR: Script failed(?:\s*\(via API\))?!$/;

// Cluster worker lifecycle, e.g.:
// [MAIN] [WARN] MAIN [CLUSTER-WORKER-EXIT] Worker 34781 exit | Code: 0 | Signal: n/a | Active workers: 0
//
// Parsed as a structured event (rather than left as "generic") because the
// store uses Code + Signal + Active workers as one of its signals for
// whether the whole clustered process completed cleanly, as a fallback for
// when RUN-END itself never gets logged.
const CLUSTER_WORKER_EXIT_RE =
  /^(?:Worker|worker)\s+(\d+)\s+(?:exit|退出)\s*\|\s*(?:Code|代码):\s*(-?\d+|n\/a)\s*\|\s*(?:Signal|信号):\s*([^|]+?)\s*\|\s*(?:Active workers|活跃worker数):\s*(\d+)$/;

// The fork logs "跳过账户: email | 原因=Fraud_UserWarning_BotScore_UX | 持续秒数=N"
// under an ACCOUNT-SKIP title upstream's parser had no case for. FIRST_EMAIL_RE
// is the language-tolerant fallback: whatever the wording, the skipped
// account's address is the first email-shaped token in the line.
const ACCOUNT_SKIP_RE =
  /^跳过账户:\s*(\S+)\s*\|\s*原因=([^|]*?)\s*\|\s*持续秒数=([\d.]+)$/;
const FIRST_EMAIL_RE = /(\S+@\S+)/;

/**
 * Strips the leading Docker timestamp, returns { dockerTs, rest }.
 */
function splitDockerTimestamp(rawLine) {
  const m = DOCKER_TS_RE.exec(rawLine);
  if (!m) return { dockerTs: null, rest: rawLine };
  return { dockerTs: m[1], rest: m[2] };
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Parses one raw docker-log line into a structured event, or null if it
 * doesn't match the app's log format at all (defensive - unrelated stdout).
 */
function parseLine(rawLine) {
  const { dockerTs, rest } = splitDockerTimestamp(rawLine);
  if (!dockerTs) return null;

  const clean = rest.replace(ANSI_RE, "");
  const m = APP_LINE_RE.exec(clean);
  if (!m) {
    return parseWrapperLine(dockerTs, clean);
  }

  const [, appTime, userName, level, platform, title, message] = m;

  const base = {
    ts: dockerTs,
    appTime,
    userName,
    level: level.toLowerCase(),
    platform,
    title,
    message,
    raw: clean,
  };

  switch (title) {
    case "ACCOUNT-START": {
      const am = ACCOUNT_START_RE.exec(message);
      if (am)
        return {
          ...base,
          kind: "account-start",
          email: am[1],
          geoLocale: am[2],
        };
      break;
    }
    case "ACCOUNT-END": {
      const am = ACCOUNT_END_RE.exec(message);
      if (am) {
        // 上游用 null 表示"不知道"。必须原样变成 null：Number("null") 是 NaN，
        // 而当成 0 更糟 —— 那等于把"不知道"写成"没赚到"。
        return {
          ...base,
          kind: "account-end",
          email: am[1],
          gained: numOrNull(am[2]),
          oldPoints: numOrNull(am[3]),
          newPoints: numOrNull(am[4]),
          durationSec: Number(am[5]),
        };
      }
      break;
    }
    case "FLOW": {
      // FLOW 是通用标题（今天 665 条），只在这里"试着"认出两种；认不出就 break，
      // 照旧走后面的 generic 处理，不能因为加了这一支就把别的 FLOW 行吃掉。
      //
      // 两个分支必须在**同一个 case 标签**里：switch 只认第一个匹配的标签，
      // 一旦写成两个 case "FLOW"，后面的那个就是永不执行的死代码。
      // 实测教训：新增完成分支时把失败分支写成了第二个 case "FLOW"，于是
      // FLOW_FAILED_RE 全文件只有一个使用点却永远走不到 —— 失败的账号再也
      // 标不上 account-error，RUN-END 时被 markAccountCompletedWithoutResult
      // 写成 success，界面把失败的账号显示成"成功"。
      const fm = FLOW_POINTS_COLLECTED_RE.exec(message);
      if (fm) {
        return {
          ...base,
          // title 必须跟着一起改写。store 的 accountsResolvedSince 按
          // title IN ('ACCOUNT-END','ACCOUNT-ERROR') 计数，沿用 FLOW 的话这些完成行
          // 对运行结算完全不可见（DB 里已有 4 行 title=FLOW kind=account-end）。
          // 该计数是 COUNT(DISTINCT email)，所以与配对的那条 ACCOUNT-END 行不会重复计。
          title: "ACCOUNT-END",
          kind: "account-end",
          email: fm[2],
          gained: null, // 基线未知 = 差额不知道，不是 0
          oldPoints: null,
          newPoints: numOrNull(fm[1]),
          durationSec: null, // 这一行不带持续秒数
        };
      }
      // 余额读数，不是完成。store 里对应 account-balance-read：只写一条历史快照，
      // 不改 status、不算 resolved —— 读一条余额不等于跑完一次。
      const fu = FLOW_INITIAL_UNTRUSTED_RE.exec(message);
      if (fu) {
        return {
          ...base,
          kind: "account-balance-read",
          email: fu[2],
          newPoints: numOrNull(fu[1]),
          gained: null, // 上游明说"本轮不报差额"，不把读数伪装成差额
          oldPoints: null,
          durationSec: null,
        };
      }
      // 失败行。复用已有的 account-error 事件类型（不新增 kind），因为 store 的
      // 结算计数和孤儿清理都按 title === 'ACCOUNT-ERROR' 走，这样不用改 store.js
      // 就能接上；原始的 FLOW 标题和正文仍可从 raw 完整恢复。
      if (level.toLowerCase() === "error") {
        const ff = FLOW_FAILED_RE.exec(message);
        if (ff) {
          return {
            ...base,
            title: "ACCOUNT-ERROR",
            kind: "account-error",
            email: ff[1],
            error: ff[2],
          };
        }
      }
      break;
    }
    case "ACCOUNT-ERROR": {
      const am = ACCOUNT_ERR_RE.exec(message);
      if (am)
        return { ...base, kind: "account-error", email: am[1], error: am[2] };
      return { ...base, kind: "account-error", email: null, error: message };
    }
    case "RUN-START": {
      const am = RUN_START_RE.exec(message);
      if (am) {
        return {
          ...base,
          kind: "run-start",
          version: am[1],
          totalAccounts: Number(am[2]),
          clusters: Number(am[3]),
        };
      }
      break;
    }
    case "RUN-END": {
      const am = RUN_END_RE.exec(message);
      if (am) {
        // 有账号被排除在合计之外时，这一行报的是部分和。留 null 而不是留数字：
        // 宁可让界面显示 "–"（不知道），也不把一个把未知当 0 的偏低数当总量。
        // 与 scripts/api/logParser.js 的 collected 用同一套判断。
        const partialBaseline = isPartialSum(PARTIAL_BASELINE_RE, message);
        const partialBalance = isPartialSum(PARTIAL_BALANCE_RE, message);
        return {
          ...base,
          kind: "run-end",
          accountsProcessed: Number(am[1]),
          // 获得积分没有自己的注解：只要有任何账号被排除，差额就不可信。
          totalGained:
            partialBaseline || partialBalance ? null : numOrNull(am[2]),
          oldTotal: partialBaseline ? null : numOrNull(am[3]),
          newTotal: partialBalance ? null : numOrNull(am[4]),
          runtimeMin: Number(am[5]),
        };
      }
      break;
    }
    case "ACCOUNT-DELAY": {
      const am = ACCOUNT_DELAY_RE.exec(message);
      if (am)
        return {
          ...base,
          kind: "account-delay",
          seconds: Number(am[1]),
          nextEmail: am[2] || null,
        };
      break;
    }
    case "REACT-PARSE": {
      const sub = TASK_ITEMS_RE.exec(message);
      if (sub) {
        const total = Number(sub[1]);
        const reportable = Number(sub[2]);
        return {
          ...base,
          kind: "task-progress",
          total,
          reportable,
          completed: total - reportable,
        };
      }
      const protection = STREAK_PROTECTION_RE.exec(message);
      if (protection) {
        return {
          ...base,
          kind: "streak-protection",
          email: protection[8],
          enabled: protection[4] === "true",
          remainingDays:
            protection[5] === "null" ? null : Number(protection[5]),
          streakCounter:
            protection[6] === "null" ? null : Number(protection[6]),
        };
      }
      break;
    }
    case "LOGIN-PASSWORDLESS": {
      const numMatch = LOGIN_NUMBER_RE.exec(message);
      if (numMatch)
        return { ...base, kind: "login-number", number: numMatch[1] };
      if (LOGIN_NUMBER_RESOLVED_RE.test(message)) {
        return { ...base, kind: "login-number-resolved" };
      }
      break;
    }
    case "CLUSTER-WORKER-EXIT": {
      const wm = CLUSTER_WORKER_EXIT_RE.exec(message);
      if (wm) {
        const code = wm[2].toLowerCase() === "n/a" ? null : Number(wm[2]);
        const rawSignal = wm[3].trim();
        const signal =
          !rawSignal || rawSignal.toLowerCase() === "n/a"
            ? null
            : rawSignal;
        return {
          ...base,
          kind: "cluster-worker-exit",
          pid: Number(wm[1]),
          code,
          signal,
          activeWorkers: Number(wm[4]),
        };
      }
      break;
    }
    case "ACCOUNT-SKIP": {
      // The V4-china fork skips an account outright when Microsoft's bot-score
      // warning fires. Upstream's parser had no case for this title at all, so
      // a skipped account looked to the store exactly like a worker still
      // silently in progress and never left 'running'. Reusing the
      // ACCOUNT-ERROR title - the same trick the FLOW case above uses - makes
      // the store's existing resolution counting pick it up with no store.js
      // change. The original title and message stay recoverable from `raw`.
      const skip = ACCOUNT_SKIP_RE.exec(message);
      const skipEmail = skip ? skip[1] : (FIRST_EMAIL_RE.exec(message) || [])[1];
      if (skipEmail) {
        return {
          ...base,
          title: "ACCOUNT-ERROR",
          kind: "account-error",
          email: skipEmail,
          error: skip
            ? `已跳过（${skip[2]}，${skip[3]} 秒）`
            : `已跳过（${message}）`,
        };
      }
      break;
    }
    default:
      break;
  }

  // Fall through: no specific structured match, but still a valid app log
  // line. Kept as a generic event so warnings/errors show up in the feed.
  return { ...base, kind: "generic" };
}

/**
 * Parses a run_daily.sh wrapper line (not part of Logger.ts's format).
 * Returns null for lines that don't match at all, or a 'generic' event for
 * wrapper lines that aren't one of the specific lifecycle events we track.
 */
function parseWrapperLine(dockerTs, clean) {
  const wm = WRAPPER_LINE_RE.exec(clean);
  if (!wm) return null;
  const message = wm[1];

  const base = {
    ts: dockerTs,
    userName: "run_daily.sh",
    level: "info",
    platform: "MAIN",
    title: "WRAPPER",
    message,
    raw: clean,
  };

  const acquired = WRAPPER_LOCK_ACQUIRED_RE.exec(message);
  if (acquired)
    return { ...base, kind: "wrapper-lock-acquired", pid: acquired[1] };

  const released = WRAPPER_LOCK_RELEASED_RE.exec(message);
  if (released)
    return { ...base, kind: "wrapper-lock-released", pid: released[1] };

  if (WRAPPER_SCRIPT_COMPLETED_RE.test(message)) {
    return { ...base, kind: "wrapper-script-completed" };
  }

  if (WRAPPER_SCRIPT_FINISHED_RE.test(message)) {
    return { ...base, kind: "wrapper-script-finished" };
  }

  if (WRAPPER_SCRIPT_FAILED_RE.test(message)) {
    return { ...base, level: "error", kind: "wrapper-script-failed" };
  }

  // Other wrapper lines (self-heal messages, "Starting script...", etc.)
  // aren't needed for run-tracking; ignore rather than adding feed noise.
  return null;
}

module.exports = { parseLine };
