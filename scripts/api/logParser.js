const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

export function stripAnsi(str) {
    return typeof str === 'string' ? str.replace(ANSI_RE, '') : str
}

// 日志写入器会在行首再加一个裸时间戳（例如 2026-10-11 02:21:08.915），而走 IPC 的
// cleanMsg 没有它，所以同一个格式在文件和实时流里长得不一样。前缀设为可选，且用非捕获组，
// 这样 ts 仍然是中括号里那个时间，下游字段口径不变。此前带前缀的日志文件 100% 解析失败。
const LINE_RE = /^(?:\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} )?\[([^\]]*)\] \[([^\]]*)\] \[(INFO|WARN|ERROR|DEBUG)\] (MAIN|MOBILE|DESKTOP) \[([^\]]*)\] ([\s\S]*)$/

const SEVERITY = { debug: 0, info: 1, warn: 2, error: 3 }

export function severityRank(level) {
    return SEVERITY[level] ?? 1
}

export function parseLogLine(rawInput, source = 'stdout') {
    const raw = stripAnsi(String(rawInput))
    const match = raw.match(LINE_RE)

    if (match) {
        const [, ts, user, levelTag, platform, title, message] = match
        return {
            ts,
            level: levelTag.toLowerCase(),
            user: user || null,
            platform,
            title,
            message,
            source,
            parsed: true,
            raw
        }
    }

    let level = source === 'stderr' ? 'error' : 'info'
    if (/\b(ERROR|Error:|ERR!|FATAL|Traceback|Unhandled)\b/.test(raw)) level = 'error'
    else if (/\b(WARN|WARNING|Deprecat)/i.test(raw)) level = 'warn'

    return {
        ts: null,
        level,
        user: null,
        platform: null,
        title: null,
        message: raw,
        source,
        parsed: false,
        raw
    }
}

export function createRunState() {
    return {
        version: null,
        clusters: null,
        accountsTotal: null,
        currentEmail: null,
        userToEmail: {}, // log "user" (email localpart) -> full email, for attributing live lines
        lastPointUpdateAt: null,
        totals: null, // { collected, oldTotal, newTotal, runtimeMinutes, accountsProcessed }
        order: [], // emails in the order they started
        accounts: {}, // email -> account summary
        errors: [], // recent error/warn messages { ts, level, title, message }
        finished: false,
        pendingDelay: null // { seconds, nextEmail, sinceTs } while waiting between accounts/workers
    }
}

function ensureAccount(state, email) {
    if (!email) return null
    if (!state.accounts[email]) {
        state.accounts[email] = {
            email,
            geoLocale: null,
            locale: null,
            cachedRegion: null,
            initialPoints: null,
            collectedPoints: null,
            finalPoints: null,
            earnable: null, // { mobile, browser, app }; browser is the desktop search pool
            searchSummary: null, // { mobile, desktop, bonus, total }
            streakProtection: null, // { enabled, remainingDays, streakCounter, updatedAt }
            edgeBrowsing: null, // background Edge activity progress and ETA
            durationSeconds: null,
            success: null,
            error: null,
            live: {
                balance: null, // latest known available-points balance
                gained: 0, // points earned so far this run (per this account)
                bySource: {}, // keyed by normalized activity source
                lastUpdateTs: null
            }
        }
        state.order.push(email)
    }
    return state.accounts[email]
}

