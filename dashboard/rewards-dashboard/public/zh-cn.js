"use strict";

/**
 * 中文界面叠加层 (zh-CN overlay) for the Rewards Dashboard.
 *
 * Why an overlay instead of editing every view: the dashboard is a third-party
 * clone with no i18n layer and ~380 user-facing literals spread over 15 files,
 * most of them inside template literals that only exist at render time. A
 * dictionary + DOM pass translates static AND dynamically rendered text, keeps
 * the upstream tree mergeable (this is one new file plus one <script> line),
 * and makes the remaining gap measurable - see local/i18n-coverage.js.
 *
 * Loaded last from index.html. Safe to remove: delete the <script> line.
 */

// Whole-string matches, applied when a text node's trimmed value equals a key.
const EXACT = {
  // --- shell / chrome -------------------------------------------------------
  "Skip to main content": "跳到主内容",
  "🏅 Rewards Dashboard": "🏅 微软积分面板",
  "Rewards Dashboard": "微软积分面板",
  "Microsoft Rewards Dashboard": "微软积分面板",
  "Connecting…": "连接中…",
  "Switch to dark mode": "切换到深色模式",
  "Switch to light mode": "切换到浅色模式",
  Theme: "主题",
  "Dashboard sections": "面板分区",
  Idle: "空闲",
  "Start run": "开始运行",
  Stop: "停止",
  Restart: "重启",
  "More actions": "更多操作",
  "Force stop (SIGKILL)": "强制终止（SIGKILL）",
  "Shut down control API": "关闭控制 API",
  "🔑 Login approval needed": "🔑 需要批准登录",
  "Login approval needed": "需要批准登录",
  Development: "开发版",

  // --- run control + connection state (app.js / util.js) --------------------
  Connected: "已连接",
  Disconnected: "已断开",
  Ready: "就绪",
  Running: "运行中",
  "Running…": "运行中…",
  "Failure reasons": "最近一次失败原因",
  "Running now": "正在运行",
  Starting: "启动中",
  Stopping: "停止中",
  Stopped: "已停止",
  Interrupted: "已中断",
  Crashed: "已崩溃",
  Done: "已完成",
  Tasks: "任务",
  "Not collected yet": "尚未采集",
  Success: "成功",
  Error: "错误",
  Pending: "等待中",
  "Bot backend offline": "机器人后端离线",
  "Control API unavailable": "控制 API 不可用",
  "Control API token rejected": "控制 API 令牌被拒绝",
  "Dashboard server unreachable": "面板服务不可达",
  "Control API restarted — reconnected.": "控制 API 已重启 — 已重新连接。",
  "Run started.": "运行已开始。",
  "Stop signal sent.": "已发送停止信号。",
  "Force stop sent.": "已发送强制终止。",
  "Shutdown sent.": "已发送关闭指令。",
  "Force-kill the run (SIGKILL)? It gets no chance to clean up.":
    "强制终止本次运行（SIGKILL）？它将没有机会清理。",
  "Restart the bot? A run in progress will be stopped first.":
    "重启机器人？正在进行的运行会先被停止。",
  "just now": "刚刚",

  // --- tabs ----------------------------------------------------------------
  Overview: "总览",
  Accounts: "账户",
  Logs: "日志",
  Runs: "运行",
  Schedule: "计划",
  Config: "配置",
  Diagnostics: "诊断",

  // --- overview ------------------------------------------------------------
  "Accounts Overview": "账户总览",
  "Accounts tracked": "已跟踪账户",
  // 统计卡数的是"此刻处于错误状态"（overview.js 的 errorCount 用 status === "error"）；
  // 失败原因那栏数的是"最近失败过"（lastError 非空，副标题已写"按最近一次结果"）。
  // 两个数本来就会在"上一轮失败、此刻正在重跑"这类账号上分开 —— 标签各自说清口径，
  // 而不是把口径统一掉（统一任一侧都是丢信息）。
  "Accounts in error now": "当前出错的账户",
  "Combined balance": "合计余额",
  "Change in points since last check-in from all sources":
    "自上次检查以来各来源的积分变化",
  "Points earned last run": "上次运行获得积分",
  "Last run": "上次运行",
  "Last run duration": "上次运行耗时",
  "Run in progress": "运行进行中",
  "No run today": "今天没有运行",
  "Not scheduled": "未计划",
  Heatmap: "热力图",
  Timeline: "时间线",
  Trend: "趋势",
  Summary: "摘要",
  Points: "积分",
  "Days run": "运行天数",
  "Every recorded balance, oldest to newest": "每次记录的余额，由旧到新",
  "No accounts configured or observed yet.": "还没有配置或观察到账户。",
  "No history yet": "暂无历史",
  "No point history recorded for this account yet.": "该账户还没有积分历史。",
  "still running": "仍在运行",
  "coming up": "即将开始",

  // --- charts --------------------------------------------------------------
  "(today)": "（今天）",
  "No data yet.": "暂无数据。",
  "Point total over time": "积分总数变化",
  "Points collected per day": "每日获得积分",
  "today pinned at the far edge": "今天固定在最右侧",

  // --- accounts ------------------------------------------------------------
  "Batch run": "批量运行",
  "Run selected": "运行所选",
  "Run only": "仅运行",
  "Run history": "运行历史",
  "Runs recorded by the API": "API 记录的运行",
  "Select all": "全选",
  "Select": "选择",
  Select: "选择",
  Cancel: "取消",
  Delete: "删除",
  Set: "设置",
  "Are you sure?": "确定吗？",
  "Enabled": "已启用",
  Disabled: "已禁用",
  On: "开",
  Off: "关",
  Yes: "是",
  None: "无",
  "Not set": "未设置",
  "None set": "未设置",
  Unavailable: "不可用",
  Today: "今天",
  "Current streak": "当前连击",
  "Success streak": "成功连击",
  "Streak protection": "连击保护",
  "Protection days remaining": "保护剩余天数",
  "Protection status checked": "已检查保护状态",
  "Last duration": "上次耗时",
  "Points collected (API history)": "已获得积分（API 历史）",
  "History points loaded": "已加载历史积分",
  "Search activity": "搜索活动",
  Search: "搜索",
  "Geo locale": "地区",
  Language: "语言",
  Proxy: "代理",
  "Recovery email": "恢复邮箱",
  "TOTP secret": "TOTP 密钥",
  Configuration: "配置",
  "Configured in .env": "在 .env 中配置",
  "Claim reward": "领取奖励",
  "Claim bonus": "领取奖励",
  "Check-in": "签到",
  "App reward": "应用奖励",
  "URL reward": "URL 奖励",
  "Visual search": "可视化搜索",
  "Bonus search": "奖励搜索",
  Punchcard: "打卡任务",
  Read: "阅读",
  Earnable: "可获取",
  "days unavailable": "天不可用",
  "streak unavailable": "连击不可用",
  "exclude everyone else": "排除其他所有账户",
  "has a record in this run": "在本次运行中有记录",
  "Remove this account and its history from the dashboard":
    "从面板中删除该账户及其历史",
  "Permanently remove this account and its history from the dashboard":
    "从面板中永久删除该账户及其历史",
  "The account must be idle to delete it": "账户空闲时才能删除",

  // --- logs ----------------------------------------------------------------
  "Live logs": "实时日志",
  Autoscroll: "自动滚动",
  Pause: "暂停",
  Resume: "继续",
  Clear: "清空",
  Download: "下载",
  Level: "级别",
  All: "全部",
  "Errors only": "仅错误",
  "Warnings and up": "警告及以上",
  "Info and up": "信息及以上",
  "No log lines match the current filter.": "没有日志符合当前过滤条件。",

  // --- runs ----------------------------------------------------------------
  "Date range": "日期范围",
  Started: "开始时间",
  Duration: "耗时",
  Gained: "获得",
  "New total": "新余额",
  Status: "状态",
  Version: "版本",
  "Points per day": "每日积分",
  "Process exits": "进程退出",
  "How each run the control API launched actually ended":
    "控制 API 发起的每次运行的实际结果",
  "No runs recorded yet.": "暂无运行记录。",
  "No point history recorded yet.": "暂无积分历史。",
  "14d": "14 天",
  "30d": "30 天",
  "90d": "90 天",
  "run these x of y": "运行所选账户",

  // --- schedule ------------------------------------------------------------
  "Automatic runs": "自动运行",
  "Current state": "当前状态",
  "Scheduler location": "调度器位置",
  "This dashboard": "本面板",
  "Bot container (Docker cron)": "机器人容器（Docker cron）",
  "Cron expression": "Cron 表达式",
  "Daily at 09:00": "每天 09:00",
  "Twice daily (09:00, 21:00)": "每天两次（09:00、21:00）",
  "Weekdays at 08:00": "工作日 08:00",
  "Every 6 hours": "每 6 小时",
  "Every 12 hours": "每 12 小时",
  "Timezone": "时区",
  "Next run": "下次运行",
  "Last triggered": "上次触发",
  "Last result": "上次结果",
  "Excluded accounts": "排除的账户",
  Exclude: "排除",
  "Skip if already running": "已在运行时跳过",
  "Run once after startup": "启动后运行一次",
  "Run only within a grace period": "仅在宽限期内运行",
  "Grace period in minutes": "宽限期（分钟）",
  "If a run was missed while the dashboard was offline":
    "如果面板离线期间错过了运行",
  "Skip it": "跳过",
  "Save schedule": "保存计划",
  "Discard changes": "放弃修改",
  "Discard unsaved changes and switch scheduler?":
    "放弃未保存的修改并切换调度方式？",
  "A scheduled run must include at least one account.":
    "计划运行至少需要一个账户。",
  "No configured accounts are available.": "没有可用的已配置账户。",
  "Enter a 5-field cron expression.": "请输入 5 段式 cron 表达式。",
  "Cron runs inside the bot container itself — it fires even if this dashboard is offline, and simply doesn't fire while the container is stopped (so there's no missed-run policy to configure).":
    "Cron 在机器人容器内部运行 — 即使本面板离线也会触发；容器停止时则不触发（因此无需配置错过的运行策略）。",
  "This scheduler runs inside the dashboard's own process — it needs the dashboard container to be up to fire, but can recover a missed run according to the policy below.":
    "该调度器运行在面板自己的进程里 — 需要面板容器在线才能触发，但可以按下方的策略补跑错过的运行。",
  "Shut the control API down? The dashboard will go offline until you start it again on the bot host.":
    "关闭控制 API？面板将离线，直到你在机器人主机上重新启动它。",

  // --- diagnostics ---------------------------------------------------------
  "Session management": "会话管理",
  "Clear sessions": "清除会话",
  Refresh: "刷新",
  "Error captures": "错误抓取",
  "No stored sessions": "没有已保存的会话",
  "Nothing stored for this account yet": "该账户还没有保存任何内容",
  "No error text captured.": "未捕获错误文本。",
  "No error.txt in this capture.": "该抓取中没有 error.txt。",
  "No configured accounts found.": "未找到已配置账户。",
  "The bot must be idle to clear a session": "机器人空闲时才能清除会话",
  "Clearing sessions can fix most common login issues":
    "清除会话可以修复大多数常见登录问题",

  // --- config: sections ----------------------------------------------------
  "Configuration Options": "配置选项",
  Core: "核心",
  Workers: "任务开关",
  "Search settings": "搜索设置",
  Activities: "活动",
  Logging: "日志",
  Webhooks: "推送通知",
  Experimental: "实验性",
  "Other settings": "其他设置",
  Settings: "设置",
  "Raw config": "原始配置",
  "Config update available": "有可用配置更新",
  "Reload from API": "从 API 重新加载",
  "Reveal secrets": "显示密钥",
  "Save changes": "保存修改",
  "Sync now": "立即同步",
  Add: "添加",
  Enter: "输入",
  "Apply recommended filter": "应用推荐过滤",

  // --- config: workers -----------------------------------------------------
  "Daily set": "每日任务",
  "More activities": "更多活动",
  "Daily check-in": "每日签到",
  "Read to earn": "阅读赚积分",
  "Punch cards": "打卡任务",
  "App promotions": "应用推广",
  "Bonus searches": "奖励搜索",
  "Desktop search": "桌面搜索",
  "Mobile search": "移动端搜索",
  "Claim bonus points": "领取奖励积分",
  "Activate search perk": "激活搜索加成",
  "Visual search": "可视化搜索",
  "Complete daily set": "完成每日任务",
  'Complete "more activities"': '完成“更多活动”',
  "Complete daily check-in": "完成每日签到",
  "Complete Read-to-Earn": "完成阅读赚积分",
  "Complete punchcards": "完成打卡任务",
  "Complete app promotions": "完成应用推广",
  "Complete URL reward activities": "完成 URL 奖励活动",
  "Complete ExploreOnBing offers": "完成 ExploreOnBing 任务",
  "Auto-claim punchcard rewards": "自动领取打卡奖励",
  "Auto-claim completed punchcard rewards": "自动领取已完成的打卡奖励",
  "Activate the visual-search streak and perform visual searches":
    "激活可视化搜索连击并执行可视化搜索",
  'Activate the "search Nx more" perk when present (runs after the daily set)':
    "存在“再搜索 N 次”加成时激活（在每日任务之后执行）",
  "Complete ExploreOnBing offers over HTTP instead of the browser":
    "用 HTTP 而非浏览器完成 ExploreOnBing 任务",

  // --- config: search ------------------------------------------------------
  "Clusters": "集群数",
  "Number of concurrent account clusters": "并发账户集群数",
  "Parallel searching": "并行搜索",
  "Run searches in parallel": "并行执行搜索",
  "Cluster search": "聚类搜索",
  "Cluster each main topic with Bing suggestions": "用 Bing 建议聚类每个主题",
  "Click random results": "随机点击结果",
  "Click random links": "随机点击链接",
  "Scroll random results": "随机滚动结果",
  "Scroll randomly on results": "在结果页随机滚动",
  "Run on zero points": "零积分时也运行",
  "Run searches even when no search points remain":
    "即使没有剩余搜索积分也执行搜索",
  "Max bonus searches": "奖励搜索上限",
  "Max bonus searches per run (when Bonus searches is on)":
    "每次运行的奖励搜索上限（奖励搜索开启时）",
  "Farm bonus searches beyond the cap": "超出上限后继续刷奖励搜索",
  "Skip non-point tasks": "跳过无积分任务",
  "Skip tasks that award no points": "跳过不给积分的任务",
  "Query sources": "查询来源",
  "Sources used to build the search query pool": "构建查询词池使用的来源",
  "Delay between searches": "搜索间隔",
  "Minimum delay between searches": "搜索最小间隔",
  "Maximum delay between searches": "搜索最大间隔",
  "Delay for reading": "阅读延迟",
  "Minimum delay for reading": "阅读最小延迟",
  "Maximum delay for reading": "阅读最大延迟",
  "Delay before next account": "下一个账户前的延迟",
  "Minimum delay before starting the next configured account":
    "下一个账户前的最小延迟",
  "Maximum delay before starting the next configured account":
    "下一个账户前的最大延迟",
  "Search result visit time": "搜索结果停留时间",
  "Time to spend on each search result": "每个搜索结果停留时间",
  "Global timeout": "全局超时",
  "Timeout for all actions": "所有操作超时",
  "Session path": "会话目录",
  "Directory to store browser sessions": "浏览器会话保存目录",
  "Headless browser": "无头浏览器",
  "Run browser invisibly": "隐藏浏览器窗口运行",
  "API search": "API 搜索",
  "API ExploreOnBing": "API ExploreOnBing",
  "Edge browsing": "Edge 浏览",
  "Block media": "拦截媒体",
  "Block browser image and media requests to reduce traffic":
    "拦截浏览器的图片与媒体请求以减少流量",
  "Ignore certificate errors": "忽略证书错误",
  "Disable browser TLS certificate verification for intercept proxies":
    "为抓包代理关闭浏览器 TLS 证书校验",
  "Proxy query engine requests": "代理查询引擎请求",
  "Report the 30-minute Edge browsing activity as a background HTTP task":
    "把 30 分钟 Edge 浏览活动作为后台 HTTP 任务上报",
  "Perform Bing searches over HTTP instead of driving a browser page":
    "用 HTTP 执行 Bing 搜索，而不驱动浏览器页面",
  "Perform desktop searches": "执行桌面端搜索",
  "Perform mobile searches": "执行移动端搜索",
  "Local queries for ExploreOnBing": "ExploreOnBing 的本地查询词",
  "Use the local query list for ExploreOnBing":
    "ExploreOnBing 使用本地查询词列表",
  "Ensure streak protection": "确保连击保护",
  "Ensure streak protection is enabled": "确保连击保护已启用",

  // --- config: logging -----------------------------------------------------
  "Enable debug logging": "启用调试日志",
  "Debug logs": "调试日志",
  "Console log filter": "控制台日志过滤",
  "Enable console log filtering": "启用控制台日志过滤",
  "Console filter mode": "控制台过滤模式",
  "Console filter levels": "控制台过滤级别",
  "Console filter keywords": "控制台过滤关键词",
  "Console filter regex patterns": "控制台过滤正则",
  "Log levels to filter": "要过滤的日志级别",
  "Keywords to filter": "要过滤的关键词",
  "Regex patterns for filtering": "过滤用正则表达式",
  "Filter mode (whitelist/blacklist)": "过滤模式（白名单/黑名单）",
  Whitelist: "白名单",
  Blacklist: "黑名单",
  "Error diagnostics": "错误诊断",
  "Save error and unknown-login page diagnostics under diagnostics/":
    "把错误页与未知登录页的诊断信息保存到 diagnostics/",

  // --- config: webhooks ----------------------------------------------------
  "Discord webhook": "Discord 推送",
  "Discord webhook URL": "Discord 推送地址",
  "Enable Discord webhook": "启用 Discord 推送",
  "Telegram webhook": "Telegram 推送",
  "Telegram bot token": "Telegram 机器人令牌",
  "Telegram chat ID": "Telegram 会话 ID",
  "Telegram chat id": "Telegram 会话 ID",
  "Enable Telegram webhook": "启用 Telegram 推送",
  "ntfy webhook": "ntfy 推送",
  "ntfy server URL": "ntfy 服务器地址",
  "ntfy topic": "ntfy 主题",
  "ntfy auth token": "ntfy 认证令牌",
  "ntfy authentication token": "ntfy 认证令牌",
  "ntfy priority": "ntfy 优先级",
  "ntfy tags": "ntfy 标签",
  "ntfy notification title": "ntfy 通知标题",
  "Enable ntfy notifications": "启用 ntfy 通知",
  "Webhook log filter": "推送日志过滤",
  "Enable webhook log filtering": "启用推送日志过滤",
  "Webhook filter mode": "推送过滤模式",
  "Webhook filter levels": "推送过滤级别",
  "Webhook filter keywords": "推送过滤关键词",
  "Webhook filter regex patterns": "推送过滤正则",
  "Log levels to send": "要发送的日志级别",
  "Notification priority (1-5)": "通知优先级（1-5）",
  "Notification title": "通知标题",
  "Notification tags": "通知标签",
  "recommended webhook filter": "推荐推送过滤",
  "Webhook URLs and tokens are shown as": "推送地址与令牌显示为",

  // --- config: notices / empty states --------------------------------------
  "Enter a valid number.": "请输入有效数字。",
  "Nothing changed.": "没有任何更改。",
  "Already in the list.": "已在列表中。",
  "Already up to date.": "已是最新。",
  "The bot rejected this config:": "机器人拒绝了该配置：",
  "Only the fields you actually change are sent": "只发送你实际修改的字段",
  "Saves each change automatically. Applies on the next run.":
    "自动保存每次修改，下次运行时生效。",
  "Adds the missing fields with their defaults. Your existing values are never changed.":
    "按默认值补齐缺失字段，不会改动你已有的值。",
  "Discard unsaved edits and re-fetch config.json from the bot.":
    "放弃未保存的修改并从机器人重新获取 config.json。",
  "e.g. bot, notify": "例如 bot, notify",
  "e.g. error, warn": "例如 error, warn",
  "e.g. google, rss.bbc": "例如 google, rss.bbc",
  "e.g. starting account": "例如 starting account",
  "e.g. ^Error:": "例如 ^Error:",
  "10sec": "10 秒",
  "30sec": "30 秒",
  "1min": "1 分钟",
  "3min": "3 分钟",
};

