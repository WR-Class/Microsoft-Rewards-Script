import * as U from "../util.js";
import { cached } from "../api.js";
// Import BOTH chart builders
import { buildAccumBarHtml, buildHeatmapHtml, lineChart } from "../charts.js";

let data = null;
let accountsPayload = null;
let rootEl = null;
let mounted = false;
let context = null;

let selected = null;

// Persistent view mode storage helpers
const VIEW_STORAGE_KEY = "rewards_dashboard_view_mode";
let viewMode = localStorage.getItem(VIEW_STORAGE_KEY) || "accum"; // Load stored view or default to 'accum'

const launching = new Set();

const NUMERIC = /^[+\-\u2013]?[\d,.]*$/;

function statCard(id, value, unit, label, iconClass = "stat-icon-check", icon = "\u2713") {
  const small = NUMERIC.test(String(value).trim()) ? "" : " stat-value-sm";
  return `
        <div class="stat-card">
            <div class="stat-block-chip${small ? " chip-sm-wrap" : ""}">
                <span class="stat-num-val${small}" id="${id}">${value}</span>
                <span class="stat-block-unit">${U.escapeHtml(unit)}</span>
            </div>
            <div class="stat-title-row">
                <span class="${iconClass}" aria-hidden="true">${icon}</span>
                <span class="stat-label">${U.escapeHtml(label)}</span>
            </div>
        </div>`;
}

function activeSchedule(status) {
  const local = status?.schedule || null;
  const remote = status?.remoteScheduleSupported ? status?.remoteSchedule : null;
  const localOn = Boolean(local?.enabled);
  const remoteOn = Boolean(remote?.enabled);

  if (localOn && remoteOn) {
    return {
      description: `${local.description} + ${remote.description}`,
      enabled: true,
      both: true,
      timezone: status?.timezone || "UTC",
    };
  }
  if (remoteOn) {
    return {
      description: remote.description,
      enabled: true,
      timezone: remote.timezone || status?.timezone || "UTC",
    };
  }
  if (localOn) {
    return {
      description: local.description,
      enabled: true,
      timezone: status?.timezone || "UTC",
    };
  }
  return {
    description: local?.description || remote?.description || "Not scheduled",
    enabled: false,
    timezone: status?.timezone || "UTC",
  };
}

function checkVariant(status) {
  return (
    { success: "ok", error: "error", running: "running", idle: "idle" }[status] ?? "idle"
  );
}

// pendingDelay is only ever forward-looking (cleared the moment the next
// account actually starts), so a stale/expired one just yields null here.
function pendingDelayLabel(pendingDelay) {
  if (!pendingDelay) return null;
  const elapsedSec = (Date.now() - Date.parse(pendingDelay.sinceTs)) / 1000;
  const remaining = Math.round(pendingDelay.seconds - elapsedSec);
  if (remaining <= 0) return null;
  const who = pendingDelay.nextEmail
    ? ` (${pendingDelay.nextEmail.split("@")[0]})`
    : "";
  return `next account in ~${remaining}s${who}`;
}

function controlState() {
  const status = context?.status;
  const usable = Boolean(status?.reachable && status?.authOk !== false);
  const running = Boolean(status?.botRunning);
  return { usable, running };
}

async function runAccount(account) {
  if (!context || !account.configured || !Number.isInteger(account.index)) return;

  launching.add(account.index);
  renderAccountRows(rootEl);
  try {
    await context.api.control("start", { accountIndex: account.index });
    context.toast(
      `Started ACCOUNT_${account.index} only (${account.email}).`,
      "success",
    );
    context.invalidate();
    await context.refresh();
  } catch (error) {
    context.toast(error.message, error.status === 409 ? "warn" : "error");
  } finally {
    launching.delete(account.index);
    renderAccountRows(rootEl);
  }
}

