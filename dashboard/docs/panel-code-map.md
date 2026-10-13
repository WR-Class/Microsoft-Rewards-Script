# 面板代码地图（前端 ↔ 后端接线）

给要重做仪表盘设计的人看的。**先看第 0 节，否则会对着错的后端设计。**

本文档里每一个端点都对着源码里的路由表核过，每一个路径都确认存在。
**第 7 节分两半**：7.1 是原本的盲区、现已逐条核实（每条都写了证据位置，可当事实用）；
7.2 是仍未核实的 —— **只有 7.2 里那几条别当事实用**。

---

## 0. 这里有三个进程，不是一个

```
┌──────────────────────────────────────────────────────────────────────┐
│ ① 机器人本体  node dist/index.js                                      │
│    没有 HTTP 服务。它的输出全是「文件」：                              │
│      logs/YYYY-MM-DD.log        ← 一行一条结构化日志（唯一的事实源）    │
│      sessions/sessions.db       ← 登录会话（sessions / account_metadata）│
│      diagnostics/error-*/       ← 每次报错的截图 + dump.html + error.txt │
└──────────────────────────────────────────────────────────────────────┘
                    │ 读日志/会话文件
                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│ ② 控制 API  node scripts/api/server.js --port 3010                    │
│    需要 token（$env:API_TOKEN）。这是「机器人状态」的唯一 HTTP 出口。   │
│    实现：scripts/api/server.js                                        │
│    支撑模块：logParser.js / logReplay.js / sessionStore.js /          │
│              scheduleStore.js / processManager.js / configEditor.js   │
└──────────────────────────────────────────────────────────────────────┘
                    │ ②的客户端（lib/apiClient.js）
                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│ ③ 面板服务  node server.js  （:8890，dashboard/rewards-dashboard/）    │
│    自己的 SQLite：data/dashboard.sqlite                                │
│    对外只暴露 /api/*，同时把 ② 的部分端点代理出去。                     │
└──────────────────────────────────────────────────────────────────────┘
                    │ 浏览器 fetch /api/*
                    ▼
              前端 public/（原生 JS，无框架、无构建步骤）
```

**给设计者的三个要点：**

1. **前端只认识 `/api/*`，但面板后端不是只走控制 API。** 实时状态走 ②（控制 API 的
   SSE）；**启动时它还会直接读 ① 的 `logs/*.log`**（`lib/logFileReplay.js`）。
   原因是 ② 的日志缓冲区只有 2000 行，而一天的日志有 6000+ 行 —— 只靠 SSE 的话，
   漏掉一条结束行，那个账号就永远停在「运行中」，**重启也救不回来**。详见第 3 节。
2. **前端没有构建步骤。** `public/` 下的 `.js` 原样被浏览器加载（ESM `import`），
   改完刷新即生效，没有 webpack/vite。`sw.js` 对同源静态是 **network-first**（见 7.1⑥），
   所以**普通刷新就够，不需要硬刷新**。
3. **日志是唯一事实源。** 几乎所有数字最终都能追到 `logs/*.log` 的某一行。
4. **一条日志要经过四个函数才变成面板里的数字**（顺序不能错）：

   ```
   EventHub  →  hub.on("entry")  →  entryToDockerLine(entry)  →  parseLine(line)  →  store.apply(event)
   ```

   `entryToDockerLine` 会给行首补一个合成时间戳。**解析器要求行首是"一个"非空白
   token**（`DOCKER_TS_RE = /^(\S+)\s([\s\S]*)$/`，形如 `2026-07-01T12:03:12.123Z`）。

   两个坑叠在一起，都会静默返回 `null`，不报错、不抛异常：

   - 直接拿**原始日志行**喂 `parseLine`：行首没有合成时间戳 → 实测 14517 行解析出 0 条事件。
   - 自己补前缀、但补成 `2026-10-12 13:42:00.123 `（**带空格**）：`\S+` 只吃掉日期部分，
     剩下的不以 `[` 开头，`APP_LINE_RE` 于是不匹配 → 同样 0 条。**日志文件里的行自带
     这种带空格前缀**，必须先剥掉，再补一个单 token 的时间戳。

   `store.apply` 的时间戳单调去重也会静默丢弃事件（补录时用 `{ backfill: true }` 绕过）。

