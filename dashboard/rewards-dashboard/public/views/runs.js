import * as U from "../util.js";
import { cached } from "../api.js";
import { lineChart } from "../charts.js";
import { icon } from "../icons.js";

let rootEl = null;
let context = null;
let runsPayload = null;
let accountsPayload = null;
let days = 30;
let openExit = null;

function dailyBars() {
  const histories = accountsPayload?.histories || {};
  const totals = new Map();

  for (const history of Object.values(histories)) {
    for (const day of U.bucketByDay(history)) {
      totals.set(day.dayKey, (totals.get(day.dayKey) || 0) + day.gained);
    }
  }

  // 日期游标交给 U.recentDayKeys —— 走纯 UTC 的键运算。原来这里是
  // setHours(12) + setDate(getDate() ± 1)：那个"本地正午错开 12 小时"的技巧对
  // 面板 TZ（UTC+8）不成立 —— 浏览器若在 UTC-4，本地正午 = 上海次日 00:00，
  // tzDayKey 会把整列日期键后移一天（实测确实偏一天）。
  const out = [];
  for (const key of U.recentDayKeys(days)) {
    out.push({ key, value: totals.get(key) || 0 });
  }
  return out;
}

function renderChart() {
  const bars = dailyBars();
  const total = bars.reduce((sum, b) => sum + b.value, 0);
  const active = bars.filter((b) => b.value > 0).length;

  U.$("#runsChartMeta", rootEl).textContent =
    `${U.fmtSigned(total)} points over ${days} days · ${active} day${active === 1 ? "" : "s"} with a run`;
  // 每日获得改为渐变面积趋势图（与总览趋势卡同风格）：0 值天连成贴地平线、
  // 有量的天自然隆起 —— 告别"一排空气柱 + 右侧几根孤柱"的观感（用户点名重设计）。
  lineChart(
    U.$("#runsChart", rootEl),
    bars.map((b) => ({
      ...b,
      label: U.localDateLabel(b.key, {
        weekday: "short",
        month: "short",
        day: "numeric",
      }),
    })),
    {
      emptyMessage: "No point history recorded yet.",
      signed: true,
      ariaLabel: "Points collected per day",
    },
  );
}

// 运行历史表已按用户要求迁到日志页（logs.js）—— 那里本来就是「这次运行到底发生了什么」的地方，
// 表和日志流互相印证。本页只留每日积分趋势与进程退出。

function exitPill(exit) {
  if (!exit) return U.statusPill("idle");
  if (exit.code === 0) return '<span class="pill pill-success">Exit 0</span>';
  if (exit.signal)
    return `<span class="pill pill-warn">${U.escapeHtml(exit.signal)}</span>`;
  return `<span class="pill pill-error">Exit ${U.escapeHtml(String(exit.code ?? "n/a"))}</span>`;
}

function renderExits() {
  const exits = runsPayload?.exits || [];
  const list = U.$("#exitList", rootEl);

  U.$("#exitsError", rootEl).hidden = !runsPayload?.apiError;
  if (runsPayload?.apiError)
    U.$("#exitsError", rootEl).textContent = runsPayload.apiError;

  if (!exits.length) {
    list.innerHTML =
      '<li class="empty-note">The control API hasn’t recorded any runs yet. Runs it launches itself (manually or on a schedule) show up here.</li>';
    return;
  }

  list.innerHTML = exits
    .map((run, i) => {
      const failed = (run.accounts || []).filter(
        (a) => a.success === false,
      ).length;
      const ok = (run.accounts || []).filter((a) => a.success === true).length;
      const isOpen = openExit === i;
      const detail = isOpen
        ? `<ul class="runacc-list">${(run.accounts || [])
          .map(
            (a) => `<li class="runacc">
                            ${U.statusPill(a.success === false ? "error" : a.success === true ? "success" : "pending")}
                            <span class="runacc-email">${U.escapeHtml(a.email)}</span>
                            <span class="runacc-detail">${U.escapeHtml(a.error ? a.error : `${U.fmtSigned(a.collected)} pts`)}</span>
                          </li>`,
          )
          .join("")}</ul>`
        : "";

      return `<li class="exit-item">
                <button type="button" class="exit-head" data-exit="${i}" aria-expanded="${isOpen}">
                    ${exitPill(run.exit)}
                    <span class="exit-when">${U.escapeHtml(U.fmtDateTime(run.endedAt || run.startedAt))}</span>
                    <span class="exit-meta">${run.collected != null ? U.fmtSigned(run.collected) : "–"} pts · ${ok} ok${failed ? ` · ${failed} failed` : ""}</span>
                    <span class="exit-chevron" aria-hidden="true">${isOpen ? "▾" : "▸"}</span>
                </button>
                ${detail}
            </li>`;
    })
    .join("");

  list.querySelectorAll("button[data-exit]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.exit);
      openExit = openExit === i ? null : i;
      renderExits();
    }),
  );
}

