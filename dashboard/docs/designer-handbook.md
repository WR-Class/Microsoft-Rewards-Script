# 面板设计手册

**这份手册和 `designer-guardrails.md` 分工不同，别混用：**

| 文档 | 回答的问题 | 什么时候看 |
|---|---|---|
| `designer-guardrails.md` | 改了会不会弄坏代码？ | 动手前 / 被检查器拦住时 |
| **本手册** | 照着什么设计？有什么可用的？ | 设计时随手查 |

本手册里每个数字都是从代码里数出来的，不是估的。数错了比没有更糟 —— 所以
第 7 节把**三处已确认的不一致**单独列出来，不要当它们是笔误。

---

## 0. 你只会碰这三个文件

| 文件 | 规模 | 你在这里改什么 |
|---|---|---|
| `public/style.css` | 2708 行 | **所有样式**。这是你 90% 的时间所在 |
| `public/views/<某一页>.js` | 227 ~ 1105 行 | 那一页的 HTML 结构（都是 JS 模板字符串） |
| `public/zh-cn.js` | — | 新文案的中文（key = 英文原文） |

**不要碰**：`index.html`（骨架 + 24 个 id 的归属）、`public/app.js`（路由）、
`public/sw.js`、`public/themeManager.js`、`lib/` 和 `scripts/`。理由见 guardrails 第 6 节。

改完**不需要构建**：同源静态资源是 network-first，`F5` 就生效（`lib/` 改动才要重启面板）。

---

## 1. 设计令牌：24 个，全在 `style.css:5-41` 的 `:root` 里

**只用这些变量，不要写死颜色。** 写死的颜色在暗色模式和主题调色板下都不会变。

### 1.1 基础色（13 个） —— 也是主题的 `light` 调色板

| 令牌 | 值（亮色） | 用途 | 被引次数 |
|---|---|---|---|
| `--canvas` | `#ffffff` | 页面底色 | 4 |
| `--surface` | `#fafbfb` | 卡片、抬升面（**用得最多**） | 21 |
| `--surface-alt` | `#f6f7f8` | 次级面：表单字段、代码块 | 15 |
| `--hover` | `#e8ebed` | 交互悬停的底色 | 12 |
| `--text` | `#24292d` | 正文 | 26 |
| `--text-muted` | `#434a51` | 次要文字、说明、标签 | 44 |
| `--text-inverse` | `#ffffff` | **强调色背景上的**文字 | 5 |
| `--border` | `#d7dcdf` | 常规描边 | 43 |
| `--border-strong` | `#b6bec3` | 需要更明显的描边 | 3 |
| `--accent` | `#3882c2` | 主强调色：链接、主按钮、选中 | 29 |
| `--accent-hover` | `#1f639e` | 强调色的悬停/按下态 | 7 |
| `--accent-subtle` | `#e0e7f1` | 选中态的淡背景 | 2 |
| `--focus` | `#65a4d7` | 键盘焦点环 | 1 |

### 1.2 语义色（4 个）

| 令牌 | 值（亮色） | 用途 | 被引次数 |
|---|---|---|---|
| `--positive` | `#5f7556` | 收益、成功 | 8 |
| `--negative` | `#e67c7c` | 支出、危险、错误 | 17 |
| `--warning` | `#7D4E00` | 警告（**见 7.1，这个值和主题不一致**） | 1 |
| `--energy-high-accent` | `#9664d0` | 高能耗强调（总览的能耗条） | 3 |

### 1.3 布局（3 个）

| 令牌 | 值 | 用途 | 被引次数 |
|---|---|---|---|
| `--radius` | `12px` | **全局圆角就这一个值**，改它等于全站改圆角 | 4 |
| `--shadow` | `0 1px 2px rgba(20, 22, 30, 0.06), 0 1px 1px rgba(20, 22, 30, 0.04)` | 卡片阴影 | 4 |
| `--mono` | `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace` | 等宽文字：日志、cron、配置编辑器 | 7 |

### 1.4 派生色（4 个） —— **不要改，它们是从上面算出来的**