function renderStats(root, status) {
  const accounts = data?.accounts || [];
  const runs = data?.runs || [];
  const lastRun = runs.find((r) => r.status === "done") || runs[0] || null;

  const errorCount = accounts.filter((a) => a.status === "error").length;
  const anyRunning = accounts.some((a) => a.status === "running");
  const combined = accounts.reduce((sum, a) => sum + (a.lastPoints || 0), 0);
  const sched = activeSchedule(status);

  U.$("#statGrid", root).innerHTML = [
    statCard("statAccounts", U.fmtNumber(accounts.length), "profiles", "Accounts tracked"),
    statCard("statCombined", U.fmtNumber(combined), "points", "Combined balance"),
    statCard("statLastGained", lastRun ? U.fmtSigned(lastRun.totalGained) : "\u2013", "points", "Points earned last run"),
    statCard(
      "statLastRun",
      anyRunning ? "Running now" : lastRun ? U.fmtRelative(lastRun.endTs || lastRun.startTs) : "\u2013",
      anyRunning ? "" : "timestamp",
      "Last run",
      anyRunning ? "stat-icon-running" : "stat-icon-check",
      anyRunning ? "\u25CF" : "\u2713",
    ),
    statCard(
      "statErrors",
      U.fmtNumber(errorCount),
      "errors",
      "Accounts in error",
      errorCount > 0 ? "stat-icon-alert icon-alert-active" : "stat-icon-check",
      errorCount > 0 ? "!" : "\u2713",
    ),
    statCard(
      "statSchedule",
      U.escapeHtml(sched.description || "\u2013"),
      sched.timezone || "UTC",
      sched.both ? "Schedule (2 active)" : "Schedule",
      sched.both ? "stat-icon-alert icon-alert-active" : sched.enabled ? "stat-icon-check" : "stat-icon-idle",
      sched.both ? "!" : sched.enabled ? "\u2713" : "\u2013",
    ),
  ].join("");
}

// 最近一次失败的账号：按原因分类，中文说清"是什么 + 怎么办"，英文原文折叠起来当证据。
// 数据来自 /api/accounts 的 failures 字段（由 store 的 last_error 聚合，账号成功时会被清空）。
function renderFailureCard(root) {
  const section = U.$("#ovwFailureSection", root);
  if (!section) return;
  const f = accountsPayload?.failures;
  const body = U.$("#ovwFailureBody", root);
  const sub = U.$("#ovwFailureSub", root);
  if (!f || !f.failed) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  sub.textContent = `${f.failed} 个账号（按最近一次结果）`;
  body.innerHTML = f.buckets
    .map(
      (b) => `<div class="fail-bucket">
        <p class="fail-cause"><strong>${b.count} ×</strong> ${U.escapeHtml(b.cause)}</p>
        ${b.action ? `<p class="fail-action">怎么办：${U.escapeHtml(b.action)}</p>` : ""}
        <details class="fail-evidence">
          <summary>原始报错（示例 ${b.examples.length} 条）</summary>
          <ul class="fail-examples">${b.examples
            .map(
              (e) =>
                `<li><span class="fail-email">${U.escapeHtml(e.email)}</span><code>${U.escapeHtml(
                  String(e.error).slice(0, 400),
                )}</code></li>`,
            )
            .join("")}</ul>
        </details>
      </div>`,
    )
    .join("");
  // 没归上类的也要露出来：静默吞掉一个失败，比没有这张卡片更糟。
  if (f.unclassified && f.unclassified.length) {
    body.innerHTML += `<p class="notice notice--warn">未分类 ${f.unclassified.length} 个（判定表待补）：${f.unclassified
      .map((u) => U.escapeHtml(u.email))
      .join("、")}</p>`;
  }
}

