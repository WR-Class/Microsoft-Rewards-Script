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

1. **前端只认识 `/api/*`，但面板后端不是只走控制 API。** 实时状态走 ②（控制 API 的
   SSE）；**启动时它还会直接读 ① 的 `logs/*.log`**（`lib/logFileReplay.js`）。
   原因是 ② 的日志缓冲区只有 2000 行，而一天的日志有 6000+ 行 —— 只靠 SSE 的话，
   漏掉一条结束行，那个账号就永远停在「运行中」，**重启也救不回来**。详见第 3 节。
2. **前端没有构建步骤。** `public/` 下的 `.js` 原样被浏览器加载（ESM `import`），
   改完刷新即生效，没有 webpack/vite。`sw.js` 是 service worker（有缓存，注意强刷）。
3. **日志是唯一事实源。** 几乎所有数字最终都能追到 `logs/*.log` 的某一行。
4. **一条日志要经过四个函数才变成面板里的数字**（顺序不能错）：

   ```
   EventHub  →  hub.on("entry")  →  entryToDockerLine(entry)  →  parseLine(line)  →  store.apply(event)
   ```

   `entryToDockerLine` 会给行首补一个合成时间戳（`parseLine` 要求行首有 Docker 风格的
   时间戳）。**所以直接拿原始日志行喂 `parseLine` 会静默返回 `null`** ——
   实测 14517 行解析出 0 条事件，不报错、不抛异常。这是本项目最容易踩的坑。
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
| `parser.js` | **日志行解析**（把一行日志变成结构化字段；`REACT-PARSE`、`PUNCHCARD` 等 case 在这）。**数字字段一律同时接受 `null`**：上游在"基线未知"时会写 `null` 而不是数字，按 `\d+` 抓会整行匹配失败 |
| `store.js` | `Store` 类，SQLite 读写与聚合（账号 / 运行 / 历史 / 事件）。面板的数据面。`apply(event, { backfill })`：补录允许比水位旧，但水位只升不降 |
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
| **总任务量** | **仍然没有** | 日志 `[REACT-PARSE] 任务列表 \| 父任务=N \| 未完成=N`，**解析器还没有抽这两个数**，所以界面上显示「尚未采集」 |
| **已完成任务** | **仍然没有** | 同上，`父任务 − 未完成` |

**这四个数字现在渲染在每行左侧的一条统计带里**（`.hero-stat-strip`，四个 `.hero-stat`），
右侧仍然是原来的累积条形图。**后两个是空占位**，`title` 提示 `Not collected yet` /
中文「尚未采集」—— 设计者要做的正是把这两个补上（走下面第 6 节的五层）。

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

1. ~~**面板的历史数据到底是自己解析日志，还是走控制 API 的 `/history`。**~~
   **已核实（2026-10-12）**：两条路都在，分工明确 ——
   **实时**走 `EventHub` → `parseLine`（`lib/parser.js`）→ `store.apply`；
   **历史聚合**走控制 API 的 `GET /history`。`lib/parser.js` 是实时链路的核心，
   不是历史数据的来源。**但 `store` 里那些历史表具体由谁写满，我仍然没有逐行追完。**
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
