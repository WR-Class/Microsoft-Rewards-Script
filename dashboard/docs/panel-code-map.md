# 面板代码地图（前端 ↔ 后端接线）

给要重做仪表盘设计的人看的。**先看第 0 节，否则会对着错的后端设计。**

本文档里每一个端点都对着源码里的路由表核过，每一个路径都确认存在。
**没核实的部分集中在第 7 节**，那里是我的盲区，不要当成事实。

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

1. **面板不是直连机器人的。** 中间永远隔着控制 API。前端只认识 `/api/*`。
2. **前端没有构建步骤。** `public/` 下的 `.js` 原样被浏览器加载（ESM `import`），
   改完刷新即生效，没有 webpack/vite。`sw.js` 是 service worker（有缓存，注意强刷）。
3. **日志是唯一事实源。** 几乎所有数字最终都能追到 `logs/*.log` 的某一行。

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
| `apiClient.js` | 控制 API 的 HTTP 客户端。面板 server 里所有 `client.get("/status")` 都走它 |
| `parser.js` | **日志行解析**（把一行日志变成结构化字段；`REACT-PARSE`、`PUNCHCARD` 等 case 在这） |
| `store.js` | `Store` 类，SQLite 读写与聚合（账号 / 运行 / 历史 / 事件）。面板的数据面 |
| `eventHub.js` | SSE 扇出：把新事件推给所有打开的浏览器 |
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
| `sw.js` | service worker（**有缓存，改完前端记得强刷**） |

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
// L223  算出所有账号里的最大增益，作为条形图的统一标尺
const globalMax = bucketed.length ? ... : 0;
// L227  按账号 key 索引出「每天」的数组
const daysByKey = Object.fromEntries(bucketed.map((b) => [b.key, b.days]));

// L238  每个账号渲染一行
container.innerHTML = accounts.map((a) => {
    const days = daysByKey[a.key] || null;

    // L253  ← 截图里那排小条形就是这一行
    barCell = `<div class="accum-track"><div class="accum-bar">${buildAccumBarHtml(days, globalMax, isMobile ? 7 : null)}</div></div>`;

    // L258  ← 当天获得积分【已经算好了】，只是现在没显示
    const todayGained = days?.find((d) => d.dayKey === todayKey)?.gained ?? null;
    ...
});
```

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

你（用户）要的四个数字，现状：

| 想要的 | 数据现在有没有 | 从哪来 |
|---|---|---|
| **每日获得积分数** | **已经有** | `overview.js` L258 的 `todayGained`，来自 `/api/accounts` 的 `days[].gained` |
| **总积分** | 有数据，但没进这一块 | 控制 API 的 `GET /points`；面板侧需要经 `server.js` 代理或由 `store` 落库 |
| **总任务量** | **没有** | 日志 `[REACT-PARSE] 任务列表 \| 父任务=N \| 未完成=N`，需要新增解析 |
| **已完成任务** | **没有** | 同上，`父任务 − 未完成` |

### 加一个字段的固定动作（五层，缺一层就不显示）

1. **解析** — `lib/parser.js`：在对应 tag 的 case 里从 `message` 抽数字。
   参考 `REACT-PARSE` 分支（L221 附近，目前只分类不抽数）。
2. **入库/聚合** — `lib/store.js`：加列或加聚合，按 `(账号, 轮次/日期)` 归集。
3. **出接口** — `dashboard/rewards-dashboard/server.js`：在 `/api/accounts`
   或 `/api/summary` 的响应里带上新字段（若数据在控制 API，则先在
   `scripts/api/server.js` 加端点，再由 `lib/apiClient.js` 取）。
4. **进前端** — `public/views/overview.js`：从 `a`（账号对象）或 `days` 里读出来。
5. **文案** — 代码里写英文 key，`public/zh-cn.js` 里加中文映射。

### 这一块的设计意图（用户原话整理）

现在每一行只放了一个小条形图（`buildAccumBarHtml`），**整行大面积留白，很浪费**。
希望改成一行里同时看到：

- **总积分**（当前余额）
- **每日获得积分数**（趋势）
- **任务数：总任务 / 已完成任务**

目标是「一目了然」，而不是需要点进去才知道。

---

## 7. 我没核实的地方（别当事实用）

1. **面板的历史数据到底是自己解析日志，还是走控制 API 的 `/history`。**
   两边都有证据：`server.js` 里有 `client.get("/history?limit=…")`，
   同时面板又自带 `lib/parser.js`。**我的判断是**：历史走 `/history`，
   `lib/parser.js` 用于实时流（`/api/events`），但**我没有逐行追完**。
   设计前建议让工程师确认这一条。
2. **`/api/summary` 与 `/api/accounts` 的完整字段形状。** 我只确认了
   `accounts[].key/email/status` 和 `days[].dayKey/gained`，没读完 `store.js` 的聚合。
3. **`days[]` 的时间窗口与分桶规则**（几天？按哪个时区切天？）。
   `overview.js` 用了 `U.tzDayKey()`，说明按本地时区切，但窗口长度没核。
4. **主题 `.ts` 如何被浏览器加载**（`tsLite.js` 的转译边界没看）。
5. **`sw.js` 的缓存策略** —— 我只知道它有缓存，不知道是 cache-first 还是 network-first。

---

## 8. 给设计者的最短上手路径

1. 起面板：`node server.js`（在 `dashboard/rewards-dashboard/`，读同目录 `.env`）。
2. 打开 `public/index.html` 的结构，读 `public/app.js` 的路由，找到视图挂载点。
3. 要改哪一页，就只改 `public/views/<那一页>.js` + `public/style.css` + `public/zh-cn.js`。
4. 数字不够用，就按第 6 节的五层顺序往上加，别跳过 `lib/parser.js` 和 `lib/store.js`。
5. **每次改完强刷**（`sw.js` 会缓存）。