// --- account list & batch run (moved here from accounts.js) -----------------
// 用户要求：批量运行条 + 账户列表（手风琴详情/批量选择/仅运行/删除）放在运行页
// 「每日积分」卡下面 —— 跑一次、看结果、看趋势都在同一页。账户页只剩写 .env 的
// 账号管理卡。下面这块代码整体从 accounts.js 迁来，行为不变。

const launching = new Set();
// Stored negatively - the accounts the operator UNchecked - so "run everything"
// is the default and an account added to .env later is included without having
// to re-tick anything.
const deselectedForBatch = new Set();
const isBatchSelected = (index) => !deselectedForBatch.has(index);
const expandedAccounts = new Set();
let batchRunning = false;

// Two-step delete: a key must be "armed" by a first click before a second
// click on the confirm button actually deletes anything, so there's no way
// to remove an account's dashboard data with a single accidental click.
const deleteArmed = new Set();
const deleting = new Set();

const SOURCE_LABELS = {
  search: "Search",
  bonus: "Bonus search",
  read: "Read",
  checkIn: "Check-in",
  claimReward: "Claim reward",
  claimBonus: "Claim bonus",
  urlReward: "URL reward",
  visualSearch: "Visual search",
  appReward: "App reward",
  punchcard: "Punchcard",
  searchOnBing: "Search activity",
};

function controlState() {
  const status = context?.status;
  const usable = Boolean(status?.reachable && status?.authOk !== false);
  const running = Boolean(status?.botRunning);
  return { usable, running };
}

async function runAccount(account) {
  if (!context || !account.configured || !Number.isInteger(account.index)) return;

  launching.add(account.index);
  renderAccounts();
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
    renderAccounts();
  }
}

function selectableAccounts() {
  return (accountsPayload?.accounts || []).filter(
    (a) => a.configured && Number.isInteger(a.index),
  );
}

// Removes an account's stored data (status, history, activity log) from the
// dashboard's own database. This never touches the bot itself - it's meant
// for accounts the bot no longer runs (removed from .env) whose dashboard
// data would otherwise linger forever.
async function deleteAccount(account) {
  if (!context) return;

  deleteArmed.delete(account.key);
  deleting.add(account.key);
  renderAccounts();
  try {
    await context.api.deleteDashboardAccount(account.email);
    context.toast(`Removed ${account.email} from the dashboard.`, "success");
    context.invalidate();
    await context.refresh();
  } catch (error) {
    context.toast(error.message, error.status === 409 ? "warn" : "error");
  } finally {
    deleting.delete(account.key);
    renderAccounts();
  }
}

async function runSelectedAccounts() {
  if (!context) return;
  const configured = selectableAccounts();
  const selectedIndexes = configured
    .filter((a) => isBatchSelected(a.index))
    .map((a) => a.index);
  if (!selectedIndexes.length) return;

  // The control API only accepts an exclusion list, so a "run these x of y"
  // request is expressed as "exclude everyone else" - which is how the
  // selection is stored.
  const excludedAccountIndexes = configured
    .filter((a) => !isBatchSelected(a.index))
    .map((a) => a.index);

  batchRunning = true;
  renderAccounts();
  try {
    await context.api.control("start", { excludedAccountIndexes });
    context.toast(
      `Started ${selectedIndexes.length}/${configured.length} selected accounts.`,
      "success",
    );
    context.invalidate();
    await context.refresh();
  } catch (error) {
    context.toast(error.message, error.status === 409 ? "warn" : "error");
  } finally {
    batchRunning = false;
    renderAccounts();
  }
}

