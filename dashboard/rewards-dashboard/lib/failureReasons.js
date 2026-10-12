// 失败原因的「人话」字典 —— 面板（/api/accounts 的 failures 字段）和命令行工具
// （local/run-summary.js）共用这一份，避免两处判断各自漂移。
//
// 判定表是有序的：第一个匹配上的算数。匹配不到就如实返回 null ——
// 宁可把原始英文摆出来，也不要瞎归类（错误的原因比没有原因更贵）。
const REASONS = [
  {
    re: /identity\/confirm|身份验证|异常登录/,
    cause: "微软判定这次登录异常，要求人工确认一次",
    action: "用该账号的恢复邮箱收一次验证码确认；确认之后它就能自动跑",
  },
  {
    re: /consumers\/fido|passkey|FIDO/,
    cause: "登录被引到 FIDO/passkey 创建页，机器人无法完成注册（之前会空转 25 轮再超时）",
    action: "已修：现在先尝试自动关掉该引导页，关不掉就立刻停下。仍失败时，用该账号在真实浏览器里手动跳过一次 passkey 引导",
  },
  {
    re: /We use optional cookies|同意条|wcpConsent/i,
    cause: "登录页弹出了 cookie 同意条（旧代码把它当成登录错误）",
    action: "已修：现在会自动点掉再继续；若仍出现，看该账号是不是被带到了别的登录页",
  },
  {
    // 这句是机器人**确认过**账号没密码时才打的（Login.ts:683 的 !account.password 分支）。
    // 只有原始报错里真的这么写，才用这条 —— 不能靠状态名去替它断言。
    re: /既没配置密码|没配置密码、也没有恢复邮箱|no password|missing password/i,
    cause: "该账号触发了邮箱验证码，而机器人确认它既没配密码、也没有恢复邮箱",
    action: "人工登录该账号一次，或在 .env 里补上它的密码",
  },
  {
    // 只按状态名匹配时，别顺口断言"没配密码"：实测 ACCOUNT_9 是配了密码的，
    // 而且有密码时走的是完全另一条分支（切到「使用密码登录」）。
    re: /EMAIL_VERIFICATION_INPUT|邮箱验证/i,
    cause: "微软对这个账号发起了邮箱验证码挑战，卡在「确认你的邮箱」这一步",
    action: "机器人会自动尝试切到「使用密码登录」入口；仍失败就人工登录该账号一次，把这个挑战走完",
  },
  {
    re: /Login failed or aborted at state/i,
    cause: "登录状态机在某个状态下停了下来（具体是哪个状态，看原始报错里的 state）",
    action: "看原始报错里的 state 名；若是 UNKNOWN，多半遇到了未适配的引导页（如 passkey 页）",
  },
  {
    re: /Login timeout|exceeded maximum iterations/i,
    cause: "登录流程空转到迭代上限（被某个页面卡住了）",
    action: "看该账号日志里紧邻的「未知状态」行判断是哪个页面；是异常页就人工登录一次",
  },
  {
    re: /did not render|no section#dailyset/i,
    cause: "登录后奖励面板没渲染出来（重定向还没落地就检查了）",
    action: "已修：现在会重新加载并重试一次",
  },
  {
    // reqwest 是 Rust 的 HTTP 客户端 —— 这条错来自**移动端那一步的 Rust 组件**，
    // 不是浏览器侧，所以浏览器那些规则都接不住它。UnexpectedEof 的意思是
    // 「响应体读到一半连接就断了」。
    //
    // 实测依据（2026-10-12，两个账号同形）：
    //   · 两条都紧跟在「所有浏览器资源已关闭」之后，也就是移动端流程收尾时；
    //   · 两个账号此前都成功跑完过（jiabaoai403975 当天 09:35、nangonglirui786296
    //     前一天 22:50 都有正常的 ACCOUNT-END），代码没变 → 不是账号或密码问题；
    //   · 同一轮里两个不同账号在同一阶段同形失败 → 更像那一刻的网络/服务端。
    // 具体是哪个 Rust 组件我没在仓库里找到（在依赖里），所以只断言到能确认的程度。
    re: /reading response stream|reqwest::Error|UnexpectedEof/i,
    cause: "移动端那一步的响应体被中途截断（Rust 侧 reqwest 报 UnexpectedEof）—— 网络/服务端层面，不是账号或密码问题",
    action: "这类会随下一次运行重试；同一轮里多个账号同时出现时，先看那一刻的本机网络与代理",
  },
  {
    re: /peer closed connection|close_notify|ECONNRESET|socket hang up/i,
    cause: "到微软的连接被重置（网络/代理层面，不是代码问题）",
    action: "会自动重试；频繁出现时先查本机网络与代理",
  },
  {
    re: /Invalid credentials|wrong password|密码错误/i,
    cause: "账号或密码不对",
    action: "核对 .env 里该账号的密码",
  },
  {
    re: /未获得积分|pointsGained=0|no points/i,
    cause: "活动领到了但服务端不给分",
    action: "多半是当天额度已满；若在很早的文章/搜索上就出现，说明间隔设得太短",
  },
];

function explain(text) {
  const s = String(text || "");
  for (const r of REASONS) if (r.re.test(s)) return { cause: r.cause, action: r.action };
  return { cause: null, action: null };
}

// 把账号快照（store.snapshotAccounts()：账号成功时 last_error 会被清空）聚合成分类结果。
// 每类保留原始英文作为证据 —— 中文解释是给眼睛看的，原文是给核对用的。
function summarize(accounts, { maxExamples = 2 } = {}) {
  const rows = (accounts || []).filter((a) => a && a.lastError);
  const buckets = new Map();
  const unclassified = [];

  for (const a of rows) {
    const { cause, action } = explain(a.lastError);
    if (!cause) unclassified.push({ email: a.email, error: a.lastError });
    const key = cause || "未分类（判定表待补）";
    const b = buckets.get(key) || { cause: key, action, count: 0, examples: [] };
    b.count += 1;
    b.examples.push({ email: a.email, error: a.lastError });
    buckets.set(key, b);
  }

  const list = [...buckets.values()].sort((x, y) => y.count - x.count);
  for (const b of list) b.examples = b.examples.slice(0, maxExamples);

  return { failed: rows.length, buckets: list, unclassified };
}

module.exports = { explain, summarize, REASONS };
