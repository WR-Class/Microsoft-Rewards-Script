"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "dashboard.sqlite");

const MAX_ACTIVITY_ROWS = 5000;
// 未识别原始行（kind = 'generic'）单独限量。它们占这张表的大头（实测 1751/2023 = 87%），
// 而运行结算要读的是 account-start/end/error、login-number* 这些。两者共用一个上限的结果是：
// 噪音把预算吃光后，本轮运行自己的结算行会被它后面的插入挤掉，表现为"已完成 N/10"偏低、
// pendingApproval 悄悄翻 false —— 不报错，只是数字变小。分开限量后结算行独占
// MAX_ACTIVITY_ROWS（实际不到 200 行），不可能触顶；活动流仍能看到 generic 行。
const MAX_GENERIC_ROWS = 500;

// Last-resort cutoff for a 'running' row whose account roster never filled
// (see the run-start case in apply() below) - e.g. the process died after
// only 1 of N accounts ever started, so nothing will ever complete that
// roster to trigger the normal check. Deliberately very long: a user can
// configure any number of accounts, the first run of the day can take hours
// to work through all of them, and any single account can sit blocked far
// longer still waiting on a manual login-approval prompt - so this only
// exists to bound a truly abandoned run, not to police normal durations.
const RUN_STALE_BACKSTOP_MS = 20 * 60 * 60 * 1000;

// How long to wait after the last ACCOUNT-END/ACCOUNT-ERROR before assuming
// the bot's own RUN-END is never coming and closing the run ourselves. The
// bot normally logs RUN-END within ~1s of the last account finishing; this
// only kicks in for a known bot-side clustering bug where worker-exit
// tracking undercounts and the run's own master process waits forever for
// exits that already happened, so RUN-END never fires despite every account
// having actually completed.
const AUTO_CLOSE_GRACE_MS = 15 * 1000;

// No legitimate run takes more than a couple minutes to log its very first
// ACCOUNT-START - the app logs it within ~1s of RUN-START in every observed
// case. accountDelay/manual-login waits only explain a SUBSEQUENT account
// being slow to start, never the first one. So "zero accounts started" this
// long after RUN-START is a much stronger and much faster signal of a dead
// process than RUN_STALE_BACKSTOP_MS's 20-hour window (which exists for a
// different problem: a run that died partway through a roster that DID
// start filling). Kept deliberately short.
const ZERO_START_STALE_MS = 5 * 60 * 1000;

// General safety net for a run that hangs PARTWAY through - e.g. the
// process deadlocks on a local resource (observed in production: a
// "database is locked" error from the bot's own local cache DB) without
// crashing, exiting any worker, or logging anything else ever again. Unlike
// ZERO_START_STALE_MS this can't be just a few minutes, since a run
// legitimately produces bursty gaps (accountDelay waits, slow searches) -
// but a run that's produced ABSOLUTELY NOTHING for this long, across every
// account, is well beyond any gap seen in normal operation.
const RUN_NO_ACTIVITY_STALE_MS = 90 * 60 * 1000;

