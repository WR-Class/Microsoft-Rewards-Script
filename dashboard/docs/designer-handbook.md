# 面板设计手册

**这份手册和 `designer-guardrails.md` 分工不同，别混用：**

| 文档 | 回答的问题 | 什么时候看 |
|---|---|---|
| `designer-guardrails.md` | 改了会不会弄坏代码？ | 动手前 / 被检查器拦住时 |
| **本手册** | 照着什么设计？有什么可用的？ | 设计时随手查 |

本手册里每个数字都是从代码里数出来的，不是估的。数错了比没有更糟 —— 所以
第 7 节把**已知的不一致**单独列出来（7.1 已随 2026-10 重做修复），不要当它们是笔误。

---

## 0. 你只会碰这三个文件

| 文件 | 规模 | 你在这里改什么 |
|---|---|---|
| `public/style.css` | 972 行 | **所有样式**。这是你 90% 的时间所在 |
| `public/views/<某一页>.js` | 255 ~ 1113 行 | 那一页的 HTML 结构（都是 JS 模板字符串） |
| `public/zh-cn.js` | — | 新文案的中文（key = 英文原文） |

**不要碰**：`index.html`（骨架 + 24 个 id 的归属）、`public/app.js`（路由）、
`public/sw.js`、`public/themeManager.js`、`lib/` 和 `scripts/`。理由见 guardrails 第 6 节。

改完**不需要构建**：同源静态资源是 network-first，`F5` 就生效（`lib/` 改动才要重启面板）。

---

## 1. 设计令牌：明暗两块，各 34 个名字

**只用这些变量，不要写死颜色。** 写死的颜色在另一个模式下都不会变。

结构（2026-10 重做后）：`:root`（= 暗色，冷蓝科技调）在 `style.css:12-38`，
`[data-theme-mode="light"]`（暖奶油调）在 `L39-63`，两块名字一一对应；
外加 `L64-66` 一个与模式无关的派生渐变 `--grad`。暗色是默认，不是媒体查询。

### 1.1 新名（25 个） —— 新代码用这些

| 令牌 | 暗色 | 浅色 | 用途 |
|---|---|---|---|
| `--bg` | `#0B0F16` | `#FAF5EE` | 页面底色 |
| `--bg2` | `#0E131C` | `#F3EBE0` | 次级页面底 |
| `--card` | `#141B28` | `#FFFFFF` | 卡片面 |
| `--card2` | `#1A2334` | `#F7F0E7` | 卡片内次级面 |
| `--soft` | `#111826` | `#FAF4EC` | 软面（内嵌块） |
| `--border` | `#233046` | `#EADFD0` | 常规描边 |
| `--border2` | `#33445F` | `#D9C9B4` | 强描边 |
| `--text` | `#E8EEF7` | `#291E12` | 正文 |
| `--dim` | `#9FAEC4` | `#756555` | 次要文字 |
| `--faint` | `#6B7A93` | `#A2917E` | 最弱文字、说明 |
| `--acc` | `#38BDF8` | `#C2410C` | 主强调色 |
| `--acc2` | `#818CF8` | `#F59E0B` | 次强调、渐变尾色 |
| `--accsoft` | rgba .14 | rgba .11 | 强调淡底 |
| `--ok` / `--oksoft` | `#34D399` | `#15803D` | 成功 + 淡底 |
| `--bad` / `--badsoft` | `#F87171` | `#DC2626` | 错误/危险 + 淡底 |
| `--warn` / `--warnsoft` | `#FBBF24` | `#A16207` | 警告 + 淡底 |
| `--vio` / `--viosoft` | `#A78BFA` | `#9333EA` | 紫（特殊标记） + 淡底 |
| `--shadow` | 深色投影 | 暖色浅投影 | 卡片阴影 |
| `--hi` | inset 高光 | inset 高光 | 卡片顶边高光 |
| `--dot` | rgba 点 | rgba 点 | 背景点纹 |
| `--glass` | rgba .78 | rgba .82 | 玻璃拟态底 |

### 1.2 兼容旧名（9 个） —— 别名，**新样式别用**