| 令牌 | 值 | 用途 | 被引次数 |
|---|---|---|---|
| `--positive-bg` | `color-mix(in srgb, var(--positive) 16%, var(--surface))` | 收益的淡底 | 5 |
| `--negative-bg` | `color-mix(in srgb, var(--negative) 16%, var(--surface))` | 支出的淡底 | 6 |
| `--amber` | `var(--warning)` | 警告色的别名 | 16 |
| `--amber-bg` | `color-mix(in srgb, var(--amber) 14%, var(--surface))` | 警告的淡底 | 8 |

想换警告色就改 `--warning`，`--amber` 和 `--amber-bg` 会自动跟着变。

**合计 291 次 `var()` 引用** —— 也就是说全站样式全靠这 24 个值撑着。改一个令牌的影响面
基本等于"全站"。

### 1.5 主题会覆盖其中 18 个

被主题覆盖（见第 4 节）：1.1 的 13 个 + `--positive` `--negative` `--warning`
`--energy-high-accent` + `--shadow`。**共 18 个。**

**只由 `:root` 决定、主题动不了的 6 个**：`--radius`、`--mono`、`--positive-bg`、
`--negative-bg`、`--amber`、`--amber-bg`。

---

## 2. 响应式：8 个条件，20 个媒体查询块

`style.css` 里 `@media` 一共 **20 块**，分布在 **8 种条件**上。

| 条件 | 块数 | 它改什么 |
|---|---|---|
| `(max-width: 768px)` | **10** | 主移动断点：顶栏折行、标签栏、控制条、统计卡改单列、英雄面板、日志框、账号行、开关网格、ticker、运行进度 |
| `(max-width: 420px)` | 3 | 小屏细节：登录码字号、英雄面板积分列、日志标签/时间/正文 |
| `(pointer: coarse)` | 2 | 触屏：`link-btn`/`btn`/`btn-small`/图标按钮/主题选择/登录码卡片 → **加大点击目标** |
| `(prefers-color-scheme: dark)` | 1 | `:root` 的 18 个令牌换成暗色值 |
| `(prefers-reduced-motion: reduce)` | 1 | `*` 关掉动画和过渡 |
| `(max-width: 1024px)` | 1 | `.stat-grid` 列数 |
| `(min-width: 769px) and (max-width: 1024px)` | 1 | 平板：英雄面板积分列 |
| `(max-width: 600px)` | 1 | 登录码列表和卡片 |

### 2.1 三条你必须知道的规则

**① 全部 `@media` 都在第六段（`style.css:2294-2708`，见第 6 节）。**
文件是「令牌 → 全局/重置 → 应用外壳 → 共享组件 → 各页 → 响应式」六段。所以你在 L1200
给某个元素写的样式，可能被 L2600 的同名规则盖掉。**改窄屏表现，去第六段找，不要在组件那一节加。**

**② `padding` 别在 `max-width: 768px` 里重复实现一遍。**
窄屏下组件容器的 padding 由 `style.css:2346` 的「Panel & table density (shared)」统一接管。

**③ 窄屏藏的是"趋势条形"，不是统计带。**
`style.css:2514` 只隐藏 `.hero-bar-cell .accum-track`（那排小条形图），
`.hero-bar-cell` 里的**数字要保留**。早先那条规则是整块 `display:none`，会把数字一起藏掉。

---

## 3. DOM 契约：JS 靠什么找元素

这一类东西**重命名不会报错**，只是功能悄悄没了。完整的"会怎么坏"见 guardrails 2.1；
这里是清单。

### 3.1 `id` —— 24 个写在 `index.html` 里，其中 22 个被 JS 抓

`U.$()` 找不到元素时**只返回 null**，紧接着赋值就抛 `Cannot read properties of null`。
**实测 22 处 `U.$("#..")` 全部没有 null 守卫** —— 改一个就够把面板打挂。