function renderBatchToolbar() {
  const configured = selectableAccounts();
  const configuredIndexes = new Set(configured.map((a) => a.index));
  // Drop un-ticked marks for accounts that disappeared (e.g. .env edited).
  for (const index of [...deselectedForBatch]) {
    if (!configuredIndexes.has(index)) deselectedForBatch.delete(index);
  }

  const { usable, running } = controlState();
  const count = configured.filter((a) => isBatchSelected(a.index)).length;
  const total = configured.length;

  U.$("#accountsSelectedCount", rootEl).textContent = `${count}/${total} selected`;

  const allBtn = U.$("#accountsSelectAll", rootEl);
  allBtn.checked = total > 0 && count === total;
  allBtn.indeterminate = count > 0 && count < total;
  allBtn.disabled = total === 0;

  const runBtn = U.$("#accountsRunSelected", rootEl);
  runBtn.disabled = !usable || running || batchRunning || count === 0;
  runBtn.textContent = batchRunning ? "Starting…" : "Run selected";
}

function earnableBadge(account) {
  const earnable = account.earnable || account.live?.earnable;
  const total = earnable
    ? Object.values(earnable).reduce((sum, points) => sum + (Number(points) || 0), 0)
    : 0;
  if (total <= 0) return "";
  return `<span class="point-source point-source--target"><strong>Earnable</strong> ${U.escapeHtml(U.fmtNumber(total))}</span>`;
}

// Only sources that actually earned something today — ten "+0" chips per
// account is noise, not detail.
function sourceBreakdown(account) {
  const bySource = account.live?.bySource || {};
  return Object.entries(SOURCE_LABELS)
    .filter(([source]) => Number(bySource[source]) > 0)
    .map(
      ([source, label]) =>
        `<span class="point-source"><strong>${U.escapeHtml(label)}</strong> ${U.escapeHtml(U.fmtSigned(Number(bySource[source])))}</span>`,
    )
    .join("");
}

function protectionPresentation(account) {
  if (account.streakProtectionEnabled == null) return null;

  const remaining = account.streakProtectionRemainingDays;
  const days =
    remaining == null
      ? "days unavailable"
      : `${remaining} protection day${remaining === 1 ? "" : "s"} left`;
  const state = account.streakProtectionEnabled ? "On" : "Off";
  const streak =
    account.streakCounter == null
      ? "streak unavailable"
      : `${U.fmtNumber(account.streakCounter)} day${account.streakCounter === 1 ? "" : "s"} current streak`;

  return {
    state,
    days,
    streak,
    pillClass:
      account.streakProtectionEnabled && remaining !== 0
        ? "pill-success"
        : remaining === 0
          ? "pill-warn"
          : "pill-idle",
  };
}

function kv(items) {
  return `<dl class="kv">${items
    .map(
      ([k, v]) =>
        `<div><dt>${U.escapeHtml(k)}</dt><dd>${U.escapeHtml(String(v))}</dd></div>`,
    )
    .join("")}</dl>`;
}

function detailGroups(a, protection) {
  const groups = [];

  groups.push([
    "Configuration",
    [
      ["Configured in .env", a.configured ? "Yes" : "No — seen in logs only"],
      ...(a.geoLocale ? [["Geo locale", a.geoLocale]] : []),
      ...(a.langCode ? [["Language", a.langCode]] : []),
      ...(a.hasTotp != null ? [["TOTP secret", a.hasTotp ? "Set" : "Not set"]] : []),
      ...(a.hasRecoveryEmail != null
        ? [["Recovery email", a.hasRecoveryEmail ? "Set" : "Not set"]]
        : []),
      [
        "Proxy",
        a.proxy
          ? `${a.proxy.url}${a.proxy.port ? `:${a.proxy.port}` : ""}${a.proxy.hasCredentials ? " (authenticated)" : ""}`
          : "None",
      ],
    ],
  ]);

  groups.push([
    "Streak &amp; protection",
    [
      ["Success streak", a.successStreak == null ? "–" : `${a.successStreak} run${a.successStreak === 1 ? "" : "s"}`],
      ...(protection
        ? [
          [
            "Current streak",
            a.streakCounter == null
              ? "Unavailable"
              : `${U.fmtNumber(a.streakCounter)} day${a.streakCounter === 1 ? "" : "s"}`,
          ],
          ["Streak protection", protection.state === "On" ? "Enabled" : "Disabled"],
          [
            "Protection days remaining",
            a.streakProtectionRemainingDays == null
              ? "Unavailable"
              : `${a.streakProtectionRemainingDays} day${a.streakProtectionRemainingDays === 1 ? "" : "s"}`,
          ],
          ...(a.streakProtectionUpdatedAt
            ? [["Protection status checked", U.fmtRelative(a.streakProtectionUpdatedAt)]]
            : []),
        ]
        : []),
    ],
  ]);

  groups.push([
    "Run history",
    [
      ["Runs recorded by the API", a.apiRuns == null ? "–" : U.fmtNumber(a.apiRuns)],
      ["Points collected (API history)", U.fmtSigned(a.apiTotalCollected)],
      ["Last duration", U.fmtDuration(a.lastDurationSec)],
      ["History points loaded", U.fmtNumber(a.historyCount)],
    ],
  ]);

  return `<div class="acc-detail-groups">${groups
    .map(
      ([title, items]) => `
        <div class="acc-detail-group">
            <h3 class="acc-detail-group-title">${title}</h3>
            ${kv(items)}
        </div>`,
    )
    .join("")}</div>`;
}