给 `charts.js` 内联样式和 themeManager 注入前的兜底，全部指向新名：
`--text-muted→--faint`、`--surface→--card`、`--surface-alt→--card2`、
`--border-strong→--border2`、`--positive→--ok`、`--negative→--bad`、
`--warning→--warn`、`--accent→--acc`、`--accent-subtle→--accsoft`。

### 1.3 派生（1 个）

`--grad`：`135°`，从 `var(--accent, var(--acc))` 到 `var(--energy-high-accent, var(--acc2))`
—— themeManager 注入后自动跟主题走；主按钮、进度条在用。

**合计 397 次 `var()` 引用** —— 全站样式全靠这两块令牌撑着。

### 1.5 themeManager 注入的 18 个（全是旧名，不含 `--shadow`）

`themeManager.js` 的 `TOKEN_TO_CSS_VAR` 把 palette 的 18 个键写成同名 CSS 变量：
`--canvas` `--surface` `--surface-alt` `--hover` `--text` `--text-muted` `--text-inverse`
`--border` `--border-strong` `--accent` `--accent-hover` `--accent-subtle` `--focus`
+ `--positive` `--negative` `--warning` + `--energy-high-accent` `--energy-high-bg`。
**没有 `--shadow`**（`types.ts` 的 `ThemePalette` 里也没有 shadow 键）。

机制是双轨：明暗两块由 `data-theme-mode` 切换；themeManager 再把 palette 值内联注入
这些旧名变量。与新名撞车的只有 `--text` 和 `--border` 两个 —— 两边取值刻意保持一致
（`style.css` 头注释），覆盖也无感。

---

## 2. 响应式：4 个宽度断点 + 1 个动效偏好，共 5 块

`style.css` 里 `@media` 一共 **5 块**。

| 条件 | 位置 | 它改什么 |
|---|---|---|
| `(max-width: 1100px)` | `L645`（第 9 段内） | 账户详情分组收为单列 |
| `(max-width: 1000px)` | `L912` | stat-grid 3 列、表单网格 2 列 |
| `(max-width: 760px)` | `L916` | 主移动断点：控制条折行、标签栏横滚、hero 侧栏转横向、卡片内边距收紧 |
| `(max-width: 560px)` | `L930` | stat-grid 2 列、表单 1 列、日志终端 300px、表格 260px、隐藏日志 tag |
| `(prefers-reduced-motion: reduce)` | `L939` | `*` 关掉所有动画和过渡 |

### 2.1 三条你必须知道的规则

**① 宽度断点集中在第 18 段（`L911-942`），只有一条例外。**
`(max-width: 1100px)` 那条在第 9 段（`L645`），跟着账户详情的样式走。改窄屏表现
先在这两处找，不要在组件节里随手加。

**② 断点只有 1000 / 760 / 560 三档（外加 1100 一条），别引入新档位。**
新断点会和既有网格收列节奏打架；要调就调这三档里的规则。

**③ `prefers-reduced-motion` 会杀掉全部动画 —— 包括积分条入场、气泡过渡。**
动效「不见了」先查系统/浏览器的减弱动效设置，别急着改代码。

---

## 3. DOM 契约：JS 靠什么找元素

这一类东西**重命名不会报错**，只是功能悄悄没了。完整的"会怎么坏"见 guardrails 2.1；
这里是清单。

### 3.1 `id` —— 24 个写在 `index.html` 里，其中 22 个被 JS 抓

`U.$()` 找不到元素时**只返回 null**，紧接着赋值就抛 `Cannot read properties of null`。
**实测全项目 152 处 `U.$(…)` 调用，带 `?.` 守卫的只有 3 处** —— 改一个就够把面板打挂。

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

**不止 `index.html`**：全项目共 **124 个 id** 被引用（JS 选择器 / CSS 的 id 选择器 /
`href="#…"` / `aria-labelledby` 等 idref 属性），其余由各视图模板自己生成 —— 改视图里的 HTML 一样会踩。

### 3.2 `data-*` —— JS 读 24 个

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

`ThemePalette` 有 **25 个键**（`public/themes/types.ts`）：13 个基础色键
（`canvas`…`focus`，对应 1.2 的旧名变量）、`positive`/`negative`/`warning`、以及 9 个 energy 键
（`energyLowBg/Accent/Text`、`energyMedium…`、`energyHigh…`）。