---

## 1. 控制 API（:3010）端点表

来自 `scripts/api/server.js` 的路由表。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/` | 概览/自述 |
| GET | `/health` | 存活与鉴权检查 |
| GET | `/status` | 机器人当前状态（含 `pendingDelay` 等） |
| GET | `/points` | **积分**（余额等） |
| GET | `/logs` | 日志（可带 limit / level / warnings 过滤） |
| GET | `/errors` | 错误 |
| GET | `/history` | **历史（按天的聚合，面板图表的数据源）** |
| GET | `/accounts` | 账号列表 |
| GET | `/sessions` | 登录会话 |
| DELETE | `/sessions` | 清会话 |
| GET | `/diagnostics` | 报错现场列表 |
| GET | `/config` | 配置 |
| GET | `/config/diff` | 配置差异 |
| POST | `/config/sync` | 同步配置 |
| PUT/PATCH | `/config` | 改配置 |
| GET | `/schedule` | 调度 |
| PUT/PATCH | `/schedule` | 改调度 |
| GET | `/events` | **SSE 实时流** |
| POST | `/start` `/stop` `/restart` `/shutdown` | 进程控制 |

---

## 2. 面板服务（:8890）端点表

来自 `dashboard/rewards-dashboard/server.js` 的路由表。前端只调这些。

| 方法 | 路径 | 前端消费者 |
|---|---|---|
| GET | `/api/events` | SSE 实时流（`lib/eventHub.js`） |
| GET | `/api/summary` | 总览统计卡 |
| GET | `/api/accounts` | **总览的账号列表 + 失败原因** |
| GET | `/api/runs` | 运行历史 |
| GET | `/api/logs` | 日志页 |
| GET | `/api/errors` | 错误页 |
| GET | `/api/login-codes` | 登录验证码 |
| GET/PUT | `/api/schedule` | 调度页 |
| GET | `/api/cron` | 定时表达式 |
| GET/PUT | `/api/config` | 配置页 |
| GET | `/api/config/diff` | 配置差异 |
| POST | `/api/config/sync` | 同步配置 |
| GET | `/api/diagnostics`、`/api/diagnostics/*` | 报错现场页 |
| GET | `/api/sessions`、DELETE `/api/sessions/*` | 会话管理 |
| GET/POST | `/api/accounts/manage` | 保存的账号管理 |
| DELETE | `/api/dashboard-accounts/*` | 删除面板账号 |

---

## 3. 面板后端模块（`dashboard/rewards-dashboard/lib/`）

| 文件 | 职责 |
|---|---|
| `apiClient.js` | 控制 API 的 HTTP 客户端。面板 server 里所有 `client.get("/status")` 都走它。**还导出 `entryToDockerLine(entry)`** —— 实时链路的必需一环（见第 0 节要点 4） |
| `parser.js` | **日志行解析**（把一行日志变成结构化字段；`REACT-PARSE`、`PUNCHCARD` 等 case 在这）。**数字字段一律同时接受 `null`**：上游在"基线未知"时会写 `null` 而不是数字，按 `\d+` 抓会整行匹配失败。<br>与本面板直接有关的两条规则：`已解析任务子项 \| 总数=N \| 可上报=M` → `task-progress`（**`可上报` = 未完成**，所以已完成 = 总数 − 可上报）；`任务列表 \| 父任务=N \| 未完成=M` **不要用** —— 它的 `complete` 依赖抓取片段里出现 `N / M tasks` 进度文本，实测 4 天 135 行一次都没匹配到，`未完成` 恒等于 `父任务`、完成数恒为 0<br>**RUN-END 的部分和**：行里带「（另有 N 个账号基线未知，未计入）」（挂 `原余额`）或「（另有 N 个账号余额未知，未计入）」（挂 `现余额`）时，**对应字段解析成 `null` 而不是那个数**。括注必须是非捕获的（否则 `am[3]/am[4]/am[5]` 会整体平移），正因为它非捕获，注解要用 `PARTIAL_BASELINE_RE` / `PARTIAL_BALANCE_RE` 单独再取一次；`获得积分` 没有自己的注解，任一注解出现即 `null`。不这样做，运行记录页会把 9/10 账号未知的部分和当成"现余额 0"显示。**回归测试：`node tools/test-parser-runend.mjs`**，加 `--logs` 会把 `logs/*.log` 里全部 RUN-END 行重解析一遍核对不变量 |
| `store.js` | `Store` 类，SQLite 读写与聚合（账号 / 运行 / 历史 / 事件）。面板的数据面。`apply(event, { backfill })`：补录允许比水位旧，但水位只升不降。<br>**账号关联键看字段**：`account-end` 等行按 `email`；`task-progress` 那行的账号段是**用户名**，所以 `setAccountTasks` 按 `user_name` 关联（实测 10 个账号按 email 命中 0 行、按 user_name 命中 1 行；写错会一行都更新不到，**且不报错**）。对外字段经 `snapshotAccounts()` / `allAccounts` 暴露成 camelCase |
| `logFileReplay.js` | **启动时从 `logs/*.log` 按账号对账补录**（`resolveLogDir` / `replayLogFiles`）。**必须在 `EventHub` 连接之前跑完**，否则补录会被时间戳守卫挡住 |
| `eventHub.js` | SSE 扇出：把新事件推给所有打开的浏览器。注意它的 `replay` 选项**只发给浏览器，不回写 SQLite** |
| `scheduler.js` / `cron.js` | 调度与定时 |
| `accounts.js` / `accountEnv.js` | 面板保存的账号 ↔ `.env` 变量的映射 |
| `failureReasons.js` | 把 `last_error` 归成失败原因 |
| `themeLoader.js` | 主题加载 |
| `pendingLoginCodes.js` | 待输入的登录验证码 |
| `netAccess.js` | 网络访问控制 |

面板数据库：`data/dashboard.sqlite`（`store.js` 独占写入）。

---

## 4. 前端模块（`dashboard/rewards-dashboard/public/`）

| 文件 | 职责 |
|---|---|
| `index.html` | 外壳 |
| `app.js` | 启动、路由、把 `ctx`（上下文）传给各视图 |
| `api.js` | `api`（端点对象）、`cached(key, fetcher, ttlMs)`（缓存层）、`invalidate(key)` |
| `util.js` | 工具（`escapeHtml`、`tzDayKey` 等） |
| `charts.js` | 图表构建器：`lineChart`、`barChart`、`buildHeatmapHtml`、**`buildAccumBarHtml`** |
| `views/overview.js` | **总览页（含「账户总览」那一块）** |
| `views/runs.js` | 运行历史页 |
| `views/accounts.js` | 账号页 |
| `views/logs.js` | 日志页 |
| `views/errors` → `diagnostics.js` | 报错现场页 |
| `views/config.js` | 配置页（含每个开关的中英文案） |
| `views/schedule.js` | 调度页 |
| `themeManager.js` + `themes/*.ts` | 主题（注意：主题是 `.ts`，但有 `lib/tsLite.js` 做轻量转译） |
| `zh-cn.js` | **i18n 字典。界面文案全部走 key → 中文映射** |
| `sw.js` | service worker：同源静态 **network-first**、跨域 CDN cache-first（见 7.1⑥）。改完普通刷新即生效 |

### i18n 规则（设计者最容易踩的坑）

界面上看到的「账户总览」，源码里搜不到 —— 它来自：

```js
// public/zh-cn.js:81
"Accounts Overview": "账户总览",
```

**所以：所有可见文案都以英文 key 写在代码里，中文在 `zh-cn.js` 里映射。**
新增界面文案时，两处都要加，否则会露出英文 key。

---

## 5. 「账户总览」这一块现在是怎么渲染的

位置：`public/views/overview.js`

```js
// 算出所有账号里的最大增益，作为条形图的统一标尺
const globalMax = bucketed.length ? ... : 0;
// 按账号 key 索引出「每天」的数组
const daysByKey = Object.fromEntries(bucketed.map((b) => [b.key, b.days]));

// 每个账号渲染一行
container.innerHTML = accounts.map((a) => {
    const days = daysByKey[a.key] || null;

    // 当天获得积分
    const todayGained = days?.find((d) => d.dayKey === todayKey)?.gained ?? null;
    // 总积分：跑的时候用实时余额，否则用上次结束时的余额
    const shownPoints = isRunning ? (a.liveBalance ?? a.lastPoints) : a.lastPoints;

    // 四个数字组成的统计带（前两个有值，后两个是空占位）
    const statStrip = `<div class="hero-stat-strip">
        <div class="hero-stat"><span class="hero-stat-num">${...}</span>
                           <span class="hero-stat-label">Points</span></div>
        <div class="hero-stat">… Today …</div>
        <div class="hero-stat">… Tasks …</div>
        <div class="hero-stat">… Done …</div>
    </div>`;

    // 累积条形图（截图里那排小条形）
    barCell = `<div class="accum-track"><div class="accum-bar">${buildAccumBarHtml(days, globalMax, isMobile ? 7 : null)}</div></div>`;

    // 左侧统计带 + 右侧条形图，同处一个 hero-row 网格里
    // → <div class="hero-bar-cell">${statStrip}${barCell}</div>
    ...
});
```

> **注意：本节的源码行号是加统计带之前的，已经整体偏移。** 按函数名和 class 名搜，
> 不要按行号跳。相关的 class：`.hero-row`（网格：左自适应 + 右 486px）、
> `.hero-bar-cell`、`.hero-stat-strip` / `.hero-stat` / `.hero-stat-num` / `.hero-stat-label`，
> 都在 `public/style.css`。**窄屏（≤768px）时只隐藏 `.hero-bar-cell .accum-track`，
> 统计带要保留** —— 早先那条规则是整块 `display:none`，加统计带后会把它一起藏掉。

`charts.js:300`：

```js
export function buildAccumBarHtml(days, globalMaxGained, maxDays = null)
```

**数据来源**（`overview.js` L536-537）：

```js
cached("summary",  ctx.api.summary,  3000),   // → /api/summary
cached("accounts", ctx.api.accounts, 5000),   // → /api/accounts
```

---

## 6. 要在「账户总览」里加字段，改哪几处

你（用户）要的四个数字，**现状（已按 2026-10-12 的改动更新）**：

| 想要的 | 现状 | 从哪来 |
|---|---|---|
| **总积分** | **已经显示** | `a.liveBalance ?? a.lastPoints`（跑的时候用实时余额，否则用上次结束时的余额） |
| **每日获得积分数** | **已经显示** | `days[].gained`，当天那条（`todayGained`） |
| **总任务量** | **已实现** | `a.totalTasks` ← `accounts.total_tasks` ← 日志 `[REACT-PARSE] 已解析任务子项 \| 总数=N \| 可上报=M` |
| **已完成任务** | **已实现** | `a.completedTasks` ← `accounts.completed_tasks` ← `总数 − 可上报` |

**这四个数字现在渲染在每行左侧的一条统计带里**（`.hero-stat-strip`，四个 `.hero-stat`），
右侧是累积条形图。**四个都有真实数据了。**

两件必须知道的事：

1. **数据源换过一次。** 最初接的是 `任务列表 \| 父任务=N \| 未完成=M`；跑完一轮发现
   10 个账号的"已完成"全是 0 —— 那条行的 `complete` 是死的（见第 3 节 `parser.js` 行），
   已改成 `已解析任务子项`。
2. **`总数` 的含义。** 它是"最后一次解析到的那个任务块里有几项"（实测 1~5），
   **不是**"这个账号一共有几个任务"；而 `总数 − 可上报` = **已完成 + 被锁定 + 被禁用**，
   所以"已完成"会略微高估。上游只报 `可上报`，不直接报"已完成" —— 这是它能给的最接近的数。

### 加一个字段的固定动作（六层，缺一层就不显示）

1. **解析** — `lib/parser.js`：在对应 tag 的 case 里从 `message` 抽数字。
   参考 `REACT-PARSE` 里 `task-progress` 那条分支（`TASK_ITEMS_RE`）。
2. **入库/聚合** — `lib/store.js`：在 `_migrate()` 里加列，在 `allAccounts` 的 SELECT 里加别名，
   并在 `apply()` 里处理写库。按 `(账号, 轮次/日期)` 归集。
3. **出接口** — `server.js`：在 `/api/accounts` 或 `/api/summary` 的响应里带上新字段
   （若数据在控制 API，则先在 `scripts/api/server.js` 加端点，再由 `lib/apiClient.js` 取）。
4. **穿过白名单** — `lib/accounts.js` 的 **`buildRow()`**：加一行 `字段名: local ? local.字段名 : null`。
   **这是最容易漏的一层**：`/api/accounts` 的 `accounts[]` 走 `mergeAccounts → buildRow`，
   而 `buildRow` 是显式白名单，store 里的新列**不会自动出现**。
   （`/api/summary` 的 `accounts` 是 store 原始行、不过这一层 —— 所以字段在两个接口里
   可见性可能不同。2026-10-13 我就漏了这一层，两格恒显示 `–`，见 41cf1db。）
5. **进前端** — `public/views/overview.js`：从 `a`（账号对象）或 `days` 里读出来，
   并加 null 守卫（拿不到要显示 `–`，不要显示 0）。
6. **文案** — 代码里写英文 key，`public/zh-cn.js` 里加中文映射（或像 `fail-action` 那样
   直接写中文说明文字；`zh-cn.js` 只重写英文文本节点，中文原样通过）。

### 这一块的设计意图（用户原话整理）

现在每一行只放了一个小条形图（`buildAccumBarHtml`），**整行大面积留白，很浪费**。
希望改成一行里同时看到：

- **总积分**（当前余额）
- **每日获得积分数**（趋势）
- **任务数：总任务 / 已完成任务**

目标是「一目了然」，而不是需要点进去才知道。

---

## 7. 原盲区：已核实与仍未核实

### 7.1 已核实（每条都写了证据在哪，可以当事实用）

**① `store` 的几张表由谁写满 —— 只有一个入口函数、两个调用方。**

所有写库都汇到 `store.apply(event, { backfill })`（`lib/store.js:629`），调用方只有两个：
`server.js:210`（实时：`EventHub → entryToDockerLine → parseLine → store.apply`）和
`lib/logFileReplay.js`（启动补录，带 `backfill: true`）。

| 表 | 谁写 | 关键语句 |
|---|---|---|
| `accounts` | 账号生命周期事件 | `upsertAccountStart` / `upsertAccountEnd` / `upsertAccountError` / `upsertStreakProtection` / `setAccountTasks` / `markAccountInterrupted` / `markAccountCompletedWithoutResult` |
| `account_history` | **只有两个事件**：`account-end`（`store.js:668`）和 `account-balance-read`（`store.js:978`） | `insertHistory`（`INSERT OR IGNORE`，靠秒级唯一索引去重，重放不会重复） |
| `activity` | **只有少数事件写活动**：账号边界（`account-start` / `account-end` / `account-error` / `account-delay`）、运行起止、登录提示、`cluster-worker-exit` 才经 `_pushActivity` → `insertActivity`。**不是每个事件都写** —— 实测一次 410 分钟的运行只落了 9 条（`account-start`×3、`account-end`×2、`account-delay`×2、`account-error`×1、`run-end`×1）。所以**不能拿 activity 判断"运行还活着"**：单账号耗时 113~156 分钟是常态，90 分钟没有活动行是正常的。看门狗的判据是 `apply()` 里记的 `_lastEventTs`（每行日志都过手），见 `_tryCloseStaleNoActivityRun` | 裁剪走 `countActivity` / `pruneActivity` / `pruneGenericActivity` |
| `runs` | 运行级事件 | `insertRunStart` / `closeRunFull` / `insertOrphanRunEnd`。**`status='stalled'` 的含义是"没有任何证据就放弃"**（看门狗/自动闭合抢先把还在跑的运行关掉），不是崩溃；`interrupted` / `stopped` / `crashed` 都有进程退出这类真实证据。RUN-END 到达而 `findRunningRun` 为空时，会先回头复用 6 小时内被关掉的 `stalled` 行（`RUN_END_REUSE_WINDOW_MS`），真没有才插 `start_ts` 为 NULL 的孤儿 —— 不这样做，同一次运行会出现两行（实测 2026-10-10）。回归测试：`node tools/test-store-watchdog.mjs` |
| `meta` | 杂项键值 | `_writeMeta` |

注意 `account-balance-read` 只写一条余额快照（`points=N`、`gained=null`），
**不碰 status、也不触发收尾** —— 读一条余额不等于跑完一次（`store.js:972-985`）。
所以 `account_history` 里 `gained` 为 NULL 的行是余额快照，不是一次完成。

**② `/api/summary` 的字段形状**（`server.js:522`）

```json
{
  "status":   { ... currentState()，见 server.js:175 ... },
  "accounts": [ ...store.snapshotAccounts()：**store 原始行**，见下表 ... ],
  "runs":     [ ...store.snapshotRuns(30) ... ],
  "activity": [ ...store.snapshotActivity(120) ... ]
}
```

- `runs[]`：`id, status, startTs, endTs, version, totalAccounts, clusters, accountsProcessed,
  totalGained, oldTotal, newTotal, runtimeMin, exitCode, exitSignal`
- `activity[]`：`ts, level, title, kind, userName, platform, email, message, raw`
- `status`（`currentState()`）：`reachable, authRequired, authOk, lastError, checkedAt, displayName,
  timezone, controlApiUrl, name, version, uptimeSec, bot, botState, botRunning, schedule,
  remoteSchedule, remoteScheduleSupported, stream, lastEventAt, pendingDelay, codes`
- **`accounts` 是 store 原始行**（`allAccounts` 的 SELECT 别名，`store.js:336`）：
  `email, userName, geoLocale, status, lastStartAt, lastEndAt, lastGained, lastPoints,
  lastDurationSec, lastError, streakProtection*, totalTasks, completedTasks`
  —— **不含**控制 API 的配置字段（`index/langCode/hasTotp/proxy/...`）。

**③ `/api/accounts` 的字段形状**（`server.js:531`）

```json
{
  "accounts":    [ ...mergeAccounts(...) → buildRow() 展开，见下 ... ],
  "histories":   { "<email>": [ { "ts": "...", "points": 855, "gained": 5, "durationSec": 42 } ] },
  "historyDays": 365,
  "apiError":    null,
  "failures":    { "failed": 1, "buckets": [ ... ], "unclassified": [ ... ] }
}
```

- `accounts[]` 的**权威清单是 `lib/accounts.js` 的 `buildRow()`**（不是 store 的 SELECT），分四组：
  身份（`key/email/index/configured/observed`）、配置（`geoLocale/langCode/hasTotp/
  hasRecoveryEmail/proxy`）、控制 API 内存统计（`apiRuns/apiTotalCollected/successStreak/
  apiLastRunAt/apiLastCollected/apiLastSuccess`）、面板自己观察到的（`status/userName/
  lastStartAt/lastEndAt/lastGained/lastPoints/lastDurationSec/lastError/streak*/totalTasks/
  completedTasks`），外加运行中的实时值（`liveGained/liveBalance/liveBySource/earnable/
  lastActivityAt`）和 `historyCount`。
  **API 那三个数是 null 不是 0** —— 拿不到就是"不知道"，前端三处消费方都加了 null 守卫。
- **`buildRow()` 是白名单**：store 里新增的列**不会**自动出现在 `/api/accounts` 里，
  必须在这个函数里显式写一行。同一个字段在 ② 和 ③ 里的可见性**可能不同** ——
  例如 `totalTasks`/`completedTasks` 在 ② 里有、在 ③ 里曾经没有（见 41cf1db）。
  别用 ② 的字段名去猜 ③。
- `failures` 来自 `lib/failureReasons.js` 的 `summarize()`（`server.js:572` 以 `summarizeFailures` 引入）：
  `{ failed, buckets: [{ cause, action, count, examples: [{ email, error }] }], unclassified: [{ email, error }] }`。
  判定表 `REASONS` **中英文都保留**：`cause`/`action` 是中文"人话"，`examples[].error` 是原始英文证据。

**④ 时间窗口（热力图 / 累积条，别混在一起）**

- 前端要多少天由 `public/api.js:39` 决定：`accounts(historyDays = 365)`，**默认 365**。
- `overview.js` / `accounts.js` / `diagnostics.js` / `runs.js` 都是**不传参**调用 → 拿 365 天；
  只有 `schedule.js:357` 传 `0` → 服务端 `historyDays=0` → `since=null` → **一份历史都不取**
  （调度页不需要）。
- 服务端（`server.js:549-563`）把参数夹在 `0..3650`，**参数缺失时**用 365。
- 热力图吃的是这份历史的按天分桶：`overview.js:223` → `U.bucketByDay(histories[email])`
  （`public/util.js:198`），再按 `weekKey` 排成周列。**内容上限就是这 365 天。**
- 累积条那个窗口是**另一个常量**：`charts.js:155` 的 `ACCUM_WINDOW_DAYS = 84`（约 12 周），
  在 `buildAccumBarHtml` 里按 `todayKey − 84` 截断。**84 和 365 是两回事。**

**⑤ 主题 `.ts` 怎么被浏览器加载 —— 服务端现场转译，没有构建步骤。**

- `/themes/index.js` **每次请求现生成**（`lib/themeLoader.js` 的 `generateIndexModule()`，
  `Cache-Control: no-store`）：扫 `public/themes/` 下所有 `*Theme.ts`（排除 `types.ts` 和 `index.ts`），
  默认主题排最前、其余按字母序，拼出 `import` 并导出 `themes` 数组。
  **新增一个主题文件不需要重启、也不用改 index。**
- `/themes/<名>.ts` 由 `lib/tsLite.js` 的 `transformThemeModule()` 现场转译后以
  `text/javascript` 发出（`server.js:490-507`），路径穿越用 `startsWith(THEMES_DIR)` 挡（403）。
- **转译边界（重点：超出就不 work）** 只处理五种写法 —— `import type {...}` 整行、
  `export interface X {...}`（花括号配平，所以嵌套的对象类型不会被单括号正则截断）、
  `export type X = ...` 整行、`export const NAME: TypeName =` 上的类型标注、
  以及相对导入补 `.ts`。
  **枚举、装饰器、`as` 断言、函数泛型、非 type 的 import、JSX 都不在范围内** ——
  它们会让模块直接语法报错。所以主题文件只能是"数据字面量 + 类型标注"。

**⑥ `sw.js` 的缓存策略 —— 分四种情况，同源静态是 network-first。**

| 情况 | 策略 |
|---|---|
| 导航请求（`mode === 'navigate'`） | network-first，失败回落 `/index.html` |
| 同源 `/api/*` | network，失败回落 `/index.html` |
| 跨域（CDN 的 chart.js） | **cache-first**（版本固定，回源只会更慢，CDN 抽风时更脆） |
| 同源静态资源 | **network-first**：先问网络，200 就顺手更新缓存；失败才回落缓存 |

- 缓存名 `rewards-dashboard-pwa-v7`；install 时 `skipWaiting()` + 预缓存 7 个 ASSETS；
  activate 时删掉所有旧缓存名 + `clients.claim()`。
- 同源静态是 network-first，**所以改前端不需要硬刷新**（以前是 cache-first，才必须 Ctrl+F5）；
  只有改 `sw.js` 的 `CACHE_NAME` 或 ASSETS 清单时才需要提版本号。
- **一个尖角**：`/api/*` 失败时回落的是 `/index.html` —— 离线时一次 API 调用会拿回 HTML，
  调用方 `r.json()` 会抛，而报错指向 JSON 解析、不指向网络。这是有意取舍（至少页面能打开），
  但排查时要知道。
- 另外 `API_LOG_BUFFER`（控制 API 侧）默认 **2000 行**（`scripts/api/processManager.js:24`、
  `server.js:123`，可用 `API_LOG_BUFFER` 调）。面板启动时向 SSE 要 `LOG_REPLAY`（默认 20000）行，
  但上游只留得住 2000 —— **所以面板重启只能靠回放补上缓冲区尾部覆盖到的那几个账号**，
  不是全部。

### 7.2 仍未核实（这些别当事实用）

1. **面板那两格在浏览器里的实际显示。** 值已经确认能到达 `/api/accounts`
   （36 个字段、含 `totalTasks`），但**页面上的渲染我没有看过** —— 需要人眼或截图确认。
2. **`81e7d48` 那处登录改动** —— 只在"点击报失败、但挑战确实出现"时才触发，
   到 2026-10-13 为止**一次都没被真实触发过**。
3. **`activity` 表的裁剪阈值数值** —— 知道有 `MAX_ACTIVITY_ROWS` / `MAX_GENERIC_ROWS`
   两个上限和对应的 `prune*` 语句，但没读这两个常量的具体数字。
4. **`/api/summary` 的 `accounts` / `runs` / `activity` 三个字段前端是否都在用** ——
   `overview.js:575-578` 同时取了 `summary` 和 `accounts` 两个接口，值得确认有没有重复取数。

---

## 8. 界面改动的硬约束（改了会静默弄坏）

**完整版：`dashboard/docs/designer-guardrails.md`**，
配套检查脚本 `rewards-dashboard/tools/check-frontend.mjs`。摘要：

| 不要动 | 会怎样 |
|---|---|
| `data-tab` / `data-path` / `data-cron` / `data-*-delete` 等属性名 | 按钮点不动、配置写错 `.env` 变量，**不报错** |
| `zh-cn.js` 里的 key（或改 key 不同步字典） | 界面露出英文 |
| `U.escapeHtml` / `escapeAttr` | XSS 与页面错乱 |
| 模块导入形式（`import * as U` ↔ 具名）而不同步改用法 | `ReferenceError: U is not defined`，**只在渲染那一步炸**，并被外层 catch 显示成"刷新失败" |
| 用浏览器本地日期（`getDay` / `setDate` / `toLocaleDateString`）算日期键 | 浏览器不在 +8 时热力图整张网格偏一格 |
| 窄屏隐藏规则改成整块 `display:none` | 统计带被一起藏掉（只该藏 `.accum-track`） |

改完必须：**刷新页面**（`F5` 就够，见 7.1⑥）→ `node tools/check-frontend.mjs`（有 ❌ 先修）→ F12 无红字 →
把「时间线 ↔ 热力图」「账号删除二次确认」「配置页保存」这几条交互各点一遍。

## 9. 给设计者的最短上手路径

1. 起面板：在 `dashboard/rewards-dashboard/` 下跑 `node server.js`。
   **它不读 `.env`，只读 `process.env`** —— 必须在启动它的那个 shell 里先设好，否则会
   静默回落到 docker 默认值：

   | 变量 | 值 | 不设的后果 |
   |---|---|---|
   | `CONTROL_API_URL` | `http://127.0.0.1:3010` | 回落到 `http://microsoft-rewards-script:3010`，连不上 |
   | `CONTROL_API_TOKEN` | bot `.env` 里的 `API_TOKEN` | 日志报 `(no token)` + `CONTROL_API_TOKEN is empty` |
   | `BOT_ENV_PATH` | bot 的 `.env` 路径 | 日志报 `Account editing: disabled`，配置页存不了 |
   | `TZ` | `Asia/Shanghai` | 日期键按 UTC 切，热力图偏一天 |
   | `LOG_DIR` | bot 的 `logs/` | 启动补录找不到日志 |

   好认的症状：启动日志里 `Control API: ... (token set)` 和
   `Account editing: enabled -> ...` 这两行才对。**改了 `lib/` 必须重启面板**；
   只改 `public/` 下的前端文件不用重启（同源静态是 network-first，见 7.1⑥）。
2. 打开 `public/index.html` 的结构，读 `public/app.js` 的路由，找到视图挂载点。
   要知道「照着什么设计」（设计令牌、断点、DOM 契约、主题格式、组件清单），
   看 `designer-handbook.md` —— 本份讲接线，那份讲设计面。
3. 要改哪一页，就只改 `public/views/<那一页>.js` + `public/style.css` + `public/zh-cn.js`。
4. 数字不够用，就按第 6 节的六层顺序往上加，别跳过 `lib/parser.js`、`lib/store.js`，
   和 `lib/accounts.js` 的 `buildRow()`（白名单，最容易漏的一层）。
5. **每次改完刷新一遍**（同源静态是 network-first，普通刷新即生效；见 7.1⑥）。
6. **跑一次 `node tools/check-frontend.mjs`** —— 七项静态检查，拦的都是"不报错、
   只在特定交互下才坏"的问题。它不做构建，只读文件，几秒钟；有 ❌ 会以非 0 退出。
   其中 **[6] id 契约 / [7] data-* 契约** 直接对应第 8 节里那两行钩子硬约束 ——
   这两项是"文档写建议、检查做强制"的落地。