```
顶栏/状态   statusBadge  statusText  modeToggle  modeIcon  themeSelect
标签栏      tabBar       tabPanels
控制条      ctlPill      ctlDetail   btnStart  btnStop  btnRestart  btnMore
            ctlMenu      btnForceStop btnShutdown
登录码      loginCodesSection  loginCodesList  loginCodesAnnounce
页脚        footerVersion  footerScriptVersion  footerStatus
```

另外两个不是 JS 抓的，但被引用，**同样不能改名**：`main`（跳转链接 `href="#main"`）、
`login-codes-heading`（`aria-labelledby`）。

**不止 `index.html`**：全项目共 **102 个 id** 被引用（JS 选择器 / CSS 的 id 选择器 /
HTML 的 `href="#…"` 和 `aria-*`），其余由各视图模板自己生成 —— 改视图里的 HTML 一样会踩。

### 3.2 `data-*` —— JS 读 23 个

`data-tab`（标签切换）、`data-cron`（调度快捷按钮）、`data-path`（配置字段路径）、
`data-target`（调度 local/remote）、`data-arm-delete` / `data-confirm-delete` /
`data-cancel-delete`（删除二次确认）、`data-toggle-details`、`data-diag`、
`data-clear-session`、`data-tag-remove`、`data-view`、`data-theme-id`、`data-theme-mode`、
`data-days`、`data-exclude-account`、`data-run-account`、`data-select-account`、
`data-manage-edit`、`data-manage-remove`、`data-numeric`、`data-trend`、`data-tags-path`、
`data-exit`、`data-no-i18n`。

**`index.html` 里一个 `data-*` 都没有 —— 全部由视图模板生成。** 所以改视图模板里的
属性名同样危险。`data-no-i18n` 是唯一"被读但没人写"的：它是 `zh-cn.js` 的逃生舱
（标了就不翻译），有意预留、目前无人使用。

### 3.3 class 分两种，一种是样式、一种是钩子

`data-*` 之外的钩子也藏在 class 里。**改 class 名前先在 `public/` 里搜一遍**，
出现在 `.js` 里就不是纯样式 class。

自动化把关：`tools/check-frontend.mjs` 的 **[6] id 契约** 和 **[7] data-* 契约**
就是查这两类，改完跑一次就会被点出来（[6] 会让脚本以非 0 退出）。

---

## 4. 主题：现剩一套控制台主题，加一个不用重启

### 4.1 文件长什么样

`public/themes/` 下现在只有 **1 个主题** `consoleTheme.ts`（2026-10 按用户要求把原来的
13 套精简成 1 套，主题下拉框隐藏，只留顶栏明暗切换），外加 `types.ts`。
每个文件导出一个 `ThemeDefinition`：

```ts
export const consoleTheme: ThemeDefinition = {
  id: 'console',
  name: 'Console',
  palettes: {
    light: { /* ThemePalette */ },
    dark:  { /* ThemePalette */ },
  },
}
```

`ThemePalette` 有 **25 个键**（`public/themes/types.ts`）：1.1 那 13 个、
`positive`/`negative`/`warning`、以及 9 个 energy 键
（`energyLowBg/Accent/Text`、`energyMedium…`、`energyHigh…`）。

### 4.2 只有 18 个键真的会被应用

`themeManager.js` 里的映射表把 palette 的键写成 CSS 变量，**只映射 18 个**：
1.1 的 13 个 + `positive` `negative` `warning` + `energyHighAccent` + `energyHighBg`。

**剩下 7 个 energy 键（low/medium 各 3 个，加 `energyHighText`）定义了但没有效果** ——
`types.ts` 里也写了 "silently ignored by budget themeManager"。

### 4.3 加一个主题

1. 复制 `public/themes/consoleTheme.ts`，新文件名**必须以 `Theme.ts` 结尾**，改 `id` 和 `name`。
2. 文件里保持这个形状 —— **加载器靠正则从这个形状里取标识符**：

   ```ts
   export const yourTheme: ThemeDefinition = {
     id: 'your', name: 'Your', palettes: { light: { … }, dark: { … } },
   }
   ```

   `lib/themeLoader.js` 的 `extractExportName()` 用 `/export\s+const\s+(\w+)\s*[:=]/`
   把名字抠出来，再生成 `import { yourTheme } from './yourTheme.ts'`。

   **注意：不是 `export default`。** 现存的 `consoleTheme.ts` 就是上面这种具名常量
   导出，照它抄就行。