// All patterns adapted for the Chinese-localized fork of Microsoft-Rewards-Script.
// The field names (offers=, pointsGained=, currentBalance=, etc.) remain in English
// inside the log messages, but the surrounding text is Chinese.
const RE = {
    runStart: /^启动微软奖励脚本 \| v(\S+) \| 账户数: (\d+) \| 集群数: (\d+)/,
    accountStart:
        /^开始处理账户: (\S+) \| geoLocale: ([^|]+?)(?: \| locale: (\S+))?(?: \| 缓存区域: (\S+))?\s*$/,
    earnable: /^今日可赚取 \| 移动端: (\d+) \| 浏览器: (\d+) \| App: (\d+) \| (\S+) \| locale: (\S+)\s*$/,
    searchSummary: /^搜索汇总 \| 移动端=(-?\d+) \| 桌面端=(-?\d+) \| 额外=(-?\d+) \| 总计=(-?\d+)/,
    streakProtection:
        /^快照完成 \| offers=(\d+) \| 可上报=(\d+) \| streaks=(\d+) \| 连续保护已启用=(true|false|null) \| 连续保护剩余天数=(\d+|null) \| 连续计数=(\d+|null) \| 等级=([^|]+) \| 账户=(\S+@\S+)$/,
    accountEnd:
        /^账户完成: (\S+) \| 获得积分=(-?\d+|null) \| 原余额=(-?\d+|null) \| 现余额=(-?\d+|null) \| 持续秒数=([\d.]+|null)/,
    runEnd: /^全部账户完成 \| 处理账户数=(\d+) \| 获得积分=(-?\d+|null) \| 原余额=(-?\d+|null)(?:（[^）]*）)? \| 现余额=(-?\d+|null)(?:（[^）]*）)? \| 运行分钟数=([\d.]+)/,
    accountError: /^(\S+@\S+) \| 错误=([\s\S]+)$/,
    flowFailed: /(\S+@\S+) 的.*流程失败:/i,
    accountDelay: /^等待 ([\d.]+) 秒后开始下一个账户(?: \((\S+@\S+)\))?$/,

    searchStart: /^开始必应搜索 \| 当前余额=(\d+)/,
    // Search lines are the one activity this fork labels in Chinese; everything else keeps
    // the English names (pointsGained/currentBalance), so numericField() below never read them.
    searchProgress: /^获得积分=(-?\d+) \| 当前余额=(\d+)/,
    searchFinished: /^必应搜索完成 \| 获得积分=(-?\d+) \| 当前余额=(\d+)/,
    // 两个形态都要认：`积分已收集（基线未知，不报差额） | 现余额=500 | 账户=x`（没有
    // 获得积分）和 `积分已收集 | 获得积分=315 | 现余额=315 | 账户=x`。
    // 可选部分一律用非捕获组 (?:…)：捕获组下标一变，下面 m[1]/m[2]/m[3] 就会静默取错字段。
    flowCollected: /^积分已收集(?:（[^）]*）)? \| (?:获得积分=(-?\d+|null) \| )?现余额=(-?\d+|null) \| 账户=(\S+@\S+)/
}

function numericField(message, name) {
    const match = message.match(new RegExp(`(?:^| \\| )${name}=(-?\\d+(?:\\.\\d+)?)(?= \\| |$)`))
    return match ? Number(match[1]) : null
}

// 上游在"基线未知"时会把余额写成字面量 null（原余额=null | 现余额=null），
// runEnd 还会在后面加一句"（另有 N 个账号基线未知，未计入）"。Number("null") 是 NaN，
// 所以取数一律走这里：null / 空 / 非数字都得到 null（"不知道"），而不是 0。
// 这正是面板顶部数字偏低约 7 倍的根因 —— 三个整行锚定的正则匹配不上带 null 的行，
// 于是那些完成事件根本不被识别，界面把"读不到余额"显示成"赚了 0"。
function numOrNull(v) {
    if (v == null || v === 'null' || v === '') return null
    const n = Number(v)
    return Number.isNaN(n) ? null : n
}

function fractionField(message, name) {
    const match = message.match(new RegExp(`(?:^| \\| )${name}=(\\d+)\\/(\\d+)(?= \\| |$)`))
    return match ? { current: Number(match[1]), total: Number(match[2]) } : null
}

function eventTime(entry) {
    return entry.receivedAt ?? entry.ts ?? null
}

function accountEmailForEntry(state, entry) {
    return (entry.user && state.userToEmail[entry.user]) || state.currentEmail || null
}