// Mirrors overview.js's statCard icon convention (stat-icon-check /
// -running / -alert icon-alert-active / -idle with ✓ / ● / ! / –)
// so an account's live status reads the same way here as it does there.
function statusIconParts(statusKey) {
  switch (statusKey) {
    case "success":
    case "done":
      return { cls: "stat-icon-check", icon: "✓", label: "Success" };
    case "running":
    case "starting":
    case "stopping":
      return { cls: "stat-icon-running", icon: "●", label: U.pillParts(statusKey).label };
    case "pending":
      return { cls: "stat-icon-pending", icon: "●", label: U.pillParts(statusKey).label };
    case "error":
    case "crashed":
    case "interrupted":
    case "stopped":
      return { cls: "stat-icon-alert icon-alert-active", icon: "!", label: U.pillParts(statusKey).label };
    default:
      return { cls: "stat-icon-idle", icon: "–", label: "Idle" };
  }
}

function renderAccountPanel(a, live) {
  const protection = protectionPresentation(a);
  const { usable, running } = controlState();

  // Accounts now start one at a time (accountDelay), so mid-run there can be
  // several accounts that already finished this run while another is still
  // going - `live` just means "has a record in this run", true for both.
  // a.status is this account's own last-observed outcome (idle/running/
  // success/error), so it correctly tells finished accounts apart from the
  // one actually in progress right now.
  // Mirrors overview.js: while waiting between accounts, the one named by
  // pendingDelay.nextEmail is up next, so it reads as "pending" rather than
  // whatever its last-observed status happened to be.
  const nextAccountEmail = context?.status?.pendingDelay?.nextEmail || null;
  const statusKey = launching.has(a.index)
    ? "starting"
    : a.status !== "running" && nextAccountEmail && a.email === nextAccountEmail
      ? "pending"
      : a.status;

  const runButton =
    a.configured && Number.isInteger(a.index)
      ? `<button type="button" class="btn btn-primary btn-small" data-run-account="${a.index}" ${!usable || running || launching.has(a.index) ? "disabled" : ""
      } title="Run only ACCOUNT_${a.index}">${launching.has(a.index) ? "Starting…" : "Run only"}</button>`
      : "";

  const selectCheckbox =
    a.configured && Number.isInteger(a.index)
      ? `<label class="check acc-batch-select" title="Include ACCOUNT_${a.index} in a batch run">
          <input type="checkbox" data-select-account="${a.index}" ${isBatchSelected(a.index) ? "checked" : ""}>
          <span>Select</span>
        </label>`
      : "";

  const { cls: statusIconCls, icon: statusIcon, label: statusLabel } = statusIconParts(statusKey);
  const isExpanded = expandedAccounts.has(a.key);
  const detailsId = `acc-details-${U.escapeAttr(a.key)}`;
  const initial = (a.email || "?").charAt(0).toUpperCase();

  const isDeleting = deleting.has(a.key);
  const deleteBlocked = a.status === "running" || launching.has(a.index);
  const deleteButton = deleteArmed.has(a.key)
    ? `<span class="acc-delete-confirm">
        <button type="button" class="btn btn-small" data-cancel-delete="${U.escapeAttr(a.key)}" ${isDeleting ? "disabled" : ""}>Cancel</button>
        <button type="button" class="btn btn-danger btn-small" data-confirm-delete="${U.escapeAttr(a.key)}" ${isDeleting ? "disabled" : ""} title="Permanently remove this account and its history from the dashboard">
            ${isDeleting ? "Removing…" : "Are you sure?"}
        </button>
      </span>`
    : `<button type="button" class="btn btn-danger btn-small" data-arm-delete="${U.escapeAttr(a.key)}" ${deleteBlocked ? "disabled" : ""} title="${deleteBlocked ? "The account must be idle to delete it" : "Remove this account and its history from the dashboard"}">Delete</button>`;

  const chips = [
    protection
      ? `<span class="pill ${protection.pillClass}" title="${U.escapeAttr(protection.streak)}; streak protection is ${protection.state.toLowerCase()}; ${U.escapeAttr(protection.days)}">Protection ${protection.state} · ${a.streakProtectionRemainingDays == null ? "days unavailable" : `${a.streakProtectionRemainingDays} day${a.streakProtectionRemainingDays === 1 ? "" : "s"} left`}</span>`
      : "",
    earnableBadge(live || {}),
    sourceBreakdown(live || {}),
  ]
    .filter(Boolean)
    .join("");

  return `
    <div class="card acc-card account-detail-panel">
        <div class="acc-head card-h">
            <button type="button" class="acc-detail-toggle" data-toggle-details="${U.escapeAttr(a.key)}" aria-expanded="${isExpanded}" aria-controls="${detailsId}" title="${isExpanded ? "Collapse details" : "Expand details"}">${icon("chev", "i sm")}</button>
            <div class="av av-sm">${U.escapeHtml(initial)}</div>
            <div class="acc-info">
                <div class="acc-mail">
                    ${U.escapeHtml(a.email)}
                    ${a.configured ? "" : '<span class="tag-mini">unconfigured</span>'}
                </div>
                <div class="acc-sub">
                    <span class="acc-status-icon ${statusIconCls}" role="img" aria-label="${U.escapeAttr(statusLabel)}" title="${U.escapeAttr(statusLabel)}">${statusIcon}</span>
                    ${U.statusPill(statusKey)}
                </div>
            </div>
            <span class="acc-detail-actions">
                ${selectCheckbox}
                ${runButton}
                ${deleteButton}
            </span>
        </div>
        <div class="acc-body panel-body" id="${detailsId}" ${isExpanded ? "" : "hidden"}>
            ${detailGroups(a, protection)}
            ${chips ? `<div class="account-today-row">
                <span class="account-today-label">Today</span>
                <div class="account-today-chips">${chips}</div>
            </div>` : ""}
        </div>
    </div>`;
}