### 4.2 只有 18 个键真的会被应用

`themeManager.js` 里的映射表把 palette 的键写成 CSS 变量，**只映射 18 个**：
13 个基础色键（`canvas`…`focus`，即 1.2 旧名那套）+ `positive` `negative` `warning` + `energyHighAccent` + `energyHighBg`。
完整名单和双轨机制见 1.5。

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

## 5. 组件清单：7 页 + 46 个共享类

### 5.1 七个页面

| 页面 | 视图文件 | 行数 | 样式在 |
|---|---|---|---|
| 总览 | `views/overview.js` | 630 | 第 7/8/9 段（`L374`/`L406`/`L442`） |
| 账号 | `views/accounts.js` | 329 | 第 10 段（`L592`） |
| 配置 | `views/config.js` | 1113 | 第 14 段（`L775`） |
| 运行 | `views/runs.js` | 689 | 第 11 段（`L683`） |
| 诊断 | `views/diagnostics.js` | 255 | 第 12 段（`L718`） |
| 调度 | `views/schedule.js` | 387 | 第 13 段（`L753`） |
| 日志 | `views/logs.js` | 322 | 第 15 段（`L833`） |

**"样式在"那一列就是你要找的那一节。** 每页在 `style.css` 里都有独立的编号大段。

### 5.2 共享词汇表：46 个类被两页以上用到

**改这 46 个等于同时改多页。** 数法：从 7 个视图文件的模板里提取静态 `class="…"`
（插值部分忽略），按出现的页数归类 —— 口径写在这，下次审计照着重数。

| 用到它的页数 | 类 |
|---|---|
| 7 页（全部） | `card`、`card-h`、`card-ic`、`card-title`、`card-tools` |
| 6 页 | `card-b`、`card-sub`、`empty-note`、`btn` |
| 5 页 | `btn-small` |
| 4 页 | `notice`、`notice--warn`、`btn-primary`、`field`、`input`、`check` |
| 3 页 | `av`、`acc-info`、`acc-mail`、`acc-sub`、`tag-mini`、`seg`、`seg-btn`、`btn-danger`、`form-actions` |
| 2 页 | `visually-hidden`、`acc-lines`、`modal-mask`、`modal`、`modal-h`、`modal-x`、`chart-wrap`、`hint`、`form`、`field-grid`、`field-item`、`field-hint`、`acc-detail-group`、`acc-detail-group-title`、`exit-chevron`、`kv`、`seg-btn--active`、`batch`、`check--row`、`bad`、`vio`（pill 修饰） |

另外 **143 个类只被一页用到**，动它们的影响面就是那一页。

### 5.3 共享组件的样式位置

| 组件 | 样式在 | 谁在用 |
|---|---|---|
| 卡片容器 `.card` | `style.css:245` | 全部 7 页 |
| 提示条 `.notice` | `style.css:354` | 4 页 |
| 空状态 `.empty-note` | `style.css:353` | 6 页 |
| 按钮 `.btn` 家族 | `style.css:267` | 6 页 |
| 输入 `.input` / 字段 `.field` | `style.css:309` / `:321` | 4 页 |
| 分段控件 `.seg` | `style.css:325` | 3 页 |
| 键值网格 `.kv` | `style.css:367` | 账号、总览（运行页账户详情） |
| 图表容器 `.chart-wrap` | `style.css:562` | 总览、运行 |
| 账户卡 `.acc-card` | `style.css:593` | 运行（账户列表） |
| 可展开列表项 `.exit-item` | `style.css:700` | 运行 |

改 `.btn` 之前想一下：6 个页面同时在用。

---

## 6. `style.css` 的地图

972 行，**19 个编号大段**。文件里的编号注释（`/* ==== 7. OVERVIEW: STAT GRID ==== */`
这种）就是权威边界：