3. **不用改任何清单**：主题是扫描目录发现的（`*Theme.ts`），`types.ts` 和 `index.ts` 被忽略。
4. 刷新页面即可 —— `/themes/index.js` 由 `server.js:879` 现生成，
   响应头 `Cache-Control: no-store`（实测确认）。**不用重启面板。**

### 4.4 转译边界（写错了会整个主题加载失败）

`.ts` 是浏览器现场转译的（`lib/tsLite.js`），它**只认这几样**：

- ✅ `import type {...}`、`export interface X {...}`、`export type X = ...`、
  `export const` 上的 `: TypeName`、省略扩展名的相对导入
- ❌ **枚举、装饰器、`as` 断言、函数泛型、非 type 的 `import`、JSX**

写新主题时**只写对象字面量**，就不会碰到边界。

---

## 5. 组件清单：7 页 + 29 个共享类

### 5.1 七个页面

| 页面 | 视图文件 | 行数 | 自用 class | 定义的 id | 样式在 |
|---|---|---|---|---|---|
| 总览 | `views/overview.js` | 603 | 56 | 20 | `style.css:1111` |
| 账号 | `views/accounts.js` | 797 | 41 | 15 | `style.css:1677` |
| 配置 | `views/config.js` | 1105 | 37 | 12 | `style.css:2035` |
| 运行记录 | `views/runs.js` | 227 | 27 | 8 | `style.css:1936` |
| 诊断 | `views/diagnostics.js` | 249 | 26 | 6 | `style.css:2198` |
| 调度 | `views/schedule.js` | 378 | 23 | 26 | `style.css:1987` |
| 日志 | `views/logs.js` | 239 | 18 | 10 | `style.css:1847` |

**"样式在"那一列就是你要找的那一节。** 每页在 `style.css` 里都有独立的分节注释。

### 5.2 共享词汇表：29 个类被两页以上用到

**改这 29 个等于同时改多页。** 全是已定义的（都有 CSS 规则）。

| 用到它的页数 | 类 |
|---|---|
| 7 页（全部） | `panel`、`panel-head`、`empty-note` |
| 6 页 | `panel-sub` |
| 5 页 | `btn`、`notice`、`notice--warn` |
| 4 页 | `btn-primary`、`check`、`field`、`input` |
| 3 页 | `btn-small`、`tag-mini`、`form-actions`、`seg`、`seg-btn--active` |
| 2 页 | `kv`、`acc-detail-group`、`acc-detail-group-title`、`btn-danger`、`hint`、`form`、`field-grid`、`field-item`、`field-hint`、`exit-chevron`、`visually-hidden`、`chart-wrap`、`seg-btn` |

另外 **129 个类只被一页用到**，动它们的影响面就是那一页。

### 5.3 共享组件的样式位置

| 组件 | 样式在 | 谁在用 |
|---|---|---|
| 面板/卡片容器 | `style.css:607` | 全部 7 页 |
| 提示条 `notice` | `style.css:648` | 5 页 |
| 按钮 `.btn` 家族 | `style.css:690` | 5 页 |
| 表单与输入 `.field`/`.input` | `style.css:749` | 4 页 |
| 分段控件 `.seg` | `style.css:838` | 3 页 |
| 表格 | `style.css:875` | 总览、账号、运行记录 |
| 空状态 `.empty-note` | `style.css:913` | 全部 7 页 |
| 键值网格 `.kv` | `style.css:920` | 账号、调度 |
| 进度条 | `style.css:946` | 总览 |
| 内联 SVG 图表 | `style.css:963` | 总览、运行记录 |
| 可展开列表项 | `style.css:1030` | 账号、诊断、运行记录 |