function renderAccounts() {
  const container = U.$("#accountsContainer", rootEl);
  if (!container) return;
  const accounts = accountsPayload?.accounts || [];

  const liveByEmail = new Map(
    (context?.status?.bot?.run?.accounts || []).map((la) => [la.email, la]),
  );

  const errEl = U.$("#accountsError", rootEl);
  if (errEl) {
    errEl.hidden = !accountsPayload?.apiError;
    if (accountsPayload?.apiError) errEl.textContent = accountsPayload.apiError;
  }

  if (!accounts.length) {
    container.innerHTML = '<p class="empty-note" style="padding:1.25rem">No accounts configured or observed yet.</p>';
    renderBatchToolbar();
    return;
  }

  container.innerHTML = accounts.map(a => {
    const live = liveByEmail.get(a.email) || null;
    return renderAccountPanel(a, live);
  }).join("");

  container.querySelectorAll("button[data-run-account]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const index = Number(btn.dataset.runAccount);
      const account = accounts.find((a) => a.index === index);
      if (account) runAccount(account);
    }),
  );

  container.querySelectorAll("input[data-select-account]").forEach((input) =>
    input.addEventListener("change", () => {
      const index = Number(input.dataset.selectAccount);
      if (input.checked) deselectedForBatch.delete(index);
      else deselectedForBatch.add(index);
      renderBatchToolbar();
    }),
  );

  container.querySelectorAll("button[data-toggle-details]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const key = btn.dataset.toggleDetails;
      if (expandedAccounts.has(key)) expandedAccounts.delete(key);
      else expandedAccounts.add(key);
      renderAccounts();
    }),
  );

  container.querySelectorAll("button[data-arm-delete]").forEach((btn) =>
    btn.addEventListener("click", () => {
      deleteArmed.add(btn.dataset.armDelete);
      renderAccounts();
    }),
  );

  container.querySelectorAll("button[data-cancel-delete]").forEach((btn) =>
    btn.addEventListener("click", () => {
      deleteArmed.delete(btn.dataset.cancelDelete);
      renderAccounts();
    }),
  );

  container.querySelectorAll("button[data-confirm-delete]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const key = btn.dataset.confirmDelete;
      const account = accounts.find((a) => a.key === key);
      if (account) deleteAccount(account);
    }),
  );

  renderBatchToolbar();
}

