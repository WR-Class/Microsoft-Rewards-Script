"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { ControlApiClient, entryToDockerLine } = require("./lib/apiClient");
const { EventHub } = require("./lib/eventHub");
const { parseLine } = require("./lib/parser");
const { resolveLogDir, replayLogFiles } = require("./lib/logFileReplay");
const { Store } = require("./lib/store");
const { describeCron, isValidCron, nextRun } = require("./lib/cron");
const { Scheduler } = require("./lib/scheduler");
const { transformThemeModule } = require("./lib/tsLite");
const { generateIndexModule, THEMES_DIR } = require("./lib/themeLoader");
const { PendingLoginCodes } = require("./lib/pendingLoginCodes");
const { mergeAccounts } = require("./lib/accounts");
const { summarize: summarizeFailures } = require("./lib/failureReasons");
const { listAccounts, upsertAccount, removeAccount } = require("./lib/accountEnv");
const { credentialWriteAllowed, isLoopbackAddress } = require("./lib/netAccess");
const { createApiSupervisor } = require("./lib/apiSupervisor");

// confg
const PORT = Number(process.env.PORT || 8890);
const CONTROL_API_URL =
  process.env.CONTROL_API_URL || "http://microsoft-rewards-script:3010";
const CONTROL_API_TOKEN = process.env.CONTROL_API_TOKEN || "";
const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME || "";
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const DASHBOARD_AUTH_ENABLED = Boolean(
  DASHBOARD_USERNAME && DASHBOARD_PASSWORD,
);
const DISPLAY_NAME = process.env.DASHBOARD_TITLE || "Microsoft Rewards";
const TIMEZONE = process.env.TZ || "UTC";
const POLL_MS = Math.max(1000, Number(process.env.POLL_MS || 5000));
// 启动时重放多少行历史日志。300 行在真实的一天里连一个账号都盖不住
// （2026-10-12 当天 6116 行、7 条 ACCOUNT-END），于是当天已经跑完的账号
// 在面板重启后依然停在 "运行中"。默认提到能覆盖一整天，仍可用 LOG_REPLAY 覆盖。
const LOG_REPLAY = Number(process.env.LOG_REPLAY || 20000);
// Path to the *bot's* .env. Accounts live there, not in this dashboard, and the
// bot only parses that file at start - so this is the one file the account form
// writes, and the feature stays off until an operator names it.
const BOT_ENV_PATH = process.env.BOT_ENV_PATH || "";
const PUBLIC_DIR = path.join(__dirname, "public");

const client = new ControlApiClient({
  baseUrl: CONTROL_API_URL,
  token: CONTROL_API_TOKEN,
});
const store = new Store();
const pendingLoginCodes = new PendingLoginCodes();