function renderAccountRows(root) {
  const container = U.$("#overviewHeroRows", root);
  const accounts = accountsPayload?.accounts || [];
  const histories = accountsPayload?.histories || {};
  const { usable, running } = controlState();

  const errEl = U.$("#ovwAccountsError", root);
  if (errEl) {
    errEl.hidden = !accountsPayload?.apiError;
    if (accountsPayload?.apiError) errEl.textContent = accountsPayload.apiError;
  }

  if (!accounts.length) {
    container.innerHTML = '<p class="empty-note" style="padding:1.25rem">No accounts configured or observed yet.</p>';
    return;
  }

  const bucketed = accounts
    .map((a) => ({ key: a.key, days: U.bucketByDay(histories[a.key] || []) }))
    .filter((x) => x.days.length);

  // Require global max for the original accumulation bar view
  const globalMax = bucketed.length
    ? Math.max(1, ...bucketed.flatMap((b) => b.days.map((d) => d.gained)))
    : 1;

  const daysByKey = Object.fromEntries(bucketed.map((b) => [b.key, b.days]));
  const todayKey = U.tzDayKey(new Date());
  const isMobile = window.matchMedia("(max-width: 768px)").matches;

  // While waiting between accounts, mark the account that's up next as
  // 'pending' rather than plain 'idle'/'success'/'error'. index.ts's
  // ACCOUNT-DELAY log line names the upcoming account directly, so this
  // reads that identity straight off pendingDelay rather than inferring it
  // from run.accounts (which only ever contains accounts that have already
  // started).
  const pendingDelay = context?.status?.pendingDelay;
  const nextAccountEmail = pendingDelay?.nextEmail || null;

  // hide email for screenshots by toggling mask = true
  const MASK_EMAILS = false;

  container.innerHTML = accounts
    .map((a) => {
      const days = daysByKey[a.key] || null;
      let barCell = '<p class="empty-note" style="font-size:0.78rem;margin:0">No history yet</p>';
      
      if (days) {
        // Toggle view logic
        if (viewMode === "heatmap") {
            barCell = `<div class="heatmap-wrap">${buildHeatmapHtml(days)}</div>`;
        } else {
            barCell = `<div class="accum-track"><div class="accum-bar">${buildAccumBarHtml(days, globalMax, isMobile ? 7 : null)}</div></div>`;
        }
      }

      const todayGained = days?.find((d) => d.dayKey === todayKey)?.gained ?? null;
      const variant = checkVariant(a.status);
      let badgeStatus = { ok: "success", error: "error", running: "running", idle: "idle" }[variant];
      if (badgeStatus !== "running" && nextAccountEmail && a.email === nextAccountEmail) {
        badgeStatus = "pending";
      }

      const todayText =
        todayGained != null
          ? `+${todayGained.toLocaleString()}\u202fpts today`
          : a.status === "running"
            ? "Running\u2026"
            : "No run today";

      const accountHistory = histories[a.key] || [];
      let gainHtml = "";
      if (accountHistory.length >= 2) {
        const latest = accountHistory[accountHistory.length - 1];
        const previous = accountHistory[accountHistory.length - 2];
        const trueGain = latest.points - previous.points;
        const selfReported = latest.gained ?? 0;
        const other = trueGain - selfReported;
        const gainText =
          other !== 0
            ? `${U.fmtSigned(selfReported)}${other >= 0 ? "+" : "-"}${Math.abs(other).toLocaleString()} pts`
            : `${U.fmtSigned(trueGain)} pts`;
        gainHtml = ` \u00b7 <span class="gain-val" title="Change in points since last check-in from all sources">${gainText}</span>`;
      }

      const dur = a.lastDurationSec != null ? U.fmtDuration(a.lastDurationSec) : null;

      // An account whose run is in flight has no completed-run numbers yet: lastPoints and
      // lastEndAt stay null until it ends. The card therefore showed a dash where the
      // points go and rendered the START time as "Running… 2h ago", which reads as a stall
      // even while the account is earning. Use the live payload from the Control API.
      const isRunning = a.status === "running";
      const shownPoints = isRunning ? (a.liveBalance ?? a.lastPoints) : a.lastPoints;
      const elapsedSec =
        isRunning && a.lastStartAt ? (Date.now() - Date.parse(a.lastStartAt)) / 1000 : null;

      const sub =
        isRunning
          ? `<span class="hero-sub-running">Running ${U.escapeHtml(U.fmtDuration(elapsedSec))}${
              a.liveGained != null ? ` \u00b7 +${U.fmtNumber(a.liveGained)} pts` : ""
            }${a.lastActivityAt ? ` \u00b7 ${U.escapeHtml(U.fmtRelative(a.lastActivityAt))}` : ""}</span>`
          : `Last Run: ${U.escapeHtml(U.fmtRelative(a.lastEndAt || a.lastStartAt))}${
              dur ? ` \u00b7 <span title="Last run duration">⏱ ${U.escapeHtml(dur)}</span>` : ""
            }${gainHtml}`;

      // 这一行左侧原本只放一个小条形图，占着 1fr 的全宽却大片留白。
      // 把四个数字放进同一个格子：总积分 / 今日获得 / 总任务 / 已完成。
      // 前两个数据本来就在 payload 里（shownPoints 见 L293，todayGained 见 L258）；
      // 后两个还没有来源 —— 日志里是 [REACT-PARSE] 任务列表 | 父任务=N | 未完成=N，
      // 但面板的 lib/parser.js 目前只分类不抽数，所以先留占位，等解析层补上就自动显示。
      const tasksTitle = "Not collected yet";
      const statStrip = `<div class="hero-stat-strip">
            <div class="hero-stat">
                <span class="hero-stat-num">${shownPoints != null ? U.fmtNumber(shownPoints) : "\u2013"}</span>
                <span class="hero-stat-label">Points</span>
            </div>
            <div class="hero-stat">
                <span class="hero-stat-num">${todayGained != null ? `+${U.fmtNumber(todayGained)}` : "\u2013"}</span>
                <span class="hero-stat-label">Today</span>
            </div>
            <div class="hero-stat" title="${U.escapeAttr(tasksTitle)}">
                <span class="hero-stat-num">${a.totalTasks != null ? U.fmtNumber(a.totalTasks) : "\u2013"}</span>
                <span class="hero-stat-label">Tasks</span>
            </div>
            <div class="hero-stat" title="${U.escapeAttr(tasksTitle)}">
                <span class="hero-stat-num">${a.completedTasks != null ? U.fmtNumber(a.completedTasks) : "\u2013"}</span>
                <span class="hero-stat-label">Done</span>
            </div>
        </div>`;

      return `<div class="hero-row">
            <div class="hero-bar-cell">${statStrip}${barCell}</div>
            <div class="hero-acc-card">
                <div class="hero-acc-pts">
                    <span class="hero-pts-num">${days ? days.length : "\u2013"}</span>
                    <span class="hero-pts-unit">Days run</span>
                </div>
                <div class="hero-acc-info">
                    <div class="hero-acc-name">
                        ${MASK_EMAILS ? `ACCOUNT_${a.index}` : U.escapeHtml(a.email)}
                        ${a.configured ? "" : ' <span class="tag-mini">unconfigured</span>'}
                    </div>
                    <div class="hero-acc-meta">
                        <span class="hero-acc-today">
                            ${U.statusPill(badgeStatus)}
                            <span>${U.escapeHtml(todayText)}</span>
                            ${a.streakCounter != null ? `<span> \u00b7 🔥\u202f${U.fmtNumber(a.streakCounter)}</span>` : ""}
                        </span>
                    </div>
                    <div class="hero-acc-sub">${sub}</div>
                    ${a.lastError
                      ? `<div class="hero-acc-error">${U.escapeHtml(
                          a.lastError.length > 120
                            ? `${a.lastError.slice(0, 119)}…`
                            : a.lastError
                        )}</div>`
                      : ""}
                </div>
                <div class="hero-acc-actions">
                    ${a.configured && Number.isInteger(a.index)
                      ? `<button type="button" class="link-btn" data-run-account="${a.index}" ${!usable || running || launching.has(a.index) ? "disabled" : ""} title="Run only ACCOUNT_${a.index}">${launching.has(a.index) ? "Starting…" : "Run only"}</button>`
                      : ""
                    }
                    <button type="button" class="link-btn" data-trend="${U.escapeAttr(a.key)}" aria-pressed="${selected === a.key}">Trend</button>
                </div>
            </div>
        </div>`;
    })
    .join("");

  // The timeline view is a rolling recent-history strip, so scrolling it to
  // its end shows the most recent days by default - that's still correct.
  // The heatmap is intentionally left-anchored to where the account's data
  // starts, with empty "coming up" cells trailing off to the right, so it
  // must NOT be force-scrolled to its end - that would undo the fix and put
  // the user right back at a mostly-empty future edge instead of their data.
  container.querySelectorAll(".accum-track").forEach((track) => {
    track.scrollLeft = track.scrollWidth;
  });

  container.querySelectorAll("button[data-run-account]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const index = Number(btn.dataset.runAccount);
      const account = accounts.find((a) => a.index === index);
      if (account) runAccount(account);
    }),
  );

  container.querySelectorAll("button[data-trend]").forEach((btn) =>
    btn.addEventListener("click", () => {
      selected = selected === btn.dataset.trend ? null : btn.dataset.trend;
      renderAccountRows(root);
      if (selected) {
        U.$("#ovwTrendSection", root).scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
      }
    }),
  );

  renderTrend();
}