// How often the zero-start watchdog checks, independent of incoming events -
// needed because a run stuck in the zero-start state produces no further
// log lines at all to trigger a check from apply().
const ZERO_START_WATCHDOG_INTERVAL_MS = 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS accounts (
    email TEXT PRIMARY KEY,
    user_name TEXT,
    geo_locale TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    last_start_at TEXT,
    last_end_at TEXT,
    last_gained INTEGER,
    last_points INTEGER,
    last_duration_sec REAL,
    last_error TEXT,
    streak_protection_enabled INTEGER,
    streak_protection_remaining_days INTEGER,
    streak_counter INTEGER,
    streak_protection_updated_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS account_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    ts TEXT NOT NULL,
    points INTEGER,
    gained INTEGER,
    duration_sec REAL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_history_email_ts ON account_history(email, ts);

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    start_ts TEXT,
    end_ts TEXT,
    version TEXT,
    total_accounts INTEGER,
    clusters INTEGER,
    accounts_processed INTEGER,
    total_gained INTEGER,
    old_total INTEGER,
    new_total INTEGER,
    runtime_min REAL,
    exit_code INTEGER,
    exit_signal TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_runs_start ON runs(start_ts);

CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    level TEXT,
    title TEXT,
    kind TEXT,
    user_name TEXT,
    platform TEXT,
    email TEXT,
    message TEXT,
    raw TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity(ts);
`;

class Store {
  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.db = new DatabaseSync(DB_FILE);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
    // account_history 的 gained/points 原本是 NOT NULL，而"基线未知"的结束事件差额
    // 就是 null —— 插入直接抛 NOT NULL constraint failed，整条事件被丢掉。实测
    // 2026-10-12：上游改发 [FLOW] 积分已收集（基线未知，不报差额）之后，account_history
    // 自 10-11 起再没写进新行，而 accounts 表靠清理路径照常更新 —— 面板的症状就只是
    // "成功 + 今天没有运行"，一点数据库错误都看不到。null 在这里是**有意义的**
    // （不知道 ≠ 0），所以约束本身是错的。STRICT 表不能原地去掉 NOT NULL，只能重建；
    // 行是复制过去的，不丢数据。只在确实还是 NOT NULL 时做，之后是空操作。
    {
      const cols = this.db.prepare("PRAGMA table_info(account_history)").all();
      const isNotNull = (name) => {
        const c = cols.find((x) => x.name === name);
        return Boolean(c && c.notnull);
      };
      if (isNotNull("gained") || isNotNull("points")) {
        this.db.exec(`
          BEGIN;
          CREATE TABLE account_history_migrated (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL,
            ts TEXT NOT NULL,
            points INTEGER,
            gained INTEGER,
            duration_sec REAL
          ) STRICT;
          INSERT INTO account_history_migrated (id, email, ts, points, gained, duration_sec)
            SELECT id, email, ts, points, gained, duration_sec FROM account_history;
          DROP TABLE account_history;
          ALTER TABLE account_history_migrated RENAME TO account_history;
          CREATE INDEX IF NOT EXISTS idx_history_email_ts ON account_history(email, ts);
          COMMIT;
        `);
      }
    }
    // 同一个事件被写两遍：实时路径和启动补录都会写它（补录走 backfill:true，
    // 而那个标志的作用正是跳过时间戳守卫），两个写入方互不排斥。
    // 实测 2026-10-12：2 个账号完成，行数 +4。
    //
    // 键必须取到**秒**，不能取完整 ts：两条路算出的纳秒来自不同来源（实时用控制
    // API 的 entry.id，补录用自己的 seq 计数器），同一个事件得到的是"同一秒、
    // 不同纳秒"的两个 ts，在完整 ts 上永远不冲突。
    // 秒级键会撞的只有"同一个账号一秒内完成两次"；一轮要几分钟、一次运行只产生
    // 一条 account-end，所以它不丢任何真实数据。
    // 也不能反过来把 ts 本身降到秒级：ts 同时是事件排序键（store.apply 的单调守卫
    // event.ts <= _lastTs 就丢弃），降精度会把同一秒里的其它事件一起丢掉。
    //
    // 去重必须排在建唯一索引**之前** —— 已有重复行时建唯一索引会直接失败。
    // 保留 MIN(id)（先写进去的那条），并且只在索引还不存在时做一次。
    {
      const hasUnique = this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_history_email_sec_unique'",
        )
        .get();
      if (!hasUnique) {
        this.db.exec(`
          DELETE FROM account_history
            WHERE id NOT IN (
              SELECT MIN(id) FROM account_history GROUP BY email, substr(ts, 1, 19)
            );
          DROP INDEX IF EXISTS idx_history_email_ts;
          DROP INDEX IF EXISTS idx_history_email_ts_unique;
          CREATE UNIQUE INDEX IF NOT EXISTS idx_history_email_sec_unique
            ON account_history(email, substr(ts, 1, 19));
        `);
      }
    }
    this._migrate();
    this._prepare();
    this._lastTs = this._readMeta("lastTs");
    this._autoCloseTimer = null;
    // Ephemeral (not persisted) - transient "waiting between accounts" state
    // is only meaningful while live, unlike everything else in this class.
    this._pendingDelay = null;

    // Completion evidence for the currently running process. Deliberately
    // NOT persisted - describes evidence from the live log stream only. If
    // the dashboard restarts, it should not assume an old process completed
    // successfully merely because it had partial evidence before restart.
    this._resetCompletionEvidence();

    // Watchdog for runs whose very first account never even logged
    // ACCOUNT-START (see _tryCloseZeroStartRun below for why this needs its
    // own, much shorter timeout than RUN_STALE_BACKSTOP_MS). Runs
    // independently of incoming events, since a truly dead run produces no
    // further events to trigger a check.
    this._zeroStartWatchdog = setInterval(() => {
      try {
        this._tryCloseZeroStartRun();
      } catch {
        /* best-effort safety net */
      }
      try {
        this._tryCloseStaleNoActivityRun();
      } catch {
        /* best-effort safety net */
      }
    }, ZERO_START_WATCHDOG_INTERVAL_MS);
    if (this._zeroStartWatchdog.unref) this._zeroStartWatchdog.unref();
  }

  _migrate() {
    const runCols = new Set(
      this.db
        .prepare("PRAGMA table_info(runs)")
        .all()
        .map((c) => c.name),
    );
    if (!runCols.has("exit_code"))
      this.db.exec("ALTER TABLE runs ADD COLUMN exit_code INTEGER");
    if (!runCols.has("exit_signal"))
      this.db.exec("ALTER TABLE runs ADD COLUMN exit_signal TEXT");

    const accountCols = new Set(
      this.db
        .prepare("PRAGMA table_info(accounts)")
        .all()
        .map((c) => c.name),
    );
    const accountMigrations = [
      ["streak_protection_enabled", "INTEGER"],
      ["streak_protection_remaining_days", "INTEGER"],
      ["streak_counter", "INTEGER"],
      ["streak_protection_updated_at", "TEXT"],
      // 任务列表：父任务总数与已完成数（见 apply 的 case "task-list"）
      ["total_tasks", "INTEGER"],
      ["completed_tasks", "INTEGER"],
    ];
    for (const [name, type] of accountMigrations) {
      if (!accountCols.has(name))
        this.db.exec(`ALTER TABLE accounts ADD COLUMN ${name} ${type}`);
    }
  }

  _prepare() {
    this.stmts = {
      getMeta: this.db.prepare("SELECT value FROM meta WHERE key = ?"),
      setMeta: this.db.prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ),

      upsertAccountStart: this.db.prepare(`
                INSERT INTO accounts (email, user_name, geo_locale, status, last_start_at)
                VALUES (?, ?, ?, 'running', ?)
                ON CONFLICT(email) DO UPDATE SET
                    user_name = excluded.user_name,
                    geo_locale = excluded.geo_locale,
                    status = 'running',
                    last_start_at = excluded.last_start_at
            `),
      upsertAccountEnd: this.db.prepare(`
                INSERT INTO accounts (email, user_name, status, last_end_at, last_gained, last_points, last_duration_sec, last_error)
                VALUES (?, ?, 'success', ?, ?, ?, ?, NULL)
                ON CONFLICT(email) DO UPDATE SET
                    status = 'success',
                    last_end_at = excluded.last_end_at,
                    last_gained = excluded.last_gained,
                    last_points = excluded.last_points,
                    last_duration_sec = excluded.last_duration_sec,
                    last_error = NULL
            `),
      upsertAccountError: this.db.prepare(`
                INSERT INTO accounts (email, status, last_end_at, last_error)
                VALUES (?, 'error', ?, ?)
                ON CONFLICT(email) DO UPDATE SET
                    status = 'error',
                    last_end_at = excluded.last_end_at,
                    last_error = excluded.last_error
            `),
      upsertStreakProtection: this.db.prepare(`
                INSERT INTO accounts (
                    email, user_name, status, streak_protection_enabled,
                    streak_protection_remaining_days, streak_counter,
                    streak_protection_updated_at
                )
                VALUES (?, ?, 'idle', ?, ?, ?, ?)
                ON CONFLICT(email) DO UPDATE SET
                    user_name = excluded.user_name,
                    streak_protection_enabled = excluded.streak_protection_enabled,
                    streak_protection_remaining_days = excluded.streak_protection_remaining_days,
                    streak_counter = excluded.streak_counter,
                    streak_protection_updated_at = excluded.streak_protection_updated_at
            `),
      insertHistory: this.db.prepare(
        "INSERT OR IGNORE INTO account_history (email, ts, points, gained, duration_sec) VALUES (?, ?, ?, ?, ?)",
      ),
      historyForEmail: this.db.prepare(
        "SELECT ts, points, gained, duration_sec as durationSec FROM account_history WHERE email = ? ORDER BY ts ASC",
      ),
      deleteAccountRow: this.db.prepare("DELETE FROM accounts WHERE email = ?"),
      deleteAccountHistory: this.db.prepare(
        "DELETE FROM account_history WHERE email = ?",
      ),
      deleteAccountActivity: this.db.prepare(
        "DELETE FROM activity WHERE email = ?",
      ),
      // 按 user_name 关联，不是 email：任务列表那条行的账号段是**用户名**
      // （qiaobaochong823680），消息体里没有邮箱。实测 10 个账号按 email 命中 0、
      // 按 user_name 命中 1 —— 写成 WHERE email = ? 会一行都更新不到，而且不报错。
      setAccountTasks: this.db.prepare(`
                UPDATE accounts SET total_tasks = ?, completed_tasks = ? WHERE user_name = ?
            `),
      allAccounts: this.db.prepare(`
                SELECT email, user_name as userName, geo_locale as geoLocale, status,
                       last_start_at as lastStartAt, last_end_at as lastEndAt,
                       last_gained as lastGained, last_points as lastPoints,
                       last_duration_sec as lastDurationSec, last_error as lastError,
                       streak_protection_enabled as streakProtectionEnabled,
                       streak_protection_remaining_days as streakProtectionRemainingDays,
                       streak_counter as streakCounter,
                       streak_protection_updated_at as streakProtectionUpdatedAt,
                       total_tasks as totalTasks, completed_tasks as completedTasks
                FROM accounts
                ORDER BY COALESCE(last_end_at, last_start_at) DESC
            `),

      insertRunStart: this.db.prepare(`
                INSERT INTO runs (id, status, start_ts, version, total_accounts, clusters)
                VALUES (?, 'running', ?, ?, ?, ?)
                ON CONFLICT(id) DO NOTHING
            `),
      findRunningRun: this.db.prepare(
        `SELECT id, start_ts as startTs, total_accounts as totalAccounts FROM runs WHERE status = 'running' ORDER BY start_ts DESC LIMIT 1`,
      ),
      accountsStartedSince: this.db.prepare(`
                SELECT COUNT(DISTINCT email) as n
                FROM activity
                WHERE title = 'ACCOUNT-START' AND email IS NOT NULL AND ts >= ?
            `),
      accountsResolvedSince: this.db.prepare(`
                SELECT COUNT(DISTINCT email) as n, MAX(ts) as lastTs
                FROM activity
                WHERE title IN ('ACCOUNT-END', 'ACCOUNT-ERROR') AND email IS NOT NULL AND ts >= ?
            `),
      lastActivitySince: this.db.prepare(`
                SELECT MAX(ts) as ts FROM activity WHERE ts >= ?
            `),
      lastLoginPromptKindSince: this.db.prepare(`
                SELECT kind FROM activity
                WHERE ts >= ? AND kind IN ('login-number', 'login-number-resolved')
                ORDER BY ts DESC LIMIT 1
            `),
      sumHistorySince: this.db.prepare(`
                SELECT SUM(gained) as gained, SUM(points) as points
                FROM account_history WHERE ts >= ?
            `),

      closeRun: this.db.prepare(`
                UPDATE runs SET status = 'done', end_ts = ?, accounts_processed = ?,
                    total_gained = ?, old_total = ?, new_total = ?, runtime_min = ?
                WHERE id = ?
            `),
      insertOrphanRunEnd: this.db.prepare(`
                INSERT INTO runs (id, status, end_ts, accounts_processed, total_gained, old_total, new_total, runtime_min)
                VALUES (?, 'done', ?, ?, ?, ?, ?, ?)
            `),
      recentRuns: this.db.prepare(`
                SELECT id, status, start_ts as startTs, end_ts as endTs, version,
                       total_accounts as totalAccounts, clusters,
                       accounts_processed as accountsProcessed, total_gained as totalGained,
                       old_total as oldTotal, new_total as newTotal, runtime_min as runtimeMin,
                       exit_code as exitCode, exit_signal as exitSignal
                FROM runs ORDER BY COALESCE(start_ts, end_ts) DESC LIMIT ?
            `),
      // Unified terminal-state closer used whenever we're ending a run
      // without the bot's own authoritative RUN-END data (crash/stop/
      // interrupt/auto-close) - stats are derived from account_history
      // instead, see _closeRunningRun().
      closeRunFull: this.db.prepare(`
                UPDATE runs SET status = ?, end_ts = ?, accounts_processed = ?,
                    total_gained = ?, old_total = ?, new_total = ?, runtime_min = ?,
                    exit_code = ?, exit_signal = ?
                WHERE id = ?
            `),
      orphanedRunningAccounts: this.db.prepare(
        "SELECT email FROM accounts WHERE status = 'running' AND last_start_at >= ?",
      ),
      markAccountInterrupted: this.db.prepare(`
                UPDATE accounts SET status = 'error', last_end_at = ?, last_error = ?
                WHERE email = ? AND status = 'running'
            `),
      // RUN-END is authoritative proof that the overall run completed.
      // An account still marked 'running' at this point did not emit its own
      // ACCOUNT-END/ACCOUNT-ERROR, but it must not remain 'running' forever.
      // Keep the diagnostic in last_error so the missing worker result is
      // visible without incorrectly classifying the completed run as an error.
      markAccountCompletedWithoutResult: this.db.prepare(`
                UPDATE accounts SET status = 'success', last_end_at = ?, last_error = ?
                WHERE email = ? AND status = 'running'
            `),
      allHistories: this.db.prepare(`
                SELECT email, ts, points, gained, duration_sec as durationSec
                FROM account_history
                ORDER BY email ASC, ts ASC
            `),
      allHistoriesSince: this.db.prepare(`
                SELECT email, ts, points, gained, duration_sec as durationSec
                FROM account_history
                WHERE ts >= ?
                ORDER BY email ASC, ts ASC
            `),

      insertActivity: this.db.prepare(`
                INSERT INTO activity (ts, level, title, kind, user_name, platform, email, message, raw)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
      recentActivity: this.db.prepare(`
                SELECT ts, level, title, kind, user_name as userName, platform, email, message, raw
                FROM activity ORDER BY id DESC LIMIT ?
            `),
      // 只数"结算行"（运行结算要读的那些）；噪音行单独计数、单独限量。
      countActivity: this.db.prepare(
        "SELECT COUNT(*) as n FROM activity WHERE kind IS NOT 'generic'",
      ),
      countGenericActivity: this.db.prepare(
        "SELECT COUNT(*) as n FROM activity WHERE kind = 'generic'",
      ),
      pruneGenericActivity: this.db.prepare(`
                DELETE FROM activity WHERE id IN (
                    SELECT id FROM activity WHERE kind = 'generic' ORDER BY id ASC LIMIT ?
                )
            `),
      pruneActivity: this.db.prepare(`
                DELETE FROM activity WHERE id IN (
                    SELECT id FROM activity ORDER BY id ASC LIMIT ?
                )
            `),
    };
  }

  _readMeta(key) {
    const row = this.stmts.getMeta.get(key);
    return row ? row.value : null;
  }

  _writeMeta(key, value) {
    this.stmts.setMeta.run(key, value);
  }

  get lastTs() {
    return this._lastTs;
  }

  // Null once no wait is in progress (never set, resolved by the next
  // ACCOUNT-START, or cleared because the run itself ended/closed).
  get pendingDelay() {
    return this._pendingDelay;
  }

  _resetCompletionEvidence() {
    this._workersExitedCleanly = false;
    this._workersExitedAt = null;
    this._anyWorkerExitedUncleanly = false;

    this._successfulWrapperCompletion = false;
    this._successfulWrapperCompletionAt = null;
    this._wrapperFailureSeen = false;
  }

  // Successful completion requires BOTH:
  //   1. The final cluster worker exited with Code 0, no signal, and
  //      Active workers: 0, AND no other worker this run ever exited
  //      uncleanly (see the cluster-worker-exit case in apply()).
  //   2. The wrapper reported successful completion.
  // This is the fallback for the bot-side clustering bug where RUN-END
  // itself never gets logged even though the process really did finish
  // cleanly - it must NOT fire on its own from "Lock released"/"Script
  // finished" alone, since those also happen after crashes/kills.
  _tryCloseFromSuccessfulProcessCompletion(eventTs) {
    const running = this.stmts.findRunningRun.get();
    if (!running) return false;
    if (!this._workersExitedCleanly || !this._successfulWrapperCompletion) {
      return false;
    }

    const endTs =
      this._successfulWrapperCompletionAt ||
      this._workersExitedAt ||
      eventTs ||
      new Date().toISOString();

    const totals = this.stmts.sumHistorySince.get(running.startTs);
    const resolved = this.stmts.accountsResolvedSince.get(running.startTs);
    // 全部行 gained 为 null（基线未知）时 SUM 就是 NULL —— 那是"不知道"，不是 0。
    // 以前 COALESCE(...,0) 加上这里的 `|| 0`，把整轮结账成"恰好赚了 0"，
    // 还反推出 old_total = new_total，凭空造出一个基线。runs 表这三列本来就允许
    // null（见 store.js 的 CREATE TABLE runs），所以"未知"可以如实存下去。
    const gained = totals.gained;
    const newTotal = totals.points;
    const oldTotal = newTotal != null && gained != null ? newTotal - gained : null;
    const runtimeMin = Number(
      ((Date.parse(endTs) - Date.parse(running.startTs)) / 60000).toFixed(1),
    );

    this.stmts.closeRunFull.run(
      "done",
      endTs,
      resolved.n || 0,
      gained,
      oldTotal,
      newTotal,
      runtimeMin,
      0,
      null,
      running.id,
    );

    // The overall process completed successfully, so any account still
    // marked 'running' failed to emit its own terminal event. Mark it
    // success (not error) since the run itself succeeded - keep the
    // diagnostic in last_error so the missing per-account result stays
    // visible.
    for (const row of this.stmts.orphanedRunningAccounts.all(running.startTs)) {
      this.stmts.markAccountCompletedWithoutResult.run(
        endTs,
        "Run completed successfully, but this account's own result was never logged (its worker likely failed silently).",
        row.email,
      );
    }

    this._pendingDelay = null;
    this._resetCompletionEvidence();
    return true;
  }

  // Watchdog for a run whose first account never even started (see
  // ZERO_START_STALE_MS above). Left unhandled, this also wedges every
  // future run: the run-start echo check below treats "roster incomplete"
  // as "same run continuing" for up to RUN_STALE_BACKSTOP_MS (20h), and a
  // run with zero accounts started can NEVER complete its roster, so every
  // subsequent RUN-START within that window would otherwise be silently
  // swallowed as a supposed echo of this dead run instead of starting a new
  // one.
  _tryCloseZeroStartRun() {
    const running = this.stmts.findRunningRun.get();
    if (!running) return;

    const startedCount = this.stmts.accountsStartedSince.get(running.startTs).n;
    if (startedCount > 0) return;

    const ageMs = Date.now() - Date.parse(running.startTs);
    if (!Number.isFinite(ageMs) || ageMs < ZERO_START_STALE_MS) return;

    this._closeRunningRun(running, "stalled", new Date().toISOString());
  }

  // General safety net for a run that hung PARTWAY through - covers the
  // zero-start case too (no activity since start is a special case of "no
  // activity for a long time"), but is deliberately much more generous
  // (RUN_NO_ACTIVITY_STALE_MS) since a run that already has accounts in
  // flight can have legitimate bursty gaps that a brand-new run can't.
  //
  // Explicitly does NOT fire while the run is waiting on a still-open
  // manual login-approval prompt - that can legitimately take a long time
  // (this is exactly why RUN_STALE_BACKSTOP_MS is 20h instead of something
  // short), and is a real, expected reason for silence rather than a hang.
  _tryCloseStaleNoActivityRun() {
    const running = this.stmts.findRunningRun.get();
    if (!running) return;

    const lastActivity = this.stmts.lastActivitySince.get(running.startTs);
    const lastTs = (lastActivity && lastActivity.ts) || running.startTs;
    const ageMs = Date.now() - Date.parse(lastTs);
    if (!Number.isFinite(ageMs) || ageMs < RUN_NO_ACTIVITY_STALE_MS) return;

    const pendingApproval = this.stmts.lastLoginPromptKindSince.get(running.startTs);
    if (pendingApproval && pendingApproval.kind === "login-number") return;

    this._closeRunningRun(running, "stalled", new Date().toISOString());
  }

  _pushActivity(event) {
    this.stmts.insertActivity.run(
      event.ts,
      event.level || null,
      event.title || null,
      event.kind || null,
      event.userName || null,
      event.platform || null,
      event.email || null,
      event.message || null,
      event.raw || null,
    );
    // 结算行与噪音行各查各的、各删各的：一个全局上限会让 generic 噪音把预算吃光，
    // 从而删掉本轮运行自己写入的结算行（见 MAX_GENERIC_ROWS 处的说明）。
    const { n } = this.stmts.countActivity.get();
    if (n > MAX_ACTIVITY_ROWS) {
      this.stmts.pruneActivity.run(n - MAX_ACTIVITY_ROWS);
    }
    const { n: g } = this.stmts.countGenericActivity.get();
    if (g > MAX_GENERIC_ROWS) {
      this.stmts.pruneGenericActivity.run(g - MAX_GENERIC_ROWS);
    }
  }

  apply(event, { backfill = false } = {}) {
    if (!event || !event.ts) return false;

    // 正常路径：时间戳单调递增，旧事件直接丢弃（SSE 会重发历史）。
    // 补录路径：进来的就是历史事件，必须允许比水位旧 —— 但水位只升不降，
    // 否则一次补录会把水位往回拉，之后的实时事件就会被误判成"旧"而丢弃。
    if (!backfill && this._lastTs && event.ts <= this._lastTs) {
      return false;
    }
    if (!this._lastTs || event.ts > this._lastTs) {
      this._lastTs = event.ts;
      this._writeMeta("lastTs", event.ts);
    }

    let changed = true;

    switch (event.kind) {
      case "account-start": {
        if (!this._pendingDelay || !this._pendingDelay.nextEmail || this._pendingDelay.nextEmail === event.email) {
          this._pendingDelay = null;
        }
        this.stmts.upsertAccountStart.run(
          event.email,
          event.userName || null,
          event.geoLocale || null,
          event.ts,
        );
        this._pushActivity(event);
        break;
      }
      case "account-end": {
        this.stmts.upsertAccountEnd.run(
          event.email,
          event.userName || null,
          event.ts,
          event.gained,
          event.newPoints,
          event.durationSec,
        );
        this.stmts.insertHistory.run(
          event.email,
          event.ts,
          event.newPoints,
          event.gained,
          event.durationSec,
        );
        this._pushActivity(event);
        this._scheduleAutoCloseCheck();
        break;
      }
      case "account-error": {
        if (event.email) {
          this.stmts.upsertAccountError.run(event.email, event.ts, event.error);
        }
        this._pushActivity(event);
        this._scheduleAutoCloseCheck();
        break;
      }
      case "account-delay": {
        this._pendingDelay = {
          seconds: event.seconds,
          sinceTs: event.ts,
          nextEmail: event.nextEmail || null,
        };
        this._pushActivity(event);
        break;
      }
      case "streak-protection": {
        this.stmts.upsertStreakProtection.run(
          event.email,
          event.userName || null,
          event.enabled ? 1 : 0,
          event.remainingDays,
          event.streakCounter,
          event.ts,
        );
        break;
      }
      case "run-start": {
        // With clustering on, the bot logs one RUN-START line per worker
        // spawned for the SAME run, not once per run - e.g. Clusters: 3
        // can produce several near-identical RUN-START lines, one per
        // worker, and workers have been observed spawning minutes apart
        // rather than seconds (accountDelay-dependent) - so elapsed time
        // alone can't tell an echo apart from a genuinely new run. Only
        // the first one (nothing currently 'running') starts a new row;
        // later ones for the same run are redundant echoes and must be
        // ignored, not treated as evidence the previous row crashed.
        //
        // Use the account roster instead of a clock: while the currently
        // 'running' row hasn't yet seen ACCOUNT-START for all the accounts
        // it declared, any further RUN-START is still just another worker
        // of that same run. Once every declared account has started, the
        // roster is complete and a new RUN-START can only mean a new run -
        // this also catches a 'running' row stuck by a lost RUN-END/exit
        // signal (e.g. a container restart mid-run, or a missed cluster
        // worker exit), which otherwise permanently wedges every future run
        // (this event would be dropped forever, never even reaching the
        // activity feed, and any later RUN-END would misattribute to that
        // ancient row instead of getting a fresh one of its own).
        //
        // The one gap the roster check can't cover is a run that died
        // before its roster ever filled (e.g. crashed after account 1 of
        // 3) - nothing will ever complete that roster, so fall back to a
        // generous time backstop just for that case.
        this._resetCompletionEvidence();

        const alreadyRunning = this.stmts.findRunningRun.get();
        if (alreadyRunning) {
          const startedCount = alreadyRunning.totalAccounts
            ? this.stmts.accountsStartedSince.get(alreadyRunning.startTs).n
            : 0;
          const rosterIncomplete =
            alreadyRunning.totalAccounts != null && startedCount < alreadyRunning.totalAccounts;
          const ageMs = Date.parse(event.ts) - Date.parse(alreadyRunning.startTs);
          const withinBackstop = Number.isFinite(ageMs) && ageMs >= 0 && ageMs < RUN_STALE_BACKSTOP_MS;
          // A run whose roster never even started (startedCount === 0) can
          // never complete its roster, so it would otherwise look like an
          // "echo" forever (up to the 20h backstop) and swallow every
          // subsequent RUN-START. The zero-start watchdog normally closes
          // these well before another RUN-START arrives, but this is a
          // safety net for e.g. the dashboard process itself having
          // restarted and lost that timer.
          const zeroStartStale =
            startedCount === 0 &&
            Number.isFinite(ageMs) &&
            ageMs >= ZERO_START_STALE_MS;
          const isEcho = rosterIncomplete && withinBackstop && !zeroStartStale;
          if (isEcho) {
            changed = false;
            break;
          }
          // We only know a new run started before the old one finished
          // normally - not why (could be a real crash, or just as likely an
          // intentional container recreate, e.g. pulling an updated image
          // mid-run). "interrupted" reflects that honestly instead of
          // guessing "crashed". markInterruptedByBackendRestart() below
          // handles the common container-recreate case immediately instead
          // of leaving it to this backstop.
          this._closeRunningRun(
            alreadyRunning,
            zeroStartStale ? "stalled" : "interrupted",
            event.ts,
          );
        }
        this.stmts.insertRunStart.run(
          event.ts,
          event.ts,
          event.version,
          event.totalAccounts,
          event.clusters,
        );
        this._pushActivity(event);
        break;
      }
      case "cluster-worker-exit": {
        // Worker PIDs are deliberately irrelevant to the decision - every
        // account can have a different PID and every run can use completely
        // different PIDs.
        //
        // IMPORTANT: an earlier worker in the same run can exit uncleanly
        // (crash/signal) before a LATER worker happens to be the one that
        // reports "Active workers: 0". Only checking the final exit line
        // would miss that earlier crash, so an unclean exit is latched for
        // the whole run and blocks treating a later clean "Active workers:
        // 0" line as proof the overall process completed cleanly.
        const exitedCleanly = event.code === 0 && event.signal == null;
        if (!exitedCleanly) {
          this._anyWorkerExitedUncleanly = true;
        }
        if (
          exitedCleanly &&
          event.activeWorkers === 0 &&
          !this._anyWorkerExitedUncleanly
        ) {
          this._workersExitedCleanly = true;
          this._workersExitedAt = event.ts;
          // May close the run immediately if wrapper completion evidence
          // already arrived.
          this._tryCloseFromSuccessfulProcessCompletion(event.ts);
        }
        this._pushActivity(event);
        break;
      }
      case "wrapper-script-completed": {
        // "Script completed successfully (via API)." is an explicit,
        // unambiguous positive completion signal.
        this._successfulWrapperCompletion = true;
        this._successfulWrapperCompletionAt = event.ts;
        this._tryCloseFromSuccessfulProcessCompletion(event.ts);
        this._pushActivity(event);
        break;
      }
      case "wrapper-script-finished": {
        // Weaker evidence than "Script completed successfully": some
        // wrapper versions print this unconditionally on the way out,
        // including right after "ERROR: Script failed!". Only count it as
        // completion evidence if no failure has been seen yet this run, so
        // it can't silently resurrect a run we already know failed.
        if (!this._wrapperFailureSeen) {
          this._successfulWrapperCompletion = true;
          this._successfulWrapperCompletionAt = event.ts;
          this._tryCloseFromSuccessfulProcessCompletion(event.ts);
        }
        this._pushActivity(event);
        break;
      }
      case "wrapper-script-failed": {
        // Explicit wrapper failure is not completion evidence, and it
        // "poisons" the rest of this run so a later bare "Script finished"
        // line can't flip it back to success.
        this._wrapperFailureSeen = true;
        this._successfulWrapperCompletion = false;
        this._successfulWrapperCompletionAt = null;
        this._pushActivity(event);
        break;
      }
      case "wrapper-lock-acquired": {
        this._pushActivity({
          ...event,
          message: `Cron run starting (lock acquired, PID ${event.pid})`,
        });
        break;
      }
      case "wrapper-lock-released": {
        // Fires via run_daily.sh's bash EXIT trap, including after a
        // crash/kill - so by itself it's never proof of success. If worker +
        // wrapper evidence already proves a clean completion, this may be
        // the event that finally closes the run (e.g. if it arrived before
        // RUN-END for some reason). Otherwise, if a run is still marked
        // 'running' by the time this shows up, that's proof nothing else is
        // coming for it and it's genuinely abnormal - close it out rather
        // than leaving a permanent ghost. This only covers wrapper-invoked
        // runs (cron/RUN_ON_START); a run started directly via the
        // dashboard/API still relies on closeRunOnExit for that case.
        const closedSuccessfully = this._tryCloseFromSuccessfulProcessCompletion(
          event.ts,
        );

        if (!closedSuccessfully) {
          const stillRunning = this.stmts.findRunningRun.get();
          if (stillRunning) {
            this._closeRunningRun(stillRunning, "interrupted", event.ts);
          }
        }

        if (event.pid) {
          this._pushActivity({
            ...event,
            message: closedSuccessfully
              ? `Cron run finished successfully (lock released, PID ${event.pid})`
              : `Cron run finished (lock released, PID ${event.pid})`,
          });
        }
        break;
      }
      case "run-end": {
        this._pendingDelay = null;
        const running = this.stmts.findRunningRun.get();
        if (running) {
          // RUN-END only ever gets logged by the app itself, so we know the
          // process didn't crash or get signaled - use closeRunFull (not
          // closeRun) so exit_code/exit_signal stay consistent with the
          // other closing paths.
          this.stmts.closeRunFull.run(
            "done",
            event.ts,
            event.accountsProcessed,
            event.totalGained,
            event.oldTotal,
            event.newTotal,
            event.runtimeMin,
            0,
            null,
            running.id,
          );
          // RUN-END firing is proof the run is genuinely over - any account
          // still marked 'running' from it never got its own ACCOUNT-END or
          // ACCOUNT-ERROR (worker died silently), and would otherwise stay
          // stuck 'running' forever. Since this is a successfully completed
          // overall run, finalize those accounts as success while retaining
          // the diagnostic that their individual result was missing.
          for (const row of this.stmts.orphanedRunningAccounts.all(running.startTs)) {
            this.stmts.markAccountCompletedWithoutResult.run(
              event.ts,
              "Run completed, but this account's own result was never logged (its worker likely failed silently).",
              row.email,
            );
          }
        } else {
          this.stmts.insertOrphanRunEnd.run(
            event.ts,
            event.ts,
            event.accountsProcessed,
            event.totalGained,
            event.oldTotal,
            event.newTotal,
            event.runtimeMin,
          );
        }
        this._resetCompletionEvidence();
        this._pushActivity(event);
        break;
      }
      case "task-list": {
        // bot 每轮解析任务列表后发"任务列表 | 父任务=N | 未完成=M"（src/browser/
        // ReactFunc.ts:788）。父任务是总数，完成数 = 总数 - 未完成。面板 overview.js
        // 的"总任务/已完成"两格读的就是这两个字段。
        // 按 user_name 关联 —— 这条行的账号段是用户名而不是邮箱（见 setAccountTasks）。
        // 不写 activity：它每轮都重发，进活动表只会挤掉真正需要留的行。
        if (event.userName && event.total != null) {
          this.stmts.setAccountTasks.run(
            event.total,
            event.completed,
            event.userName,
          );
          changed = true;
        }
        break;
      }
      case "login-number": {
        this._pushActivity({
          ...event,
          level: "warn",
          message: `Login approval needed for ${event.userName}: select number ${event.number}`,
        });
        break;
      }
      case "login-number-resolved": {
        // 只写一条 activity 行：这是"这次登录确认已经被处理掉"的记号。
        // 缺了它，lastLoginPromptKindSince 只看得见请求、看不见解决，于是一个用户
        // 早已输完码、机器人也继续跑了的账号，会一直显示成"等待选择登录数字"。
        // （实时界面不走这里 —— server.js 另有一支直接清 pendingLoginCodes。）
        this._pushActivity({
          ...event,
          level: "info",
          message: `Login approval resolved for ${event.userName}`,
        });
        break;
      }
      case "account-balance-read": {
        // 上游标注"初始余额不可信"时给出的那个读数。它不是一次完成：只写一条余额快照
        // （points=N、gained=null），不碰 status、不调 _scheduleAutoCloseCheck ——
        // 读一条余额不等于跑完一次，把它当完成会让运行提前收尾。
        // 去重靠已有的秒级唯一索引 + insertHistory 的 INSERT OR IGNORE，重放不会重复。
        if (event.email && event.newPoints != null) {
          this.stmts.insertHistory.run(
            event.email,
            event.ts,
            event.newPoints,
            null,
            null,
          );
        }
        break;
      }
      case "generic": {
        if (event.level === "warn" || event.level === "error") {
          this._pushActivity(event);
        } else {
          changed = false;
        }
        break;
      }
      default:
        changed = false;
    }

    return changed;
  }

  // Defers the stale-running-run check rather than running it inline: the
  // bot's own RUN-END normally follows within ~1s of the last account, so
  // firing immediately would race it and risk closing the run ourselves
  // right before the real RUN-END arrives, which would then find no
  // 'running' row and create a duplicate orphan instead of just updating
  // this one. Rescheduling on every account-end/error also means the timer
  // only ever fires AUTO_CLOSE_GRACE_MS after the LAST one in a batch.
  _scheduleAutoCloseCheck() {
    if (this._autoCloseTimer) clearTimeout(this._autoCloseTimer);
    this._autoCloseTimer = setTimeout(() => {
      this._autoCloseTimer = null;
      try {
        this._tryAutoCloseStaleRun();
      } catch {
        /* best-effort safety net - a miss here just leaves the row as-is */
      }
    }, AUTO_CLOSE_GRACE_MS);
    if (this._autoCloseTimer.unref) this._autoCloseTimer.unref();
  }

  // Shared terminal-state closer for any 'running' row being ended without
  // the bot's own authoritative RUN-END line (auto-close/crash/stop/
  // interrupt) - derives accountsProcessed/gained/totals from
  // account_history instead, and demotes any account this run left stuck at
  // 'running' to 'error', since nothing else is coming for it once the run
  // itself is closed.
  _closeRunningRun(running, status, endTs, { code = null, signal = null } = {}) {
    this._pendingDelay = null;
    const totals = this.stmts.sumHistorySince.get(running.startTs);
    const resolved = this.stmts.accountsResolvedSince.get(running.startTs);
    // 全部行 gained 为 null（基线未知）时 SUM 就是 NULL —— 那是"不知道"，不是 0。
    // 以前 COALESCE(...,0) 加上这里的 `|| 0`，把整轮结账成"恰好赚了 0"，
    // 还反推出 old_total = new_total，凭空造出一个基线。runs 表这三列本来就允许
    // null（见 store.js 的 CREATE TABLE runs），所以"未知"可以如实存下去。
    const gained = totals.gained;
    const newTotal = totals.points;
    const oldTotal = newTotal != null && gained != null ? newTotal - gained : null;
    const runtimeMin = Number(
      ((Date.parse(endTs) - Date.parse(running.startTs)) / 60000).toFixed(1),
    );

    this.stmts.closeRunFull.run(
      status,
      endTs,
      resolved.n || 0,
      gained,
      oldTotal,
      newTotal,
      runtimeMin,
      code,
      signal,
      running.id,
    );

    for (const row of this.stmts.orphanedRunningAccounts.all(running.startTs)) {
      this.stmts.markAccountInterrupted.run(
        endTs,
        `Run ${status} before this account finished`,
        row.email,
      );
    }

    this._resetCompletionEvidence();
  }

  // Safety net for the bot-side clustering bug where a worker's exit is
  // never observed by its primary, so 'activeWorkers' never reaches 0 and
  // RUN-END is never logged even though every account actually finished.
  // Once every account the run declared (total_accounts) has resolved
  // (ACCOUNT-END or ACCOUNT-ERROR) since it started, treat the run as done
  // and derive its totals from account_history instead of waiting forever.
  _tryAutoCloseStaleRun() {
    const running = this.stmts.findRunningRun.get();
    if (!running || !running.totalAccounts) return;

    const resolved = this.stmts.accountsResolvedSince.get(running.startTs);
    if (!resolved || resolved.n < running.totalAccounts) return;

    this._closeRunningRun(running, "done", resolved.lastTs || new Date().toISOString());
  }

  closeRunOnExit(exit) {
    const running = this.stmts.findRunningRun.get();
    if (!running) return false;
    const code = exit?.code ?? null;
    const signal = exit?.signal ?? null;

    // A clean exit (code 0, no signal) almost always means the app already
    // logged its own RUN-END line, which the "run-end" event handler above
    // closes with the real accounts/points data. Racing ahead here would
    // stamp this row 'done' with everything NULL, then force run-end into
    // creating a second, orphaned row once it can't find this one anymore -
    // exactly the empty "Done -/N" duplicates this was producing. Only step
    // in for crashes/kills, where no RUN-END line is ever coming.
    if (!signal && code === 0) return false;

    // This path comes from the Control API directly observing its own child
    // process exit, so (unlike the "interrupted" paths above) we have real
    // evidence here: a signal means something intentionally stopped it
    // (stopped), while a bare non-zero code with no signal means the app
    // exited on its own with a failure (crashed).
    const status = signal ? "stopped" : "crashed";
    this._closeRunningRun(
      running,
      status,
      exit?.at || new Date().toISOString(),
      { code, signal },
    );
    return true;
  }

  // Called when the dashboard detects the Control API/container itself
  // restarted mid-poll (health.uptimeSec went backwards) - a much faster and
  // more direct signal than waiting for a new RUN-START to eventually prove
  // the old row is stale. Covers container recreation for any reason
  // (image update, manual restart, OOM kill, host reboot), which is why the
  // result is "interrupted" rather than "crashed": we only know the backend
  // vanished, not why.
  //
  // notStartedAfter guards a race with the SSE log stream, which can notice
  // the same disconnect on its own and reconnect - possibly processing a
  // brand new RUN-START - before this poll-driven check runs. Only close a
  // row that was already 'running' as of the last known-good health check;
  // never one that could be that legitimate new run.
  markInterruptedByBackendRestart(at = new Date().toISOString(), { notStartedAfter = null } = {}) {
    const running = this.stmts.findRunningRun.get();
    if (!running) return false;
    if (notStartedAfter && running.startTs >= notStartedAfter) return false;
    this._closeRunningRun(running, "interrupted", at);
    return true;
  }

  // schedule
  getSchedule() {
    const raw = this._readMeta("schedule");
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  setSchedule(config) {
    this._writeMeta("schedule", JSON.stringify(config));
    return config;
  }

  snapshotAccounts() {
    return this.stmts.allAccounts.all();
  }

  snapshotRuns(limit = 30) {
    return this.stmts.recentRuns.all(limit);
  }

  allAccountHistories({ since = null } = {}) {
    const rows = since
      ? this.stmts.allHistoriesSince.all(since)
      : this.stmts.allHistories.all();
    const byEmail = {};
    for (const row of rows) {
      if (!byEmail[row.email]) byEmail[row.email] = [];
      byEmail[row.email].push({
        ts: row.ts,
        points: row.points,
        gained: row.gained,
        durationSec: row.durationSec,
      });
    }
    return byEmail;
  }

  snapshotActivity(limit = 100) {
    return this.stmts.recentActivity.all(limit);
  }

  accountHistory(email) {
    return this.stmts.historyForEmail.all(email);
  }

  // Purges everything the dashboard has ever recorded for an account it no
  // longer tracks (e.g. removed from the bot's .env) - the accounts row
  // itself plus its point history and activity log entries - so it stops
  // showing up anywhere (accounts list, overview, history charts).
  deleteAccount(email) {
    this.db.exec("BEGIN");
    try {
      this.stmts.deleteAccountRow.run(email);
      this.stmts.deleteAccountHistory.run(email);
      this.stmts.deleteAccountActivity.run(email);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  saveNow() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  }

  close() {
    if (this._autoCloseTimer) clearTimeout(this._autoCloseTimer);
    if (this._zeroStartWatchdog) clearInterval(this._zeroStartWatchdog);
    this.saveNow();
    this.db.close();
  }
}

module.exports = { Store };