// Patterns for text that carries a value. Whole-string rules only, so nothing
// is rewritten in the middle of an unrelated sentence.
const RULES = [
  [/^(\d+) lines? buffered$/, "$1 行已缓冲"],
  [/^(\d+)\/(\d+) selected$/, "已选 $1/$2"],
  [/^Load (\d+)$/, "加载 $1 条"],
  [/^Exit (-?\d+)$/, "退出码 $1"],
  [/^Schedule \((\d+) active\)$/, "计划（$1 个启用）"],
  [/^\+([\d,.]+)\s*pts today$/, "今天 +$1 分"],
  [/^-([\d,.]+)\s*pts today$/, "今天 -$1 分"],
  [/^([\d,.]+)\s*pts today$/, "$1 分（今天）"],
  [/^\+([\d,.]+)\s*pts$/, "+$1 分"],
  [/^([\d,]+)\s*points?$/, "$1 分"],
  [/^(\d+) accounts?$/, "$1 个账户"],
  [/^(\d+) of (\d+)$/, "$1 / $2"],
  [/^run these (\d+) of (\d+)$/i, "运行这 $1 个（共 $2 个）"],
  [/^Microsoft Rewards Dashboard: (.+)$/, "微软积分面板：$1"],
  // Overview card while an account's run is in flight, e.g.
  // "Running 2h 1m · +244 pts · 6m ago". Must precede the generic "(.+) ago" rule.
  // 账号卡片副标题。Running 分支下面三条一直有，Last Run 分支一条都没有 ——
  // 而 /^(.+) ago$/ 是锚定整串的，匹配不到 "Last Run: 5m ago"，于是只有它漏翻。
  // 先放带 ago 的（把相对时间也翻掉），再放兜底的。
  [/^Last Run: (.+) ago$/, "上次运行：$1 前"],
  [/^Last Run: (.+)$/, "上次运行：$1"],
  [/^Running (.+?) \u00b7 \+([\d,.]+) pts \u00b7 (.+) ago$/, "运行 $1 · 本轮 +$2 分 · 最后得分 $3 前"],
  [/^Running (.+?) \u00b7 \+([\d,.]+) pts$/, "运行 $1 · 本轮 +$2 分"],
  [/^Running (.+)$/, "运行 $1"],
  [/^(.+) ago$/, "$1 前"],
  [/^(\d+)d$/, "$1 天"],
  // Paragraph split by inline <code> markup, so only the tail is a text node.
  [
    /\)\.\s*The control API exposes full local email addresses but never sends passwords, recovery addresses, TOTP secrets, or proxy credentials\./,
    "）。控制 API 会显示完整的本地邮箱地址，但从不发送密码、恢复邮箱、TOTP 密钥或代理凭据。",
  ],
];