function pointEventSource(title, message) {
    switch (title) {
        case 'SEARCH-BING':
            return message.startsWith('必应搜索完成') ? 'search' : null
        case 'SEARCH-BONUS':
            return message.startsWith('必应搜索完成') ? 'bonus' : null
        case 'READ-TO-EARN':
            // ReadToEarn 对同一笔积分打两行（debug 的「文章后的积分变化」和 info 的「已阅读第」），
            // 收尾再用「读文赚积分完成」重述一次活动总计，三种形状都映射到 read 会把这一项数成
            // 三倍（实测 90，真实 30）。只保留每篇恰好出现一次、且运行中就能看到的那种形状。
            // 这与搜索分支的处理一致（见 applyLivePoints 里的去重说明）。
            return message.startsWith('已阅读第') ? 'read' : null
        case 'DAILY-CHECK-IN':
            return message.startsWith('每日签到完成') ? 'checkIn' : null
        case 'CLAIM-BONUS-POINTS':
            return (message.startsWith('领取奖励积分完成') || message.startsWith('没有可领取的积分'))
                ? 'claimBonus'
                : null
        case 'CLAIM-REWARD':
            return message.startsWith('奖励已领取') ? 'claimReward' : null
        case 'URL-REWARD':
            return (message.startsWith('UrlReward 完成') || message.startsWith('UrlReward 未获得积分'))
                ? 'urlReward'
                : null
        case 'VISUAL-SEARCH':
            return (message.startsWith('每日视觉搜索完成') || message.startsWith('每日视觉搜索已记录'))
                ? 'visualSearch'
                : null
        case 'APP-REWARD':
            return (message.startsWith('AppReward 完成') || message.startsWith('AppReward 完成但未获得积分'))
                ? 'appReward'
                : null
        case 'PUNCHCARD':
            return (message.includes('COMPLETE') || message.includes('in progress')) ? 'punchcard' : null
        case 'SEARCH-ON-BING-SEARCH':
            return message.startsWith('SearchOnBing 活动完成') ? 'searchOnBing' : null
        default:
            return null
    }
}

function applyLivePoints(state, entry) {
    const msg = entry.message ?? ''

    const target = email => ensureAccount(state, email || accountEmailForEntry(state, entry))
    const num = s => {
        const n = Number(s)
        return Number.isFinite(n) ? n : null
    }
    const touch = acc => {
        const at = eventTime(entry)
        acc.live.lastUpdateTs = at
        state.lastPointUpdateAt = at
    }
    const setBalance = (acc, balance) => {
        if (!acc || balance == null) return false
        if (acc.live.balance === balance) return false
        acc.live.balance = balance
        touch(acc)
        return true
    }
    const addGain = (acc, gained, balance, source) => {
        if (!acc) return false
        let changed = false
        if (balance != null && acc.live.balance !== balance) {
            acc.live.balance = balance
            changed = true
        }
        // 只跳过 0 和缺值：扣分是真实存在的负增量（实测 CLAIM-BONUS-POINTS 返回 pointsGained=-9，
        // 余额 490→481），早先的 gained > 0 会把它整条丢掉，导致按来源加总比权威值高出这一笔。
        if (gained != null && gained !== 0) {
            acc.live.gained += gained
            acc.live.bySource[source] = (acc.live.bySource[source] || 0) + gained
            changed = true
        }
        if (changed) touch(acc)
        return changed
    }

    let m
    if ((entry.title === 'SEARCH-BING' || entry.title === 'SEARCH-BONUS') && (m = msg.match(RE.searchStart))) {
        return setBalance(target(), num(m[1]))
    }

    // Two shapes describe the same points and must not both be counted: one progress line per
    // search ("获得积分=3 | 当前余额=393 | 查询=… | remaining=12") and one closing summary per
    // batch ("必应搜索完成 | 获得积分=15 | 当前余额=405 | 之前余额=390 | 搜索次数=5"), whose
    // 获得积分 is the batch total (observed 15 = 5 x 3). Count the summary; let the progress
    // lines refresh the level only - that is what stops live.balance freezing between two
    // FLOW '积分已收集' totals.
    if ((entry.title === 'SEARCH-BING' || entry.title === 'SEARCH-BONUS') && (m = msg.match(RE.searchProgress))) {
        return setBalance(target(), num(m[2]))
    }

    if ((entry.title === 'SEARCH-BING' || entry.title === 'SEARCH-BONUS') && (m = msg.match(RE.searchFinished))) {
        return addGain(target(), num(m[1]), num(m[2]), pointEventSource(entry.title, msg) ?? 'search')
    }

    if (entry.title === 'FLOW' && (m = msg.match(RE.flowCollected))) {
        const acc = target(m[3])
        if (!acc) return false
        const total = numOrNull(m[1])
        const balance = numOrNull(m[2])
        const changed = acc.live.gained !== total || acc.live.balance !== balance
        acc.live.gained = total
        acc.live.balance = balance
        if (changed) touch(acc)
        return changed
    }

    const source = pointEventSource(entry.title, msg)
    if (!source) return false

    const gained = numericField(msg, 'pointsGained')
    const balance = numericField(msg, 'currentBalance')
    if (gained == null && balance == null) return false
    return addGain(target(), gained ?? 0, balance, source)
}