function renderTrend() {
  const section = U.$("#ovwTrendSection", rootEl);
  section.hidden = !selected;
  if (!selected) return;

  const history = (accountsPayload?.histories || {})[selected] || [];
  U.$("#ovwTrendName", rootEl).textContent = selected;

  lineChart(
    U.$("#ovwTrendChart", rootEl),
    history.map((h) => ({
      key: h.ts.slice(0, 10),
      value: h.points,
      label: U.fmtDateTime(h.ts),
    })),
    { emptyMessage: "No point history recorded for this account yet." },
  );
}

function renderRunHeader(root, status) {
  const bot = status?.bot;
  const run = bot?.run;

  const active =
    bot &&
    bot.state !== "idle" &&
    bot.state !== "unknown";

  const progressBox = U.$("#runProgressBox", root);
  const titleEl = U.$("#run-progress-heading", root);
  const metaEl = U.$("#currentRunMeta", root);
  const bar = U.$("#currentRunBar", root);

  if (!bar) return;

  progressBox.hidden = false;

  const progressWrap = bar.parentElement;
  const total = Number(run?.accountsTotal) || 0;
  const runAccounts = Array.isArray(run?.accounts) ? run.accounts : [];

  // run.accounts only ever contains accounts that have started (see
  // logParser.js's ensureAccount) - success stays null until it finishes,
  // so this is the one reliable way to tell "finished" from "still running"
  // rather than trusting accountsSeen, which counts starts, not completions.
  const doneCount = runAccounts.filter((a) => a.success != null).length;
  const seenCount = Number.isFinite(Number(run?.accountsSeen))
    ? Number(run.accountsSeen)
    : runAccounts.length;
  const runningCount = Math.max(0, seenCount - doneCount);
  const pendingCount = Math.max(0, total - seenCount);

  const done = Math.min(doneCount, total);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  titleEl.textContent = active ? "Run in progress" : "Last run";

  U.renderTicker(
    metaEl,
    [
      run?.version ? `v${run.version}` : null,
      total ? `${done}/${total} done` : `${seenCount} accounts seen`,
      total && runningCount ? `${runningCount} running` : null,
      total && pendingCount ? `${pendingCount} pending` : null,
      run?.clusters != null ? `${run.clusters} cluster${run.clusters === 1 ? "" : "s"}` : null,
      run?.collected != null ? `${U.fmtSigned(run.collected)} points` : null,
      pendingDelayLabel(status?.pendingDelay),
    ]
      .filter(Boolean)
      .join(" \u00b7 "),
  );

  bar.style.width = `${pct}%`;
  progressWrap.setAttribute("aria-valuenow", String(pct));
    
  if (!active) {
    progressBox.classList.add("idle");
  } else {
    progressBox.classList.remove("idle");
  }
}

