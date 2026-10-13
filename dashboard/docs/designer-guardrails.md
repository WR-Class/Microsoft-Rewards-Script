# 让设计师改界面而不弄坏代码

> **配套文档**：`designer-handbook.md`（设计手册）。
> 那份回答「照着什么设计、有什么可用」，本份回答「怎么改不会坏」。
> **设计时查手册，动手前查本份。**

给"重做页面元素/视觉"这件事定的规矩。配套脚本：`rewards-dashboard/tools/check-frontend.mjs`。

**一句话**：设计师可以自由改**观感**（颜色、间距、字体、阴影、圆角、动效、布局比例），
不能改**接线**（JS 用来找元素的钩子、文案 key、转义、时区、模块导入形式）。

改坏了的典型症状是**静默的**：不报错、不抛异常，只是某个按钮点不动、某张图不渲染、
某个日期差一格。所以下面每一条都不是"风格建议"，是"改了就要出事"。

---

## 1. 可以随便改的

| 区域 | 文件 |
|---|---|
| 全部样式 | `rewards-dashboard/public/style.css` |
| 颜色变量 / 主题色 | `public/themes/*.ts` + `public/themeManager.js` |
| 页面骨架的**视觉分组** | `public/index.html`（改结构要读第 3 节） |
| 图表配色与尺寸 | `public/charts.js` 里的样式常量（不要动取数与键运算，见第 4 节） |
| 新增纯装饰元素 | 自己起的 class 名 + `style.css` 里定义，不与已有 class 冲突即可 |

## 2. 绝对不能改的（改了会静默失效）

### 2.1 JS 用来找元素的钩子

两类东西，**重命名都不会报错**，只是功能悄悄没了。

**① `id`** —— 有 **22 个 id** 被 `U.$("#...")` 抓取，**全部没有 null 守卫**：

```
statusBadge   statusText    modeToggle    modeIcon      themeSelect   tabBar
ctlPill       ctlDetail     btnStart      btnStop       btnRestart    btnMore
ctlMenu       btnForceStop  btnShutdown   tabPanels     footerVersion footerStatus
footerScriptVersion   loginCodesSection   loginCodesList   loginCodesAnnounce
```

这 22 个都写在 `index.html` 里。另外 `main` 和 `login-codes-heading` 不是 JS 抓的，
但分别被跳转链接 `href="#main"` 和 `aria-labelledby` 引用，**同样不能改名**。

为什么危险：`U.$()` 找不到元素时**只返回 `null`**，紧接着
`els.statusText.textContent = ...` 就抛 `Cannot read properties of null`，面板整个挂掉。

**② `data-*` 属性** —— 用它做选择器和事件绑定：

```
data-tab            顶部标签切换
data-cron           调度页的定时表达式快捷按钮
data-path           配置页的字段路径（读写 .env 靠它）
data-target         调度页的 local/remote 切换
data-arm-delete / data-confirm-delete / data-cancel-delete    账号删除的二次确认
data-toggle-details / data-diag / data-clear-session / data-tag-remove
```

**注意：`index.html` 里一个 `data-*` 都没有** —— 全部由视图模板生成。
所以这些属性是写在 `public/views/*.js` 的 HTML 模板里的，改那些模板一样会踩。

同一个 class 名可能既是样式钩子又是 JS 钩子。**想改名前先在整个 `public/` 里搜一遍**，
出现在 `.js` 里的就不是纯样式 class：

```powershell
Select-String -Path public\**\*.js -Pattern 'data-confirm-delete'
```

**别靠自觉**：这两类都由 `tools/check-frontend.mjs` 的 [6] / [7] 检查。
改完跑一次就会被点出来（[6] 会让脚本以非 0 退出，卡住提交）。

### 2.2 文案必须走 i18n key

界面上所有可见文字都是**英文 key 写在代码里**，中文在 `public/zh-cn.js` 里映射：

```js
// public/zh-cn.js
"Accounts in error now": "当前出错的账户",
```

- 新加文案 → 代码里写英文 key + `zh-cn.js` 里加中文，**两处都要**，否则露出英文 key。
- 改 key 名 → 必须同步改字典，否则同样露英文。
- **不要**把中文直接写进视图代码或 HTML。

### 2.3 `escapeHtml` / `escapeAttr` 不能删

邮箱、错误信息、日志行都是用户可控内容。去掉转义不只是显示错乱，是 XSS。
凡是把变量插进 HTML 模板串的地方，都要经过 `U.escapeHtml(...)` 或 `U.escapeAttr(...)`。