function applyEdgeBrowsing(state, entry) {
    if (entry.title !== 'EDGE-BROWSING') return null

    const account = ensureAccount(state, accountEmailForEntry(state, entry))
    if (!account) return null

    const message = entry.message ?? ''
    const finalReports = message.startsWith('后台 Edge 浏览活动结束')
        ? numericField(message, 'reports')
        : null
    const progress =
        fractionField(message, 'reportsCompleted') ??
        fractionField(message, 'report') ??
        (finalReports != null ? { current: finalReports, total: finalReports } : null)
    const previous = account.edgeBrowsing ?? {
        status: 'pending',
        targetMinutes: null,
        serverIntervalMinutes: null,
        reportsCompleted: 0,
        reportsTotal: null,
        reportsRemaining: null,
        scheduledMinutesCovered: 0,
        nextReportInSeconds: null,
        estimatedRemainingMinutes: null,
        elapsedMinutes: null,
        accepted: 0,
        duplicates: 0,
        failed: 0,
        waitingForBackground: false,
        updatedAt: null
    }

    if (message.startsWith('开始后台 Edge 浏览活动')) {
        previous.status = 'running'
        previous.targetMinutes = numericField(message, 'targetMinutes')
        previous.serverIntervalMinutes = numericField(message, 'serverIntervalMinutes')
        previous.reportsTotal = numericField(message, 'reports')
        previous.reportsRemaining = previous.reportsTotal
        previous.scheduledMinutesCovered = 0
        previous.estimatedRemainingMinutes = numericField(message, 'estimatedDurationMinutes')
        previous.waitingForBackground = false
    } else if (message.startsWith('Edge 浏览进度')) {
        previous.status = 'running'
    } else if (message.startsWith('已提交 Edge 浏览报告')) {
        previous.status = 'running'
        previous.nextReportInSeconds = null
    } else if (message.startsWith('后台 Edge 浏览活动结束')) {
        const duplicates = numericField(message, 'duplicates') ?? previous.duplicates
        const failed = numericField(message, 'failed') ?? previous.failed
        const serverCompleteMatch = message.match(/(?:^| \| )serverComplete=(true|false)(?= \| |$)/)
        const serverComplete = serverCompleteMatch ? serverCompleteMatch[1] === 'true' : null

        if (serverComplete === true) previous.status = 'complete'
        else if (serverComplete === false) previous.status = 'partial'
        else previous.status = duplicates > 0 || failed > 0 ? 'partial' : 'complete'

        previous.reportsRemaining = serverComplete === false ? previous.reportsRemaining : 0
        previous.nextReportInSeconds = null
        previous.estimatedRemainingMinutes = 0
        previous.waitingForBackground = false
    } else if (message === 'Edge 浏览连击（Browsing Streak）已完成') {
        previous.status = 'complete'
        previous.reportsRemaining = 0
        previous.nextReportInSeconds = null
        previous.estimatedRemainingMinutes = 0
        previous.waitingForBackground = false
    } else if (
        message === '该账户无法使用 Edge 浏览连击（Browsing Streak）' ||
        message.startsWith('跳过：')
    ) {
        previous.status = 'skipped'
        previous.waitingForBackground = false
    } else if (
        message.startsWith('后台 Edge 浏览活动失败') ||
        message.startsWith('意外的后台任务失败')
    ) {
        previous.status = 'failed'
        previous.waitingForBackground = false
    } else if (message === '后台活动已取消') {
        previous.status = 'cancelled'
        previous.waitingForBackground = false
    } else if (message.startsWith('前台活动已完成；')) {
        previous.waitingForBackground = true
    } else {
        return null
    }

    if (progress?.current != null) previous.reportsCompleted = progress.current
    if (progress?.total != null) previous.reportsTotal = progress.total

    const reportsRemaining = numericField(message, 'reportsRemaining')
    const scheduledMinutes = fractionField(message, 'scheduledMinutesCovered')
    const nextReportInSeconds = numericField(message, 'nextReportInSeconds')
    const estimatedRemainingMinutes = numericField(message, 'estimatedRemainingMinutes')
    const elapsedMinutes = numericField(message, 'elapsedMinutes')
    const accepted = numericField(message, 'accepted')
    const duplicates = numericField(message, 'duplicates')
    const failed = numericField(message, 'failed')

    if (reportsRemaining != null) previous.reportsRemaining = reportsRemaining
    if (scheduledMinutes?.current != null) previous.scheduledMinutesCovered = scheduledMinutes.current
    if (nextReportInSeconds != null) previous.nextReportInSeconds = nextReportInSeconds
    if (estimatedRemainingMinutes != null) previous.estimatedRemainingMinutes = estimatedRemainingMinutes
    if (elapsedMinutes != null) previous.elapsedMinutes = elapsedMinutes
    if (accepted != null) previous.accepted = accepted
    if (duplicates != null) previous.duplicates = duplicates
    if (failed != null) previous.failed = failed

    previous.updatedAt = eventTime(entry)
    account.edgeBrowsing = previous
    return 'edge-browsing'
}

