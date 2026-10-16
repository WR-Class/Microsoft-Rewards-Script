"use strict";

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

/**
 * @param apiAccounts  rows from the Control API's GET /accounts
 * @param observed     rows from Store.snapshotAccounts()
 * @param histories    Store.allAccountHistories() — email -> point history
 */
function mergeAccounts(apiAccounts, observed, histories, liveAccounts) {
  const configured = Array.isArray(apiAccounts) ? apiAccounts : [];
  const seen = Array.isArray(observed) ? observed : [];
  const byEmail = new Map();
  for (const row of seen) {
    const key = normalizeEmail(row && row.email);
    if (key && !byEmail.has(key)) byEmail.set(key, row);
  }

  // Progress of a run in flight lives on the Control API's /status (run.accounts[]),
  // not in the dashboard's own last-completed-run fields - those stay null until the
  // account ends, which made a busy account look like "0 points, started 2h ago".
  const liveByEmail = new Map();
  for (const row of Array.isArray(liveAccounts) ? liveAccounts : []) {
    const key = normalizeEmail(row && row.email);
    if (key) liveByEmail.set(key, row);
  }

  const claimed = new Set();
  const merged = configured.map((acc) => {
    const identity = normalizeEmail(acc && acc.email);
    const local = (identity && byEmail.get(identity)) || null;
    if (local) claimed.add(identity);
    return buildRow({ config: acc, local, histories, live: liveByEmail.get(identity) || null });
  });

  for (const row of seen) {
    const identity = normalizeEmail(row && row.email);
    if (!identity || claimed.has(identity)) continue;
    merged.push(buildRow({ config: null, local: row, histories }));
    claimed.add(identity);
  }

  return merged;
}

// API 的账号历史整轮结束才写入，所以它会滞后于面板自己观测到的那一轮。谁的时间更新，
// 谁单独说了算 —— 包括"没有错误"：只按空值回退（`a || b`）会在新鲜的那边合法为空时漏出陈旧那条。
function observedAtMs(row) {
  if (!row) return null;
  const raw = row.lastEndAt || row.lastStartAt || null;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function pickLastError(local, config) {
  const localMs = observedAtMs(local);
  const apiMs = config && config.lastRunAt ? Date.parse(config.lastRunAt) : NaN;
  if (localMs != null && (!Number.isFinite(apiMs) || localMs >= apiMs)) {
    return local.lastError || null;
  }
  return (local && local.lastError) || (config && config.lastError) || null;
}

function buildRow({ config, local, histories, live = null }) {
  const email = (local && local.email) || (config && config.email) || "unknown";
  const history = (local && histories && histories[local.email]) || [];
  const apiProtection = config ? (config.streakProtection ?? null) : null;

  return {
    // identity
    key: email,
    email,
    index: config ? config.index : null,
    configured: Boolean(config),
    observed: Boolean(local),

    // configuration (Control API, straight from the bot's .env)
    geoLocale:
      (local && local.geoLocale) || (config && config.geoLocale) || null,
    langCode: config ? config.langCode : null,
    hasTotp: config ? Boolean(config.hasTotp) : null,
    hasRecoveryEmail: config ? Boolean(config.hasRecoveryEmail) : null,
    proxy: config ? config.proxy : null,

    // stats the API derives from its own in-memory run history
    // 这三个数来自控制 API 的内存运行历史。config 缺失（账号不在 API 视野里）或字段缺失时，
    // 它们是"不知道"，不是 0 —— 以前 `: 0` / `?? 0` 让界面把一个从未观察过的账号显示成
    // "跑了 0 次、赚了 0 分、连续成功 0 次"，三个自信的 0。前端三处消费方已同时加 null 守卫。
    apiRuns: config ? (config.runs ?? null) : null,
    apiTotalCollected: config ? (config.totalCollected ?? null) : null,
    successStreak: config ? (config.successStreak ?? null) : null,
    apiLastRunAt: config ? (config.lastRunAt ?? null) : null,
    apiLastCollected: config ? (config.lastCollected ?? null) : null,
    apiLastSuccess: config ? (config.lastSuccess ?? null) : null,

    // what the dashboard itself observed in the log stream
    status: local ? local.status : "idle",
    userName: local ? local.userName : null,
    lastStartAt: local ? local.lastStartAt : null,
    lastEndAt: local ? local.lastEndAt : null,
    lastGained: local ? local.lastGained : null,
    lastPoints: local ? local.lastPoints : null,
    lastDurationSec: local ? local.lastDurationSec : null,
    lastError: pickLastError(local, config),
    streakProtectionEnabled:
      local && local.streakProtectionEnabled != null
        ? Boolean(local.streakProtectionEnabled)
        : (apiProtection?.enabled ?? null),
    streakProtectionRemainingDays:
      local && local.streakProtectionRemainingDays != null
        ? local.streakProtectionRemainingDays
        : (apiProtection?.remainingDays ?? null),
    streakCounter:
      local && local.streakCounter != null
        ? local.streakCounter
        : (apiProtection?.streakCounter ?? null),
    streakProtectionUpdatedAt:
      (local && local.streakProtectionUpdatedAt) ||
      apiProtection?.updatedAt ||
      null,

    // live numbers while this account is in flight (empty once the run's own rows take over)
    liveGained: live && live.live ? (live.live.gained ?? null) : null,
    liveBalance: live && live.live ? (live.live.balance ?? null) : null,
    liveBySource: live && live.live ? (live.live.bySource ?? null) : null,
    earnable: live ? (live.earnable ?? null) : null,
    lastActivityAt: live && live.live ? (live.live.lastUpdateTs ?? null) : null,

    // 任务块（"总任务 / 已完成"两格的数据源）。store 里按 user_name 关联写入
    // （见 store.js 的 setAccountTasks 注释：任务行的账号段是用户名，不是邮箱）。
    // 必须在这里显式带出来 —— 这个函数是白名单，store 里的列不会自动出现在
    // /api/accounts 的响应里；漏了这两行，前端 a.totalTasks 永远是 undefined，
    // 界面上那两格就永远显示 "–"，而日志和数据库里其实都有值。
    totalTasks: local ? local.totalTasks : null,
    completedTasks: local ? local.completedTasks : null,

    historyCount: history.length,
  };
}

module.exports = { normalizeEmail, mergeAccounts };