改 `.btn` 之前想一下：5 个页面同时在用。

---

## 6. `style.css` 的地图

2708 行，**六个编号大段**。文件里的编号注释（`1. TOKENS / VARIABLES` 这种）就是权威边界：

| 行范围 | 段 | 内容 |
|---|---|---|
| `2-44` | `1. TOKENS / VARIABLES` | `:root` 的 24 个令牌 + `color-scheme` |
| `45-123` | `2. GLOBAL / RESET` | reset、`main` 布局、tab panel 容器 |
| `124-514` | `3. APP SHELL` | 顶栏、标签栏、控制条、toast、登录提示、页脚 |
| `515-1107` | `4. SHARED COMPONENTS` | 按钮、表单、表格、提示条、面板容器……（见 5.3） |
| `1108-2293` | `5. PAGE-SPECIFIC SECTIONS` | 每页一节，按页面顺序（见 5.1） |
| `2294-2708` | `6. RESPONSIVE` | **全部 20 个 `@media` 都在这一段** |

**顺序是有意义的**：后面的覆盖前面的。而且因为 `@media` 全在第六段，所以
**第六段里的任何规则都能盖掉前面五段**。

**一个容易搞错的地方**：暗色模式令牌（`L2297`）和全局共享组件的响应式部分（`L2322` 起）
都在**第六段里**，不在它们名字听起来该在的段落 —— 因为暗色模式本身就是个媒体查询。

窄屏（`max-width`）规则集中在 `L2467` 之后；`2294-2466` 那部分放的是
`prefers-color-scheme`、`prefers-reduced-motion`、`pointer: coarse` 三类。

六段内部另有 70 条分节注释（`/* Overview */`、`/* Buttons */` 这种），`grep` 一下就能定位：

```powershell
Select-String -Path public\style.css -Pattern '^\s*/\*\s*\S' -Encoding UTF8
```

---

## 7. 已知不一致（7.1 已随重做修复，其余别当笔误）

### 7.1 `--warning` 已和 `consoleTheme` 对齐（旧漂移已修复）

旧档：`style.css` 的 `:root` 写 `--warning: #7D4E00`，而 `defaultTheme` light 是 `#8A4B00`。
2026-10 重做后 `:root` 改成 `--warning: var(--warn)`，且 `--warn` 的亮/暗两个值
（`#A16207` / `#FBBF24`）与 `consoleTheme` 的 light/dark `warning` **完全一致** ——
这条不再是漂移。主题加载前后都走同一组值。

### 7.2 `--energy-high-bg` 被用，但 `:root` 里没有

```
style.css:542   background: var(--energy-high-bg);
style.css:1250  background: var(--energy-high-bg);
```

它只由 `themeManager` 写入（`energyHighBg`）。也就是说**只有主题加载成功后它才存在**；
如果主题加载失败，这两条声明会因为值无效被浏览器丢弃 —— 不会报错，那一块就是没背景。

对比 `--ticker-duration`（`style.css:2503`）的写法：它用了兜底
`var(--ticker-duration, 14s)`，所以即使没人设也有值。**这是两种写法，前者是漏的。**

### 7.3 `themeManager` 只映射 18 个 palette 键，另外 7 个是空转

见 4.2。在主题文件里改 `energyLowBg` 之类**不会有任何视觉效果**。

---

## 8. 最短上手路径

1. 想改哪一页 → 查 5.1 拿到视图文件和 `style.css` 的节号。
2. 要颜色/圆角 → 查第 1 节，**只用令牌**。
3. 要新文案 → 中文进 `public/zh-cn.js`，key 是英文原文。
4. 改窄屏 → 直接去 `style.css:2467` 之后，不要在组件那节加。
5. 动手前扫一眼第 3 节，确认你没在改钩子。
6. 改完 **`F5`**（不用硬刷新），然后跑：

   ```powershell
   node tools/check-frontend.mjs
   ```

   七项检查，有 ❌ 就是必须修 —— 它会以非 0 退出，可以卡在提交前。