export function applyLogToRunState(state, entry) {
    const msg = entry.message ?? ''

    if (entry.level === 'error' || entry.level === 'warn') {
        state.errors.push({
            ts: entry.ts,
            level: entry.level,
            title: entry.title,
            message: msg
        })
        if (state.errors.length > 200) state.errors.shift()

        const ff = msg.match(RE.flowFailed)
        if (ff) {
            const acc = ensureAccount(state, ff[1])
            if (acc) {
                acc.error = msg
                acc.success = acc.success === true ? true : false
            }
        }
    }

    if (!entry.parsed) return null

    if (applyLivePoints(state, entry)) return 'points'
    const edgeBrowsingEvent = applyEdgeBrowsing(state, entry)
    if (edgeBrowsingEvent) return edgeBrowsingEvent

    let m
    switch (entry.title) {
        case 'RUN-START':
            if ((m = msg.match(RE.runStart))) {
                state.version = m[1]
                state.accountsTotal = Number(m[2])
                state.clusters = Number(m[3])
                state.finished = false
                state.pendingDelay = null
                return 'run-start'
            }
            break

        case 'ACCOUNT-START':
            if ((m = msg.match(RE.accountStart))) {
                const acc = ensureAccount(state, m[1])
                if (acc) {
                    acc.geoLocale = m[2].trim()
                    acc.locale = m[3] || null
                    acc.cachedRegion = m[4] || null
                    // bySource 和 gained 都是「本账户本轮」的口径（见 ensureAccount 的注释），
                    // 而一个日志文件里可能有多轮，所以在这里归零。否则多轮的来源会叠加，
                    // 与 ACCOUNT-END 写进来的权威值对不上（实测 10-09/10-10 各有两个账户如此）。
                    acc.live.gained = 0
                    acc.live.bySource = {}
                }
                state.currentEmail = m[1]
                if (entry.user) state.userToEmail[entry.user] = m[1] // map localpart -> full email
                state.pendingDelay = null
                return 'account-start'
            }
            break

        case 'ACCOUNT-DELAY':
            if ((m = msg.match(RE.accountDelay))) {
                state.pendingDelay = {
                    seconds: Number(m[1]),
                    nextEmail: m[2] || null,
                    sinceTs: eventTime(entry)
                }
                return 'account-delay'
            }
            break

        case 'POINTS':
            if ((m = msg.match(RE.earnable))) {
                const email = m[4]
                const acc = ensureAccount(state, email)
                if (acc) {
                    acc.earnable = { mobile: Number(m[1]), browser: Number(m[2]), app: Number(m[3]) }
                    acc.locale ??= m[5]
                }
                state.currentEmail = email
            }
            break

        case 'SEARCH-MANAGER':
            if ((m = msg.match(RE.searchSummary))) {
                const acc = ensureAccount(state, accountEmailForEntry(state, entry))
                if (acc) {
                    acc.searchSummary = {
                        mobile: Number(m[1]),
                        desktop: Number(m[2]),
                        bonus: Number(m[3]),
                        total: Number(m[4])
                    }
                }
            }
            break

        case 'REACT-PARSE':
            if ((m = msg.match(RE.streakProtection))) {
                const acc = ensureAccount(state, m[8])
                if (acc) {
                    acc.streakProtection = {
                        enabled: m[4] === 'null' ? null : m[4] === 'true',
                        remainingDays: m[5] === 'null' ? null : Number(m[5]),
                        streakCounter: m[6] === 'null' ? null : Number(m[6]),
                        updatedAt: eventTime(entry)
                    }
                }
                return 'streak-protection'
            }
            break

        case 'ACCOUNT-END':
            if ((m = msg.match(RE.accountEnd))) {
                const acc = ensureAccount(state, m[1])
                if (acc) {
                    acc.collectedPoints = numOrNull(m[2])
                    acc.initialPoints = numOrNull(m[3])
                    acc.finalPoints = numOrNull(m[4])
                    acc.durationSeconds = numOrNull(m[5])
                    acc.success = true
                    acc.live.gained = numOrNull(m[2])
                    acc.live.balance = numOrNull(m[4])
                    const at = eventTime(entry)
                    acc.live.lastUpdateTs = at
                    state.lastPointUpdateAt = at
                }
                return 'account-end'
            }
            break

        case 'ACCOUNT-ERROR':
            if ((m = msg.match(RE.accountError))) {
                const acc = ensureAccount(state, m[1])
                if (acc) {
                    acc.error = m[2].trim()
                    acc.success = false
                }
                return 'account-error'
            }
            break

        case 'RUN-END':
            if ((m = msg.match(RE.runEnd))) {
                state.totals = {
                    accountsProcessed: numOrNull(m[1]),
                    collected: numOrNull(m[2]),
                    oldTotal: numOrNull(m[3]),
                    newTotal: numOrNull(m[4]),
                    runtimeMinutes: numOrNull(m[5])
                }
                state.finished = true
                state.pendingDelay = null
                return 'run-end'
            }
            break

        default:
            break
    }

    return null
}

function accountCollected(a) {
    if (typeof a.collectedPoints === 'number') return a.collectedPoints
    return a.live?.gained ?? 0
}

export function summarizeRunState(state) {
    const accounts = state.order.map(email => state.accounts[email])
    const collected = state.totals?.collected ?? accounts.reduce((sum, a) => sum + accountCollected(a), 0)

    const current = state.currentEmail ? state.accounts[state.currentEmail] : null
    return {
        version: state.version,
        clusters: state.clusters,
        accountsTotal: state.accountsTotal,
        accountsSeen: accounts.length,
        collected,
        totals: state.totals,
        finished: state.finished,
        pendingDelay: state.pendingDelay,
        // Set by the API's startup replay (see logReplay.js); null while a live run owns the state.
        backfill: state.backfill ?? null,
        live: {
            currentAccount: state.currentEmail,
            currentBalance: current?.live?.balance ?? null,
            gained: collected,
            updatedAt: state.lastPointUpdateAt
        },
        accounts
    }
}