export default {
  id: "overview",
  label: "Overview",
  interval: 10000,

  mount(root, ctx) {
    rootEl = root;
    context = ctx;
    root.innerHTML = `
            <p class="notice notice--warn" id="ovwAccountsError" hidden></p>

            <section aria-labelledby="stats-heading" class="stats">
                <h2 id="stats-heading" class="visually-hidden">Summary</h2>
                <div class="stat-grid" id="statGrid"></div>
            </section>

            <section class="panel run-progress-box" id="runProgressBox" aria-labelledby="run-progress-heading">
                <div class="run-progress-header">
                    <h2 class="run-progress-title" id="run-progress-heading">Run in progress</h2>
                    <span id="currentRunMeta" class="run-progress-meta"></span>
                </div>
                <div class="progress" id="currentRunProgressWrap" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
                    <div class="progress-bar" id="currentRunBar"></div>
                </div>
            </section>

            <section class="panel" id="ovwFailureSection" hidden aria-labelledby="ovw-failure-heading">
                <div class="panel-head">
                    <h2 id="ovw-failure-heading">Failure reasons</h2>
                    <span class="panel-sub" id="ovwFailureSub"></span>
                </div>
                <div id="ovwFailureBody"></div>
            </section>

            <section class="panel hero-panel" id="currentRun" aria-labelledby="current-run-heading">
                <div class="hero-panel-header" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.75rem;">
                    <div>
                        <h2 id="current-run-heading" style="margin:0;">Accounts Overview</h2>
                    </div>
                    <div class="seg" id="ovwViewToggle">
                        <button type="button" class="seg-btn ${viewMode === 'accum' ? 'seg-btn--active' : ''}" data-view="accum">Timeline</button>
                        <button type="button" class="seg-btn ${viewMode === 'heatmap' ? 'seg-btn--active' : ''}" data-view="heatmap">Heatmap</button>
                    </div>
                </div>
                <div class="hero-layout" id="overviewHeroRows">
                    <p class="empty-note" style="padding:1.25rem">Loading&hellip;</p>
                </div>
            </section>

            <section class="panel" id="ovwTrendSection" hidden aria-labelledby="ovw-trend-heading">
                <div class="panel-head">
                    <h2 id="ovw-trend-heading">Point total &mdash; <span id="ovwTrendName"></span></h2>
                    <span class="panel-sub">Every recorded balance, oldest to newest</span>
                </div>
                <div id="ovwTrendChart" class="chart-wrap"></div>
            </section>`;
    mounted = true;

    // Attach event listeners for the toggle and save selection to localStorage
    const toggleBtns = root.querySelectorAll("#ovwViewToggle .seg-btn");
    toggleBtns.forEach((btn) => {
        btn.addEventListener("click", (e) => {
            toggleBtns.forEach((b) => b.classList.remove("seg-btn--active"));
            e.target.classList.add("seg-btn--active");
            viewMode = e.target.dataset.view;
            localStorage.setItem(VIEW_STORAGE_KEY, viewMode);
            renderAccountRows(rootEl);
        });
    });
  },
  
  async refresh(ctx) {
    context = ctx;
    [data, accountsPayload] = await Promise.all([
      cached("summary", ctx.api.summary, 3000),
      cached("accounts", ctx.api.accounts, 5000),
    ]);
    this.redraw(ctx);
  },

  redraw(ctx) {
    context = ctx || context;
    if (!mounted || !data) return;
    renderStats(rootEl, context.status);
    renderRunHeader(rootEl, context.status);
    renderAccountRows(rootEl);
    renderFailureCard(rootEl);
  },

  onState(status, ctx) {
    context = ctx || context;
    if (!mounted || !data) return;
    renderRunHeader(rootEl, status);
    renderStats(rootEl, status);
    renderAccountRows(rootEl);
    renderFailureCard(rootEl);
  },
};