function translateString(s) {
  const trimmed = s.trim();
  if (!trimmed) return s;
  if (Object.prototype.hasOwnProperty.call(EXACT, trimmed)) {
    const lead = s.slice(0, s.indexOf(trimmed[0]));
    const tail = s.slice(lead.length + trimmed.length);
    return lead + EXACT[trimmed] + tail;
  }
  for (const [re, rep] of RULES) {
    if (re.test(trimmed)) {
      const lead = s.slice(0, s.indexOf(trimmed[0]));
      const tail = s.slice(lead.length + trimmed.length);
      return lead + trimmed.replace(re, rep) + tail;
    }
  }
  return s;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { EXACT, RULES, translateString };
}

// --- DOM pass (browser only) ------------------------------------------------
(function () {
  if (typeof document === "undefined") return;

  // Never touch raw payloads: the log stream, the config JSON editor, code
  // blocks, form controls, and anything explicitly opted out.
  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "TEXTAREA",
    "INPUT",
    "SELECT",
    "OPTION",
    "CODE",
    "PRE",
    "SVG",
    "CANVAS",
    "NOSCRIPT",
  ]);
  const SKIP_SELECTOR = "#logBox, .log-line, [data-no-i18n]";

  const ATTRS = ["placeholder", "title", "aria-label", "alt"];

  function skip(el) {
    if (!el || el.nodeType !== 1) return true;
    if (SKIP_TAGS.has(el.tagName)) return true;
    return typeof el.closest === "function" && !!el.closest(SKIP_SELECTOR);
  }

  function doText(node) {
    const parent = node.parentNode;
    if (skip(parent)) return;
    const next = translateString(node.nodeValue);
    if (next !== node.nodeValue) node.nodeValue = next;
  }

  function doAttrs(el) {
    if (skip(el)) return;
    for (const name of ATTRS) {
      if (!el.hasAttribute(name)) continue;
      const cur = el.getAttribute(name);
      const next = translateString(cur);
      if (next !== cur) el.setAttribute(name, next);
    }
  }

  function walk(root) {
    if (root.nodeType === 3) {
      doText(root);
      return;
    }
    if (root.nodeType !== 1) return;
    doAttrs(root);
    for (const child of root.childNodes) walk(child);
  }

  function run() {
    walk(document.body);
    if (document.title) {
      const t = translateString(document.title);
      if (t !== document.title) document.title = t;
    }
    // Announce a hook so the coverage work can be checked from the console.
    window.__zhApplied = true;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }

  // Native dialogs have no text node to observe, so the dictionary only reaches
  // them if the message is translated before it is handed to the real dialog.
  // (The run-control confirmations live here.)
  for (const fn of ["confirm", "alert", "prompt"]) {
    const original = window[fn];
    if (typeof original !== "function") continue;
    window[fn] = function (message, ...rest) {
      return original.call(this, translateString(String(message)), ...rest);
    };
  }

  // Views re-render constantly (5s poll + SSE). Batch mutations into one pass
  // per frame instead of translating inside the observer callback.
  let queued = new Set();
  let scheduled = false;
  function flush() {
    scheduled = false;
    const batch = queued;
    queued = new Set();
    for (const node of batch) {
      if (!node.isConnected) continue;
      walk(node);
    }
  }
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "characterData") queued.add(m.target);
      else for (const n of m.addedNodes) queued.add(n);
    }
    if (!queued.size || scheduled) return;
    scheduled = true;
    requestAnimationFrame(flush);
  });
  const start = () =>
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