const log = (level, msg) => {
  const line = `[server] ${msg}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

// 控制 API 的启动器（lib/apiSupervisor.js）。它要的每一样都已经在配置里：仓库根由
// BOT_ENV_PATH 推出，解释器就用面板自己的 node，端口取面板正在连的那个地址 —— 不新增
// 任何配置键。日志目录与主机上的 scripts/win/start-services.ps1 一致，这样"是谁起的"
// 不会改变日志落在哪。
const API_TARGET = (() => {
  try {
    const u = new URL(CONTROL_API_URL);
    return {
      host: u.hostname,
      port: Number(u.port || (u.protocol === "https:" ? 443 : 80)),
    };
  } catch {
    return { host: "", port: 0 };
  }
})();
// 只有 API 就在本机，面板才可能把它拉起来。容器部署里 CONTROL_API_URL 指向另一个
// 容器，这条路必须自己让开，而不是留一个按了没反应的按钮。
const API_IS_LOCAL =
  API_TARGET.host === "localhost" || isLoopbackAddress(API_TARGET.host);
const API_LOG_DIR =
  process.env.API_LOG_DIR ||
  path.join(process.env.LOCALAPPDATA || __dirname, "RewardsPanel");
const apiSupervisor = createApiSupervisor({
  execPath: process.execPath,
  repoRoot: BOT_ENV_PATH ? path.dirname(BOT_ENV_PATH) : "",
  host: API_TARGET.host,
  port: API_TARGET.port,
  logDir: API_LOG_DIR,
  log,
});

// 补录日志文件里 store 还不知道的账号终态。位置很关键：必须在 EventHub 建立
// 连接之前跑完，否则实时事件先到，补录进来的历史事件会被时间戳守卫挡住。
// 注意不能用 store.lastTs 当起点 —— 那是全局水位，不是每账号进度，用它会让
// 所有历史终态都被判为"旧"而整批跳过（实测跳过了 14517 行）。
// 详见 lib/logFileReplay.js 顶部注释。
const LOG_DIR = resolveLogDir({
  botEnvPath: BOT_ENV_PATH,
  panelDir: __dirname,
  override: process.env.LOG_DIR || "",
});
// 判据用"这条结束在历史里到底有没有"，而不是账号状态 —— 状态会被 store 的清理
// 路径提前改成 success，那恰恰是"还没补过"的信号，不是"不需要补"的信号。
// 用不带过滤的 allHistories（不是 allHistoriesSince，那个要 since 参数），
// 索引在补录之前建一次就够：latest 每个账号只留一条终态，同一次启动不会重复应用。
//
// 键截到秒：实时和补录对同一个事件算出的纳秒来自不同来源（实时用控制 API 的
// entry.id，补录用自己的 seq 计数器），所以完整 ts 上永远不冲突 —— 必须用秒级键，
// 重复才会在**源头**就不被尝试。唯一索引 idx_history_email_sec_unique 是第二道保险。
const secKey = (email, ts) =>
  `${String(email).trim().toLowerCase()}\u0000${String(ts).slice(0, 19)}`;
const historyKeys = new Set();
for (const r of store.stmts.allHistories.all()) {
  historyKeys.add(secKey(r.email, r.ts));
}
const backfill = replayLogFiles({
  dir: LOG_DIR,
  rows: store.snapshotAccounts(),
  apply: (event, opts) => store.apply(event, opts),
  hasHistory: (email, ts) => historyKeys.has(secKey(email, ts)),
  // 只写历史、不动账号状态的那条通道：当天更早的结束靠它补齐（整条 apply 一个
  // 账号只推最新一条，更早的会被 lastStartAt 守卫挡下）。
  recordHistory: (event) =>
    store.stmts.insertHistory.run(
      event.email,
      event.ts,
      event.newPoints,
      event.gained,
      event.durationSec,
    ),
  log,
});
log(
  "info",
  `日志补录 ${LOG_DIR}：读 ${backfill.lines} 行 / 终态 ${backfill.terminal} 条 / 应用 ${backfill.applied} 条 / 补历史 ${backfill.historyAdded} 条` +
    (backfill.unmatched ? ` / store 里没有的账号 ${backfill.unmatched} 个` : ""),
);

const hub = new EventHub({ client, replay: LOG_REPLAY, log });

const scheduler = new Scheduler({
  client,
  store,
  isBusy: () =>
    Boolean(
      backend.bot &&
      backend.bot.state !== "idle" &&
      backend.bot.state !== "unknown",
    ),
  onChange: () => {
    backend.schedule = describeSchedule(scheduler.get());
    hub.broadcast("state", currentState());
  },
  log,
});

function describeSchedule(sched) {
  return {
    ...sched,
    description: sched.enabled
      ? describeCron(sched.cron) || sched.cron
      : "Not scheduled",
  };
}

// The bot's cron lives inside its own container and has no concept of
// "next run" bookkeeping — it's computed here client-side from the same
// cron grammar the dashboard already uses, purely for display. The actual
// firing is up to the container's OS cron, not this calculation.
function describeRemoteSchedule(sched) {
  if (!sched) return null;
  const next =
    sched.enabled && sched.cron ? nextRun(sched.cron, new Date()) : null;
  return {
    ...sched,
    description:
      sched.enabled && sched.cron
        ? describeCron(sched.cron) || sched.cron
        : "Not scheduled",
    nextRunAt: next ? next.toISOString() : null,
  };
}

const AUTH_HINT =
  "Control API rejected our token - CONTROL_API_TOKEN must match the API's API_TOKEN.";

// live
const backend = {
  reachable: false,
  authRequired: false,
  authOk: true,
  lastError: null,
  checkedAt: null,
  name: null,
  version: null,
  uptimeSec: null,
  bot: null, // last /status payload
  schedule: null,
  remoteSchedule: null, // last GET /schedule payload from the bot's Control API
  remoteScheduleSupported: null, // null = unknown yet, true/false once determined
};

let lastLogId = null;
let lastHealthUptime = null;
let lastHealthyCheckedAt = null;

function currentState() {
  return {
    reachable: backend.reachable,
    authRequired: backend.authRequired,
    authOk: backend.authOk,
    lastError: backend.lastError,
    checkedAt: backend.checkedAt,
    displayName: DISPLAY_NAME,
    timezone: TIMEZONE,
    controlApiUrl: CONTROL_API_URL,
    name: backend.name,
    version: backend.version,
    uptimeSec: backend.uptimeSec,
    bot: backend.bot,
    botState: backend.bot ? backend.bot.state : "unknown",
    botRunning: Boolean(backend.bot && backend.bot.state !== "idle"),
    schedule: backend.schedule,
    remoteSchedule: describeRemoteSchedule(backend.remoteSchedule),
    remoteScheduleSupported: backend.remoteScheduleSupported === true,
    stream: hub.stats,
    lastEventAt: store.lastTs,
    pendingDelay: store.pendingDelay,
    codes: pendingLoginCodes.list(),
  };
}

// live logg sse
hub.on("entry", (entry) => {
  try {
    if (!entry) return;
    if (lastLogId != null && entry.id != null && entry.id <= lastLogId) return;

    const line = entryToDockerLine(entry);
    const event = line ? parseLine(line) : null;
    if (event) {
      store.apply(event);
      hub.broadcast("state", currentState());
      if (event.kind === "login-number") {
        pendingLoginCodes.add(event.userName, event.number, event.ts);
        hub.broadcast("codes", { codes: pendingLoginCodes.list() });
      } else if (event.kind === "login-number-resolved") {
        pendingLoginCodes.resolve(event.userName);
        hub.broadcast("codes", { codes: pendingLoginCodes.list() });
      }
    }
    if (entry.id != null)
      lastLogId = lastLogId == null ? entry.id : Math.max(lastLogId, entry.id);
  } catch (e) {
    log("warn", `Could not ingest a log line: ${e.message}`);
  }
});

hub.on("status", (status) => {
  const wasRunning = Boolean(backend.bot && backend.bot.state !== "idle");
  backend.bot = status;

  if (status.reason === "exit" && wasRunning && status.lastExit) {
    try {
      store.closeRunOnExit(status.lastExit);
    } catch (e) {
      log("warn", `Could not record the run exit: ${e.message}`);
    }
  }

  hub.broadcast("state", currentState());
});

// poll
async function pollOnce() {
  let health;
  try {
    health = await client.get("/health");
  } catch (error) {
    if (error.statusCode !== 401) throw error;
    backend.reachable = true;
    backend.authRequired = true;
    backend.authOk = false;
    backend.lastError = AUTH_HINT;
    backend.checkedAt = new Date().toISOString();
    backend.bot = { state: "unknown" };
    return;
  }
  backend.reachable = true;
  backend.name = health.name || null;
  backend.version = health.version || null;
  backend.uptimeSec =
    typeof health.uptimeSec === "number" ? health.uptimeSec : null;
  backend.authRequired = health.authRequired === true;
  // Snapshot before overwriting: this is our cutoff for "definitely started
  // before the restart we're about to react to", not this poll's own time.
  const priorHealthyCheckedAt = lastHealthyCheckedAt;
  backend.checkedAt = new Date().toISOString();
  backend.lastError = null;

  if (typeof health.uptimeSec === "number") {
    if (lastHealthUptime != null && health.uptimeSec < lastHealthUptime) {
      log("warn", "Control API restarted - resetting the log cursor.");
      lastLogId = null;
      // The container (bot + Control API together) can be torn down mid-run
      // for all sorts of ordinary reasons (image update, manual restart,
      // host reboot) - nothing will ever close that run's row on its own
      // since the process that would have logged RUN-END is gone. Close it
      // out now instead of leaving it stuck 'running' until the roster/echo
      // backstop in apply() eventually notices, possibly hours later.
      //
      // The SSE stream can independently notice the same disconnect (its own
      // upstream connection drops) and reconnect faster than our next poll,
      // already tracking a brand new run by the time we get here. Passing
      // notStartedAfter tells the store to only touch a run that was already
      // 'running' as of our last known-good check - never one that could be
      // that legitimate new run.
      try {
        if (
          store.markInterruptedByBackendRestart(new Date().toISOString(), {
            notStartedAfter: priorHealthyCheckedAt,
          })
        ) {
          log("warn", "Closed a run stuck 'running' - the backend restarted mid-run.");
        }
      } catch (e) {
        log("warn", `Could not close the interrupted run: ${e.message}`);
      }
      hub.markUpstreamRestarted();
    }
    lastHealthUptime = health.uptimeSec;
  }
  lastHealthyCheckedAt = backend.checkedAt;

  if (backend.authRequired && !CONTROL_API_TOKEN) {
    backend.authOk = false;
    backend.lastError =
      "Control API requires a token - set CONTROL_API_TOKEN to the same value as its API_TOKEN.";
    backend.bot = { state: health.state || "unknown" };
    return;
  }

  let authFailed = false;

  try {
    backend.bot = await client.get("/status");
  } catch (e) {
    if (e.statusCode === 401) authFailed = true;
    backend.lastError =
      e.statusCode === 401 ? AUTH_HINT : `Status unavailable (${e.message})`;
  }

  // The bot's own /schedule endpoint is optional - older bot images (or ones
  // running without API_ALLOW_SCHEDULE_WRITE) won't have it. A 404 means
  // "not supported, hide the remote scheduler option"; any other error is
  // treated as a transient blip so the UI doesn't flicker the option away.
  try {
    backend.remoteSchedule = await client.get("/schedule");
    backend.remoteScheduleSupported = true;
  } catch (e) {
    backend.remoteSchedule = null;
    if (e.statusCode === 404) backend.remoteScheduleSupported = false;
  }

  backend.schedule = describeSchedule(scheduler.get());

  backend.authOk = !authFailed;
}

async function pollLoop() {
  for (; ;) {
    try {
      await pollOnce();
    } catch (e) {
      backend.reachable = false;
      backend.bot = null;
      backend.lastError = e.message;
      backend.checkedAt = new Date().toISOString();
    }
    hub.broadcast("state", currentState());
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// helpers
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function safeEqual(value, expected) {
  const left = Buffer.from(String(value || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requestBasicCredentials(req) {
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string") return null;

  const match = authorization.match(/^Basic\s+(.+)$/i);
  if (!match) return null;

  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;

    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function isDashboardAuthorized(req) {
  if (!DASHBOARD_AUTH_ENABLED) return true;

  const credentials = requestBasicCredentials(req);
  return (
    credentials !== null &&
    safeEqual(credentials.username, DASHBOARD_USERNAME) &&
    safeEqual(credentials.password, DASHBOARD_PASSWORD)
  );
}

function requireDashboardAuth(res) {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="Rewards Dashboard", charset="UTF-8"',
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end("Authentication required");
}

function readJsonBody(req, limitBytes = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function forward(res, method, apiPath, body) {
  try {
    const data = await client.request(method, apiPath, { body });
    return sendJson(res, 200, data ?? {});
  } catch (e) {
    const status = e.statusCode || 502;
    const payload =
      e.body && typeof e.body === "object"
        ? e.body
        : { error: e.message || "Control API unreachable" };
    if (status === 401) payload.hint = AUTH_HINT;
    return sendJson(res, status, payload);
  }
}

function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type":
        MIME[path.extname(filePath)] || "application/octet-stream",
    });
    res.end(data);
  });
}

function serveThemeIndex(res) {
  res.writeHead(200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(generateIndexModule());
}

function serveThemeFile(res, filename) {
  const filePath = path.join(THEMES_DIR, filename);
  if (!filePath.startsWith(THEMES_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(transformThemeModule(data));
  });
}

// routes
const DIAG_FILES = new Set(["screenshot.png", "error.txt", "dump.html"]);

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method || "GET";

  // live
  if (pathname === "/api/events" && method === "GET") {
    return hub.addClient(req, res, currentState());
  }

  // read
  if (pathname === "/api/summary" && method === "GET") {
    return sendJson(res, 200, {
      status: currentState(),
      accounts: store.snapshotAccounts(),
      runs: store.snapshotRuns(30),
      activity: store.snapshotActivity(120),
    });
  }

  if (pathname === "/api/accounts" && method === "GET") {
    let apiAccounts = [];
    let liveAccounts = [];
    let apiError = null;
    try {
      const data = await client.get("/accounts");
      apiAccounts = data.accounts || [];
    } catch (e) {
      apiError = e.statusCode === 401 ? AUTH_HINT : e.message;
    }
    // Per-account progress of a run that is in flight. Without it an account that is
    // actively working shows its last *completed* run (null -> 0) and its start time.
    try {
      const status = await client.get("/status");
      liveAccounts = (status && status.run && status.run.accounts) || [];
    } catch {
      liveAccounts = [];
    }
    const historyDays = Math.min(
      3650,
      Math.max(0, Number(searchParams.get("historyDays")) || 0),
    );
    const effectiveHistoryDays = searchParams.has("historyDays")
      ? historyDays
      : 365;
    const since =
      effectiveHistoryDays > 0
        ? new Date(
          Date.now() - effectiveHistoryDays * 24 * 60 * 60 * 1000,
        ).toISOString()
        : null;
    const histories =
      effectiveHistoryDays > 0 ? store.allAccountHistories({ since }) : {};
    const accountRows = store.snapshotAccounts();
    return sendJson(res, 200, {
      accounts: mergeAccounts(apiAccounts, accountRows, histories, liveAccounts),
      histories,
      historyDays: effectiveHistoryDays,
      apiError,
      // 失败原因分类：中文"人话"解释 + 原始英文证据，和命令行工具共用同一张判定表。
      // 账号成功时 store 会清空 last_error，所以这里就是"最近一次结果失败"的账号。
      failures: summarizeFailures(accountRows),
    });
  }

  if (pathname === "/api/runs" && method === "GET") {
    const limit = Math.min(
      500,
      Math.max(1, Number(searchParams.get("limit")) || 50),
    );
    let exits = [];
    let apiError = null;
    try {
      const data = await client.get(`/history?limit=${limit}`);
      exits = data.runs || [];
    } catch (e) {
      apiError = e.statusCode === 401 ? AUTH_HINT : e.message;
    }
    return sendJson(res, 200, {
      runs: store.snapshotRuns(limit),
      exits,
      apiError,
    });
  }

  if (pathname === "/api/logs" && method === "GET") {
    const q = new URLSearchParams();
    q.set(
      "limit",
      String(
        Math.min(5000, Math.max(1, Number(searchParams.get("limit")) || 500)),
      ),
    );
    const level = searchParams.get("level");
    if (level) q.set("level", level);
    return forward(res, "GET", `/logs?${q.toString()}`);
  }

  if (pathname === "/api/errors" && method === "GET") {
    const q = new URLSearchParams();
    q.set(
      "limit",
      String(
        Math.min(1000, Math.max(1, Number(searchParams.get("limit")) || 100)),
      ),
    );
    if (searchParams.get("warnings") === "false") q.set("warnings", "false");
    return forward(res, "GET", `/errors?${q.toString()}`);
  }

  if (pathname === "/api/login-codes" && method === "GET") {
    return sendJson(res, 200, { codes: pendingLoginCodes.list() });
  }

  // schedule
  if (pathname === "/api/schedule") {
    if (method === "GET") {
      return sendJson(res, 200, {
        local: describeSchedule(scheduler.get()),
        remote: describeRemoteSchedule(backend.remoteSchedule),
        remoteSupported: backend.remoteScheduleSupported === true,
      });
    }
    if (method === "PUT") {
      const body = await readJsonBody(req);
      const target = body.target === "remote" ? "remote" : "local";
      const patch = { ...body };
      delete patch.target;

      if (target === "remote") {
        if (backend.remoteScheduleSupported !== true) {
          return sendJson(res, 409, {
            error:
              "The bot's Control API does not support remote scheduling. Upgrade the bot image and set API_ALLOW_SCHEDULE_WRITE=true, or use the dashboard's own scheduler instead.",
          });
        }
        try {
          const updated = await client.put("/schedule", patch);
          backend.remoteSchedule = updated;
          hub.broadcast("state", currentState());
          return sendJson(res, 200, {
            local: describeSchedule(scheduler.get()),
            remote: describeRemoteSchedule(updated),
            remoteSupported: true,
          });
        } catch (e) {
          const status = e.statusCode || 502;
          const payload =
            e.body && typeof e.body === "object"
              ? e.body
              : { error: e.message || "Control API unreachable" };
          return sendJson(res, status, payload);
        }
      }

      try {
        const updated = scheduler.set(patch);
        return sendJson(res, 200, {
          local: describeSchedule(updated),
          remote: describeRemoteSchedule(backend.remoteSchedule),
          remoteSupported: backend.remoteScheduleSupported === true,
        });
      } catch (e) {
        return sendJson(res, e.code === "BAD_REQUEST" ? 400 : 500, {
          error: e.message,
        });
      }
    }
  }

  if (pathname === "/api/cron" && method === "GET") {
    const expr = searchParams.get("expr") || "";
    const valid = isValidCron(expr);
    return sendJson(res, 200, {
      expr,
      valid,
      description: valid ? describeCron(expr) : null,
      error: valid
        ? null
        : "Needs 5 fields: minute hour day-of-month month day-of-week.",
    });
  }

  // config
  if (pathname === "/api/config") {
    if (method === "GET") {
      const reveal = searchParams.get("reveal") === "1" ? "?reveal=1" : "";
      return forward(res, "GET", `/config${reveal}`);
    }
    if (method === "PUT" || method === "PATCH") {
      const body = await readJsonBody(req);
      return forward(res, method, "/config", body);
    }
  }

  if (pathname === "/api/config/diff" && method === "GET") {
    return forward(res, "GET", "/config/diff");
  }

  if (pathname === "/api/config/sync" && method === "POST") {
    return forward(res, "POST", "/config/sync", {});
  }

  // diag
  if (pathname === "/api/diagnostics" && method === "GET") {
    return forward(res, "GET", "/diagnostics");
  }

  if (pathname.startsWith("/api/diagnostics/") && method === "GET") {
    const parts = pathname
      .slice("/api/diagnostics/".length)
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    if (parts.length !== 2) return sendJson(res, 404, { error: "Not found" });
    const [name, file] = parts;
    if (!/^error-[A-Za-z0-9._:-]+$/.test(name) || !DIAG_FILES.has(file)) {
      return sendJson(res, 400, { error: "Invalid diagnostics path" });
    }
    try {
      const upstream = await client.stream(
        `/diagnostics/${encodeURIComponent(name)}/${encodeURIComponent(file)}`,
      );
      res.writeHead(200, {
        "Content-Type":
          upstream.headers["content-type"] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      return upstream.pipe(res);
    } catch (e) {
      return sendJson(res, e.statusCode || 502, { error: e.message });
    }
  }

  // sessions
  if (pathname === "/api/sessions" && method === "GET") {
    return forward(res, "GET", "/sessions");
  }

  if (pathname.startsWith("/api/sessions/") && method === "DELETE") {
    const email = pathname.slice("/api/sessions/".length);
    if (!email) return sendJson(res, 400, { error: "Missing account email" });
    return forward(res, "DELETE", `/sessions/${email}`);
  }

  // dashboard-local account data (separate from the bot's own accounts/
  // sessions, which live on the Control API and are untouched by this)
  if (pathname.startsWith("/api/dashboard-accounts/") && method === "DELETE") {
    const email = decodeURIComponent(
      pathname.slice("/api/dashboard-accounts/".length),
    );
    if (!email) return sendJson(res, 400, { error: "Missing account email" });
    try {
      store.deleteAccount(email);
      hub.broadcast("state", currentState());
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // The bot's accounts live in its own .env, which it parses once at start.
  // This is the only path that adds one without hand-editing a file, so it is
  // gated twice over (opt-in BOT_ENV_PATH + authenticated or loopback caller)
  // and it never returns a stored secret.
  if (pathname === "/api/accounts/manage" && method === "GET") {
    let accounts = [];
    let readError = null;
    if (BOT_ENV_PATH) {
      try {
        accounts = listAccounts(BOT_ENV_PATH);
      } catch (e) {
        readError = e.message;
      }
    }
    return sendJson(res, 200, {
      enabled: Boolean(BOT_ENV_PATH),
      envPath: BOT_ENV_PATH || null,
      accounts,
      readError,
      // The bot reads .env at start, so a saved account is inert until restart.
      restartRequired: true,
    });
  }

  if (pathname === "/api/accounts/manage" && method === "POST") {
    const gate = credentialWriteAllowed({
      remoteAddress: req.socket.remoteAddress,
      dashboardAuthEnabled: DASHBOARD_AUTH_ENABLED,
      envPath: BOT_ENV_PATH,
    });
    if (!gate.allowed) {
      return sendJson(res, gate.status, { error: gate.error, hint: gate.hint });
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      // A malformed body is the caller's mistake, not a server fault.
      return sendJson(res, 400, { error: `请求体不是合法 JSON：${e.message}` });
    }
    try {
      const result = upsertAccount(BOT_ENV_PATH, body);
      // Email is logged because the bot's own logs and this dashboard already
      // display full addresses; the password and TOTP secret never are.
      log(
        "info",
        `Account ${result.created ? "added" : "updated"} in the bot's .env: index=${result.index} email=${body.email} (secrets not logged)`,
      );
      return sendJson(res, 200, { ok: true, ...result, restartRequired: true });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (pathname.startsWith("/api/accounts/manage/") && method === "DELETE") {
    const gate = credentialWriteAllowed({
      remoteAddress: req.socket.remoteAddress,
      dashboardAuthEnabled: DASHBOARD_AUTH_ENABLED,
      envPath: BOT_ENV_PATH,
    });
    if (!gate.allowed) {
      return sendJson(res, gate.status, { error: gate.error, hint: gate.hint });
    }

    const index = Number(decodeURIComponent(pathname.slice("/api/accounts/manage/".length)));
    if (!Number.isInteger(index) || index < 1) {
      return sendJson(res, 400, { error: "账号索引不合法。" });
    }
    try {
      const result = removeAccount(BOT_ENV_PATH, index);
      log("info", `Account removed from the bot's .env: index=${index} removed=${result.removed}`);
      return sendJson(res, 200, { ok: true, ...result, restartRequired: true });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // control
  if (pathname.startsWith("/api/control/") && method === "POST") {
    const action = pathname.slice("/api/control/".length);

    // 这个动作在面板**自己的进程里**处理，绝不转发：它要修的就是转发通道本身
    // （API 一死就没有接收方，app.js 里那个"重启"正是因此失效）。它比其他动作重
    // 一档 —— 它在执行进程 —— 所以闸门也自己上，判据与账号写入完全一致。
    if (action === "api-start") {
      if (!DASHBOARD_AUTH_ENABLED && !isLoopbackAddress(req.socket.remoteAddress)) {
        return sendJson(res, 403, {
          error: "为安全起见，只有本机请求可以启动控制 API。",
          hint: "设置 DASHBOARD_USERNAME / DASHBOARD_PASSWORD 开启面板登录后，才允许其他机器操作。",
        });
      }
      if (!API_IS_LOCAL) {
        return sendJson(res, 409, {
          error: "控制 API 不在本机，面板起不了它。",
          hint: `CONTROL_API_URL 指向 ${API_TARGET.host}（容器部署就是这样），请在那边启动。`,
        });
      }
      return sendJson(res, 200, await apiSupervisor.start());
    }

    if (!["start", "stop", "restart", "shutdown"].includes(action)) {
      return sendJson(res, 404, { error: "Unknown control action" });
    }
    const body = await readJsonBody(req);
    return forward(res, "POST", `/${action}`, body);
  }

  // health
  if (pathname === "/api/health" && method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      controlApi: backend.reachable,
      controlApiAuthOk: backend.authOk,
      streamConnected: hub.connected,
    });
  }

  return sendJson(res, 404, { error: "Not found", path: pathname });
}