export default {
  id: "runs",
  label: "Runs",
  interval: 20000,

  // Account status pills, the live "who is running right now" icons and the
  // batch button's enabled state all derive from ctx.status — the state stream
  // is what teaches us those (app.js applyState -> view.onState), so repaint
  // the list here. The chart doesn't care about the state stream.
  onState() {
    if (!rootEl || !accountsPayload) return;
    renderAccounts();
  },

  mount(root, ctx) {
    rootEl = root;
    context = ctx;
    root.innerHTML = `
            <section class="card" aria-labelledby="runs-chart-heading">
                <div class="card-h">
                    <div class="card-ic">${icon("bars", "i sm")}</div>
                    <div><div class="card-title" id="runs-chart-heading">Points per day</div><div class="card-sub" id="runsChartMeta"></div></div>
                    <div class="card-tools">
                        <div class="seg" role="group" aria-label="Date range">
                            <button type="button" class="seg-btn" data-days="14">14d</button>
                            <button type="button" class="seg-btn seg-btn--active" data-days="30">30d</button>
                            <button type="button" class="seg-btn" data-days="90">90d</button>
                        </div>
                    </div>
                </div>
                <div class="card-b"><div id="runsChart" class="chart-wrap"></div></div>
            </section>

            <p class="notice notice--warn" id="accountsError" hidden></p>
            <div class="card batch" id="accountsBatchToolbar">
                <div><span class="t">Batch run</span><span class="h" id="accountsSelectedCount">0/0 selected</span></div>
                <div class="card-tools">
                    <label class="check check--row">
                        <input type="checkbox" id="accountsSelectAll">
                        <span>Select all</span>
                    </label>
                    <button type="button" class="btn btn-primary btn-small" id="accountsRunSelected" disabled>Run selected</button>
                </div>
            </div>
            <div class="acc-lines" id="accountsContainer">
                <p class="empty-note" style="padding:1.25rem">Loading accounts configuration details&hellip;</p>
            </div>

            <section class="card" aria-labelledby="exits-heading">
                <div class="card-h">
                    <div class="card-ic bad">${icon("alert", "i sm")}</div>
                    <div><div class="card-title" id="exits-heading">Process exits</div><div class="card-sub">How each run the control API launched actually ended</div></div>
                </div>
                <p class="notice notice--warn" id="exitsError" hidden></p>
                <ul class="exit-list exit-scroll" id="exitList"></ul>
            </section>`;

    root.querySelectorAll("button[data-days]").forEach((btn) =>
      btn.addEventListener("click", () => {
        days = Number(btn.dataset.days);
        root
          .querySelectorAll("button[data-days]")
          .forEach((b) => b.classList.toggle("seg-btn--active", b === btn));
        renderChart();
      }),
    );

    U.$("#accountsSelectAll", root).addEventListener("change", (e) => {
      const configured = selectableAccounts();
      if (e.target.checked) deselectedForBatch.clear();
      else configured.forEach((a) => deselectedForBatch.add(a.index));
      renderAccounts();
    });

    U.$("#accountsRunSelected", root).addEventListener("click", () => {
      runSelectedAccounts();
    });
  },

  async refresh(ctx) {
    context = ctx;
    [runsPayload, accountsPayload] = await Promise.all([
      cached("runs", () => ctx.api.runs(100), 5000),
      cached("accounts", ctx.api.accounts, 5000),
    ]);
    this.redraw();
  },

  redraw() {
    if (!rootEl || !runsPayload) return;
    renderChart();
    renderExits();
    if (accountsPayload) renderAccounts();
  },
};