| 行范围 | 段 | 内容 |
|---|---|---|
| `11-67` | `1. TOKENS` | 明暗两块令牌（各 34 名）+ `--grad`（见第 1 节） |
| `68-110` | `2. BASE` | reset、body、main 布局 |
| `111-130` | `2.5 ICON MASKS` | 图标遮罩 |
| `131-177` | `3. TOPBAR` | 顶栏、连接状态、明暗切换 |
| `178-239` | `4. TABBAR + CONTROL STRIP` | 标签栏、控制条（开始/重启/停止） |
| `240-265` | `5. LAYOUT & CARDS` | `.card` 容器体系（见 5.3） |
| `266-373` | `6. BUTTONS / INPUTS / SEG / PILLS` | 按钮、表单、分段、胶囊、表格、kv（见 5.3） |
| `374-405` | `7. OVERVIEW: STAT GRID` | 总览统计卡 |
| `406-441` | `8. OVERVIEW: RUN PROGRESS` | 上次运行进度 |
| `442-591` | `9. OVERVIEW: ACCOUNT ROWS / HERO` | 账户行、时间线、热力图、趋势弹窗（`1100px` 媒体查询也在这段，`L645`） |
| `592-682` | `10. ACCOUNTS` | 账号管理卡、弹窗列表 |
| `683-717` | `11. RUNS` | 运行页 |
| `718-752` | `12. DIAGNOSTICS` | 诊断页 |
| `753-774` | `13. SCHEDULE` | 调度页 |
| `775-832` | `14. CONFIG` | 配置页 |
| `833-862` | `15. LOGS` | 日志终端 |
| `863-902` | `16. TOAST / TICKER / LOGIN CODES` | toast、滚动条、登录码 |
| `903-910` | `17. FOOT` | 页脚 |
| `911-942` | `18. RESPONSIVE` | 4 个 `@media` 块（见第 2 节） |
| `943-972` | `19. MODAL` | 账号管理弹窗 |

**顺序是有意义的**：同优先级时后面的覆盖前面的。暗色模式**不是**媒体查询 ——
暗色就是 `:root` 默认值，浅色是第 1 段里 `[data-theme-mode="light"]` 的覆盖块。

定位任一样式，`grep` 编号注释最快：

```powershell
Select-String -Path public\style.css -Pattern '============' -Encoding UTF8
```

---

## 7. 已知不一致（7.1 已随重做修复，其余别当笔误）

### 7.1 `--warning` 已和 `consoleTheme` 对齐（旧漂移已修复）

旧档：`style.css` 的 `:root` 写 `--warning: #7D4E00`，而 `defaultTheme` light 是 `#8A4B00`。
2026-10 重做后 `:root` 改成 `--warning: var(--warn)`，且 `--warn` 的亮/暗两个值
（`#A16207` / `#FBBF24`）与 `consoleTheme` 的 light/dark `warning` **完全一致** ——
这条不再是漂移。主题加载前后都走同一组值。

### 7.2 `--energy-high-bg`：从「用了没定义」变成「注入了没人用」

旧档：旧版样式表有两处 `background: var(--energy-high-bg)`，但 `:root` 没定义，
只靠 `themeManager` 注入兜底，主题加载失败就没背景。2026-10 重做后样式表
**不再引用它**（全站零 `var()` 命中），而 `themeManager` 仍每次注入（`energyHighBg`）。
也就是说现在改主题文件里的 `energyHighBg` **没有任何视觉效果** —— 和 7.3 那 7 个键同类。

### 7.3 `themeManager` 只映射 18 个 palette 键，另外 7 个是空转

见 4.2。在主题文件里改 `energyLowBg` 之类**不会有任何视觉效果**。

---

## 8. 最短上手路径

1. 想改哪一页 → 查 5.1 拿到视图文件和 `style.css` 的节号。
2. 要颜色/圆角 → 查第 1 节，**只用令牌**。
3. 要新文案 → 中文进 `public/zh-cn.js`，key 是英文原文。
4. 改窄屏 → 直接去 `style.css:911` 之后（第 18 段 RESPONSIVE），不要在组件那节加。
5. 动手前扫一眼第 3 节，确认你没在改钩子。
6. 改完 **`F5`**（不用硬刷新），然后跑：

   ```powershell
   node tools/check-frontend.mjs
   ```

   七项检查，有 ❌ 就是必须修 —— 它会以非 0 退出，可以卡在提交前。