### 2.4 每个前端模块的导入形式不同

有两种写法，**不能混**：

```js
import * as U from "../util.js";                    // 然后写 U.tzDayKey(...)
import { escapeHtml, tzDayKey } from "./util.js";   // 然后写 tzDayKey(...)
```

用了 `U.` 却没 `import * as U` → 抛 `ReferenceError: U is not defined`。

**这个错误只在渲染那一步才炸**，而且会被外层 `catch` 吞掉，面板上显示成
「xxx 刷新失败：U is not defined」—— 整块内容渲染不出来，但控制台不一定显眼。
本仓库真实发生过一次：热力图渲染崩了，原因是 `charts.js` 里写了 `U.tzDayKey`。

`tools/check-frontend.mjs` 会静态拦这一类（先剥注释再扫，避免被说明文字误报）。

### 2.5 日期一律走面板时区

面板的 `TZ` 是 `Asia/Shanghai`，历史里的 `ts` 是 UTC。**日期键必须用 `U.tzDayKey()`**。

不要用浏览器本地日期：

```js
new Date(...).getDay() / getMonth()        // ✗ 浏览器本地
new Date(key + "T12:00:00").setDate(...)   // ✗ 本地日历
toLocaleDateString()                       // ✗ 本地时区
```

浏览器不在 +8 时，热力图整张网格会**偏一格**，月份标签还会和格子对不上。
（实测：America/New_York、Pacific/Midway 会偏一格；Asia/Shanghai、UTC 正常。）

日期的加减要用**纯 UTC 的键运算**（`YYYY-MM-DD` 直接算），不要绕回 `Date` 的本地日历。
`charts.js` 里已有 `keyAddDays` / `keyDayOfWeek` 可复用。

### 2.6 空值必须显示占位，不能直接算

上游在"基线未知"时会送 `null` 而不是数字。所以：

```js
a.completedTasks != null ? U.fmtNumber(a.completedTasks) : "\u2013"   // ✓
U.fmtNumber(a.completedTasks)                                        // ✗ 会渲染成 0 或 NaN
```

数字一律经 `U.fmtNumber` / `U.fmtSigned`，保证千分位和正负号一致。

### 2.7 服务工人（service worker）缓存

`public/sw.js` 分四种情况，**同源静态资源是 network-first**：先问网络，成功就顺手更新缓存，
失败才回落缓存。所以**改完前端按 F5 刷新就够，不需要硬刷新**（以前是 cache-first，才必须 Ctrl+F5）。

跨域的 CDN 资源（chart.js）是 **cache-first** —— 它的版本固定在 `sw.js` 的 `ASSETS` 清单里，
不跟着你的改动变。只有**改动 `sw.js` 自己的 `CACHE_NAME` 或 `ASSETS` 清单**时，才需要提版本号。

## 3. 改 `index.html` 结构时要看的

`app.js` 负责启动和路由，它把上下文 `ctx` 传给各视图，并按 `data-tab` 挂载。
顶部的标签按钮、视图容器 id 都是它的接线点。改结构前读 `public/app.js` 的路由部分。

## 4. 改 `charts.js` 时要看的

这个文件里有两类东西，只有前一类能改：

- **可以改**：颜色、线宽、圆角、透明度、尺寸常量。
- **不要动**：取数（`d.dayKey` / `d.gained` / `d.lastTotal`）和键运算
  （`keyAddDays` / `keyDayOfWeek` / 周起点）。`lastTotal` 是标题里"总数"用的，
  手编测试数据时漏了它会抛 `TypeError: ...reading 'toLocaleString'`。

热力图的实际入口是 `buildHeatmapHtml(days)`，`days` 由 `U.bucketByDay(history)` 产出
（形状：`{ dayKey, weekKey, gained, lastTotal }`）。

## 5. 每次改完的验收流程

1. **刷新页面**（`F5` 就够；`sw.js` 对同源静态是 network-first，见 2.7）
2. 跑检查器（在 `rewards-dashboard/` 下）：

   ```powershell
   node tools/check-frontend.mjs
   ```

   输出怎么读见下面第 5.1 节。**有 ❌ 就必须先修**（脚本会以非 0 退出）。

3. 浏览器 F12 控制台**应当没有红字**。特别注意有没有 `is not defined`、
   `Cannot read properties of undefined`。