const server = http.createServer((req, res) => {
  if (!isDashboardAuthorized(req)) return requireDashboardAuth(res);

  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  if (pathname === "/themes/index.js") return serveThemeIndex(res);
  if (pathname.startsWith("/themes/") && pathname.endsWith(".ts")) {
    return serveThemeFile(res, pathname.slice("/themes/".length));
  }

  if (pathname.startsWith("/api/")) {
    return handleApi(req, res, url).catch((e) => {
      log("error", `Request failed: ${e.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: e.message });
    });
  }

  return serveStatic(res, pathname);
});

server.listen(PORT, () => {
  log("info", `Rewards dashboard listening on :${PORT}`);
  log(
    "info",
    `Control API: ${CONTROL_API_URL}${CONTROL_API_TOKEN ? " (token set)" : " (no token)"}`,
  );
  if (!CONTROL_API_TOKEN) {
    log(
      "warn",
      "CONTROL_API_TOKEN is empty - this only works if the Control API runs without an API_TOKEN.",
    );
  }
  if (Boolean(DASHBOARD_USERNAME) !== Boolean(DASHBOARD_PASSWORD)) {
    log(
      "warn",
      "Dashboard authentication is disabled because both DASHBOARD_USERNAME and DASHBOARD_PASSWORD must be set.",
    );
  }
  log(
    "info",
    `Dashboard authentication: ${DASHBOARD_AUTH_ENABLED ? `enabled (user: ${DASHBOARD_USERNAME})` : "disabled"}`,
  );
  log(
    "info",
    `Account editing: ${BOT_ENV_PATH ? `enabled -> ${BOT_ENV_PATH}` : "disabled (set BOT_ENV_PATH to the bot's .env)"}`,
  );
  if (BOT_ENV_PATH && !DASHBOARD_AUTH_ENABLED) {
    log(
      "warn",
      "Account editing is restricted to loopback requests. Set DASHBOARD_USERNAME and DASHBOARD_PASSWORD to allow it from other machines.",
    );
  }
  scheduler.init();
  backend.schedule = describeSchedule(scheduler.get());
  hub.start();
  pollLoop();
});

function shutdown() {
  log("info", "Shutting down…");
  scheduler.stop();
  hub.stop();
  store.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);