4. 逐页点一遍，重点是这几条**容易只在特定交互下炸**的路径：

   | 路径 | 为什么 |
   |---|---|
   | 时间线 → 热力图 来回切 | 热力图是独立渲染函数，只有切过去才执行 |
   | 账号删除的二次确认 | 依赖 `data-arm-delete` → `data-confirm-delete` 两步状态 |
   | 配置页保存 | 依赖 `data-path`，改错会写错 `.env` 变量 |
   | 日志页筛选 / 调度页快捷表达式 | 依赖 `data-cron` 与事件委托 |
   | 窄屏（≤768px） | 隐藏规则是按 class 精确匹配的，见下 |

### 5.1 检查器的输出怎么读

开头有一行记号说明，每一条前面都带一个记号，**不需要知道脚本内部怎么实现**：

| 记号 | 含义 | 你要做什么 |
|---|---|---|
| ❌ 必须修 | 确定是问题 | 改掉。脚本会以非 0 退出，可以卡在提交前 |
| ⚠ 看一眼 | 可能是问题，也可能是有意为之 | 看一眼，确认是哪种 |
| ℹ 仅告知 | 只是告诉你现状 | 不用管 |
| ✅ 没问题 | 这一类查过了，干净 | 不用管 |

每一节都会印**为什么查**和**怎么办**，所以不用回头翻本文档。

七个检查项：

| # | 查什么 | 会怎么坏 |
|---|---|---|
| 1 | 用了 `U.` 却没 `import * as U` | `ReferenceError`，只在渲染那一步炸，被 catch 吞成"刷新失败" |
| 2 | 用浏览器本地日历算日期键 | 浏览器不在 +8 时整列日期键偏一天 |
| 3 | `zh-cn.js` 里重复的 key | 后一条静默覆盖前一条，改了其中一条不生效 |
| 4 | `style.css` 里没人用的 class | 多半是 JS 改了名、CSS 没跟上 —— 那条样式静默失效 |
| 5 | JS 模板里没有 CSS 规则的 class | **不是错误**，分三类列出来供参考（见下） |
| 6 | 被引用的 `#id` 没人创建 | 改名后 `U.$()` 拿到 `null`，下一次赋值就 `Cannot read properties of null`（**❌ 级**） |
| 7 | JS 读了、但从没被写过的 `data-*` | 改名后读到 `undefined`，静默走默认分支，不报错 |

第 6 项和第 7 项的当前规模：**124 个 id 被引用**（`index.html` 里写死 24 个，
其余由视图模板生成），**24 个 `data-*` 被读**。这两项就是 2.1 节那两类钩子的执行版。

第 5 项为什么不是错误：这类 class 有三种来源，性质完全不同 ——

- **① JS 钩子**：JS 用 `querySelector` 之类靠它找元素，样式由同一个标签上的
  其它 class 提供（例：`tag-add-btn` 同时有 `btn btn-small`）。正常。
- **② 自带内联样式**：那个标签上就写着 `style="..."`。正常，样式在标签上。
- **③ 无任何样式**：既没有 CSS 规则，也没有 JS 用它。**目前不会有任何视觉效果** ——
  它只是语义标记。要给它们样式，就在 `style.css` 里写规则；不写也没问题。

第 4 项和第 5 项方向相反，合起来才能定位"改名漏改"：
第 4 项查"CSS 有、前端没有"（旧名字留在 CSS 里），第 5 项查"前端有、CSS 没有"
（新名字进了 JS，样式还没跟上）。

5. **窄屏**：只隐藏 `.hero-bar-cell .accum-track`（那排小条形图），**统计带要保留**。
   早先那条规则是整块 `display:none`，加统计带后会把统计带一起藏掉。

## 6. 设计师不要碰的文件

`lib/`、`server.js`、`scripts/api/` —— 那是数据面（解析日志、写 SQLite、代理控制 API）。
界面上"数字不对"绝大多数不是样式问题，而是代码地图第 6 节那六层接线断了一层，
改 CSS 永远修不好。这类问题交给维护者。

---

## 附：怎么判断"这个 class 能不能改"

```
只在 style.css 里出现            → 纯样式，随便改
也在 public/**/*.js 里出现        → JS 钩子，改名前先搜
也在 public/index.html 里出现     → 结构性钩子，慎重
```

一条命令查：

```powershell
Select-String -Path (Get-ChildItem -Recurse public -Include *.js,*.html) -Pattern 'hero-stat-strip'
```
