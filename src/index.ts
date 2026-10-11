import { AsyncLocalStorage } from 'node:async_hooks'
import cluster, { Worker } from 'cluster'
import type { BrowserContext, Cookie, Page } from 'patchright'
import pkg from '../package.json'

import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'

import Browser from './browser/Browser'
import BrowserFunc from './browser/BrowserFunc'
import BrowserUtils from './browser/BrowserUtils'
import ReactFunc from './browser/ReactFunc'
import type { PageSnapshot } from './browser/ReactFunc'

import { IpcLog, Logger, formatLocalTimestamp } from './logging/Logger'
import Utils, { isBrowserClosedError } from './util/Utils'
import { loadAccounts, loadConfig } from './util/Load'
import { closeSessionStore, loadResolvedRegion, saveResolvedRegion } from './util/SessionStore'
import { checkNodeVersion } from './util/Validator'
import { normalizeCountry, resolveAccountLocale } from './util/Locale'
import type { AccountLocale } from './util/Locale'
import { configureHumanize, shouldSkipRunToday, waitForQuietHours, markRunSucceeded } from './util/Humanize'

import { Login } from './browser/auth/Login'
import Activities from './functions/Activities'
import { SearchManager } from './functions/activities/search/SearchManager'

import type { Account } from './interface/Account'
import HttpClient from './util/Http'
import { sendDiscord, flushDiscordQueue } from './logging/Discord'
import { sendNtfy, flushNtfyQueue } from './logging/Ntfy'
import { sendTelegram, flushTelegramQueue } from './logging/Telegram'
import { sendPushPlus, flushPushPlusQueue } from './logging/PushPlus'
import { sendServerChan, flushServerChanQueue } from './logging/ServerChan'
import { sendClawBot, flushClawBotQueue, ensureClawBotReady } from './logging/ClawBot'
import type { DashboardData } from './interface/DashboardData'
import type { AppDashboardData } from './interface/AppDashBoardData'
import type { AppEarnablePoints } from './interface/Points'

interface ExecutionContext {
    isMobile: boolean
    account: Account
}

interface BrowserSession {
    context: BrowserContext
    fingerprint: BrowserFingerprintWithHeaders
}

interface AccountStats {
    email: string
    initialPoints: number
    finalPoints: number
    collectedPoints: number
    duration: number
    success: boolean
    error?: string
}

interface AccountRunResult {
    initialPoints: number
    collectedPoints: number
    skippedForBotWarning?: boolean
}

const executionContext = new AsyncLocalStorage<ExecutionContext>()

export function getCurrentContext(): ExecutionContext {
    const context = executionContext.getStore()
    if (!context) {
        return { isMobile: false, account: {} as Account }
    }
    return context
}

async function flushAllWebhooks(timeoutMs = 5000): Promise<void> {
    await Promise.allSettled([
        flushDiscordQueue(timeoutMs),
        flushNtfyQueue(timeoutMs),
        flushTelegramQueue(timeoutMs),
        flushPushPlusQueue(timeoutMs),
        flushServerChanQueue(timeoutMs),
        flushClawBotQueue(timeoutMs)
    ])
    closeSessionStore()
}

interface UserData {
    userName: string
    geoLocale: string
    langCode: string
    timezoneOffset: string
    initialPoints: number
    currentPoints: number
    gainedPoints: number
}

export class MicrosoftRewardsBot {
    public logger: Logger
    public config
    public utils: Utils
    public activities: Activities = new Activities(this)
    public browser: { func: BrowserFunc; utils: BrowserUtils; react: ReactFunc }

    public mainMobilePage!: Page
    public mainDesktopPage!: Page

    public userData: UserData
    public accountLocale: AccountLocale

    public nextActions: Record<string, string> = {}
    public nextRouterStateTree = ''
    public reactSnapshot: PageSnapshot | null = null
    public reactSnapshots: { mobile: PageSnapshot | null; desktop: PageSnapshot | null } = {
        mobile: null,
        desktop: null
    }
    /**
     * 本账户因取到登录/跳转壳或缺少 RSC 载荷而跳过的页面解析次数。
     * 记在账户维度上，配合 REACT-PARSE-EMPTY 日志，避免这类静默失败只能靠翻全量日志发现。
     */
    public reactParseSkips = { loginShell: 0, noFlight: 0 }
    /**
     * 本轮已经确实拿到积分的子任务，键为 `parentId|childOfferId`。
     * PunchCards 每轮跑两遍（移动端 + 桌面端）且每次新建实例，所以备忘录要挂在 bot 上；
     * 只记拿到分的，返回 0 分的仍会重试（日志里见过同一子任务先 0 分、后一轮拿到 95 分）。
     */
    public reportedQuestChildren = new Set<string>()
    public searchTopicsCache: { key: string; topics: Promise<string[]> } | null = null

    public accessToken = ''
    public cookies: { mobile: Cookie[]; desktop: Cookie[] }
    private fingerprintMobile?: BrowserFingerprintWithHeaders
    private fingerprintDesktop?: BrowserFingerprintWithHeaders

    get fingerprint(): BrowserFingerprintWithHeaders {
        const ctx = this.isMobile ? this.fingerprintMobile : this.fingerprintDesktop
        return (ctx ?? this.fingerprintMobile ?? this.fingerprintDesktop) as BrowserFingerprintWithHeaders
    }

    private activeWorkers: number
    private exitedWorkers: number[]
    private browserFactory: Browser = new Browser(this)
    private accounts: Account[]
    private searchManager: SearchManager
    private login = new Login(this)

    public http!: HttpClient

    constructor() {
        this.userData = {
            userName: '',
            geoLocale: 'US',
            langCode: 'en',
            timezoneOffset: '60',
            initialPoints: 0,
            currentPoints: 0,
            gainedPoints: 0
        }
        this.accountLocale = resolveAccountLocale({ langCode: 'en', geoLocale: 'US' })
        this.logger = new Logger(this)
        this.accounts = []
        this.cookies = { mobile: [], desktop: [] }
        this.utils = new Utils()
        this.searchManager = new SearchManager(this)
        this.browser = {
            func: new BrowserFunc(this),
            utils: new BrowserUtils(this),
            react: new ReactFunc(this)
        }
        this.config = loadConfig()
        this.activeWorkers = this.config.clusters
        this.exitedWorkers = []
    }

    get isMobile(): boolean {
        return getCurrentContext().isMobile
    }

    get currentAccountEmail(): string | null {
        return getCurrentContext().account?.email || null
    }

    async refreshCurrentRewardsContext(reason: string): Promise<boolean> {
        const context = getCurrentContext()
        const account = context.account
        let page = context.isMobile ? this.mainMobilePage : this.mainDesktopPage
        let recoverySession: BrowserSession | null = null
        let refreshSucceeded = false

        if (!account?.email) {
            this.logger.debug(
                this.isMobile,
                'CONTEXT-REFRESH',
                `无法刷新奖励上下文 | 原因=${reason} | 账户=不可用`
            )
            return false
        }

        try {
            this.logger.warn(
                this.isMobile,
                'CONTEXT-REFRESH',
                `请求失败后正在刷新奖励浏览器上下文 | 原因=${reason}`
            )

            if (!page || page.isClosed()) {
                recoverySession = await this.browserFactory.createBrowser(account)
                page = await recoverySession.context.newPage()
                if (context.isMobile) {
                    this.mainMobilePage = page
                    this.fingerprintMobile = recoverySession.fingerprint
                } else {
                    this.mainDesktopPage = page
                    this.fingerprintDesktop = recoverySession.fingerprint
                }

                await this.login.login(page, account)
            } else {
                this.nextActions = {}
                this.nextRouterStateTree = ''
                this.reactSnapshot = null
                await this.browser.func.synchronizeActiveBrowserCookies('CONTEXT-REFRESH-COOKIE-SEED', true)
                try {
                    await this.browser.func.bootstrap(page)
                } catch {
                    await this.login.login(page, account)
                }
            }

            await this.browser.func.checkpointActiveSession('CONTEXT-REFRESH')

            const refreshedCookies = await page.context().cookies()
            this.logger.info(
                this.isMobile,
                'CONTEXT-REFRESH',
                `奖励上下文刷新成功 | Cookie数=${refreshedCookies.length}`,
                'green'
            )
            refreshSucceeded = true
            return true
        } catch (error) {
            this.logger.error(
                this.isMobile,
                'CONTEXT-REFRESH',
                `奖励上下文刷新失败 | 原因=${reason} | 信息=${error instanceof Error ? error.message : String(error)}`
            )
            return false
        } finally {
            if (recoverySession) {
                await this.browser.func.closeBrowser(recoverySession.context, account.email, refreshSucceeded)
            }
        }
    }

    async initialize(): Promise<void> {
        this.accounts = loadAccounts()
        this.warnExperimental()
    }

    private warnExperimental(): void {
        const exp = this.config.experimental
        const searchFeatures = [exp.apiSearch && 'apiSearch', exp.apiSearchOnBing && 'apiSearchOnBing'].filter(
            Boolean
        ) as string[]

        if (searchFeatures.length) {
            this.logger.warn(
                'main',
                'EXPERIMENTAL',
                `${searchFeatures.join(' + ')} 已启用 - 这些功能通过 HTTP 执行搜索，不使用真实浏览器。` +
                    `此路径属于实验性且不安全，可能导致你的账户被标记或封禁。` +
                    `如不确定，请在 config.experimental 下禁用。`,
                'redBright'
            )
        }

        if (exp.edgeBrowsing) {
            this.logger.warn(
                'main',
                'EXPERIMENTAL',
                'edgeBrowsing 已启用 - Edge 浏览活动将在后台通过 HTTP 上报。' +
                    '此集成为实验性功能；如表现异常，请在 config.experimental 下禁用。'
            )
        }
    }

    async run(): Promise<void> {
        const totalAccounts = this.accounts.length
        const runStartTime = Date.now()

        configureHumanize(this)

        this.logger.info(
            'main',
            'RUN-START',
            `启动微软奖励脚本 | v${pkg.version} | 账户数: ${totalAccounts} | 集群数: ${this.config.clusters}`
        )

        if (this.config.clusters <= 1 || cluster.isPrimary) {
            if (shouldSkipRunToday()) {
                this.logger.info(
                    'main',
                    'RUN-SKIP',
                    '今天已成功完成过一次运行，按 humanize.skipWhenCompletedToday 跳过本次运行'
                )
                process.exit(0)
            }

            await waitForQuietHours()
        }

        // 主进程启动时检查 ClawBot 凭证：缺失则弹出扫码登录（worker 不重复触发）
        if (cluster.isPrimary) {
            await ensureClawBotReady(this.config.webhook?.clawbot)
        }

        if (this.config.clusters > 1) {
            if (cluster.isPrimary) {
                await this.runMaster(runStartTime)
            } else {
                this.runWorker(runStartTime)
            }
        } else {
            await this.runTasks(this.accounts, runStartTime)
        }
    }

    private async runMaster(runStartTime: number): Promise<void> {
        void this.logger.info('main', 'CLUSTER-PRIMARY', `主进程已启动 | PID: ${process.pid}`)

        const rawChunks = this.utils.chunkArray(this.accounts, this.config.clusters)
        const accountChunks = rawChunks.filter(c => c && c.length > 0)
        this.activeWorkers = accountChunks.length

        const allAccountStats: AccountStats[] = []
        let hadWorkerFailure = false

        for (const [chunkIndex, chunk] of accountChunks.entries()) {
            if (chunkIndex > 0) {
                await this.waitBeforeNextAccount(chunk[0]?.email)
            }

            const worker = cluster.fork()
            worker.send?.({ chunk, runStartTime })

            worker.on('message', (msg: { __ipcLog?: IpcLog; __stats?: AccountStats[] }) => {
                if (msg.__stats) {
                    allAccountStats.push(...msg.__stats)
                }

                const log = msg.__ipcLog
                if (log && typeof log.content === 'string') {
                    const { webhook } = this.config
                    const { content, level } = log

                    if (webhook.discord?.enabled && webhook.discord.url) {
                        sendDiscord(webhook.discord.url, content, level)
                    }
                    if (webhook.ntfy?.enabled && webhook.ntfy.url) {
                        sendNtfy(webhook.ntfy, content, level)
                    }
                    if (webhook.telegram?.enabled && webhook.telegram.botToken && webhook.telegram.chatId) {
                        sendTelegram(webhook.telegram, content, level)
                    }
                }
            })
        }

        const onWorkerExit = async (worker: Worker, code?: number, signal?: string): Promise<void> => {
            const { pid } = worker.process

            if (!pid || this.exitedWorkers.includes(pid)) {
                return
            }

            this.exitedWorkers.push(pid)
            this.activeWorkers -= 1

            const failed = (code ?? 0) !== 0 || Boolean(signal)
            if (failed) {
                hadWorkerFailure = true
            }

            this.logger.warn(
                'main',
                'CLUSTER-WORKER-EXIT',
                `worker ${pid} 退出 | 代码: ${code ?? 'n/a'} | 信号: ${signal ?? 'n/a'} | 活跃worker数: ${this.activeWorkers}`
            )

            if (this.activeWorkers <= 0) {
                const totalCollectedPoints = allAccountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
                const totalInitialPoints = allAccountStats.reduce((sum, s) => sum + s.initialPoints, 0)
                const totalFinalPoints = allAccountStats.reduce((sum, s) => sum + s.finalPoints, 0)
                const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)

                this.logger.info(
                    'main',
                    'RUN-END',
                    `全部账户完成 | 处理账户数=${allAccountStats.length} | 获得积分=${totalCollectedPoints} | 原余额=${totalInitialPoints} | 现余额=${totalFinalPoints} | 运行分钟数=${totalDurationMinutes}`,
                    'green'
                )

                await this.sendPushPlusSummary(allAccountStats, runStartTime, hadWorkerFailure)
                await this.sendServerChanSummary(allAccountStats, runStartTime, hadWorkerFailure)
                await this.sendClawBotSummary(allAccountStats, runStartTime, hadWorkerFailure)
                await flushAllWebhooks()

                if (!hadWorkerFailure) markRunSucceeded()
                process.exit(hadWorkerFailure ? 1 : 0)
            }
        }

        cluster.on('exit', (worker, code, signal) => {
            void onWorkerExit(worker, code ?? undefined, signal ?? undefined)
        })

        cluster.on('disconnect', worker => {
            const pid = worker.process?.pid
            this.logger.warn('main', 'CLUSTER-WORKER-DISCONNECT', `worker ${pid ?? '?'} 已断开连接`)
        })
    }

    private runWorker(runStartTimeFromMaster?: number): void {
        void this.logger.info('main', 'CLUSTER-WORKER-START', `worker 已生成 | PID: ${process.pid}`)

        process.on('message', async ({ chunk, runStartTime }: { chunk: Account[]; runStartTime: number }) => {
            void this.logger.info(
                'main',
                'CLUSTER-WORKER-TASK',
                `worker ${process.pid} 接收到 ${chunk.length} 个账户。`
            )

            try {
                const stats = await this.runTasks(chunk, runStartTime ?? runStartTimeFromMaster ?? Date.now())

                if (process.send) {
                    process.send({ __stats: stats })
                }

                await flushAllWebhooks()
                process.exit(0)
            } catch (error) {
                this.logger.error(
                    'main',
                    'CLUSTER-WORKER-ERROR',
                    `worker 任务崩溃: ${error instanceof Error ? error.message : String(error)}`
                )

                await flushAllWebhooks()
                process.exit(1)
            }
        })
    }

    private buildSummaryMessage(accountStats: AccountStats[], runStartTime: number, hadWorkerFailure: boolean): string {
        const totalCollectedPoints = accountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
        const totalInitialPoints = accountStats.reduce((sum, s) => sum + s.initialPoints, 0)
        const totalFinalPoints = accountStats.reduce((sum, s) => sum + s.finalPoints, 0)
        const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)
        const timestamp = formatLocalTimestamp(new Date())

        const lines: string[] = [
            `每日积分摘要 | ${timestamp}`,
            `状态: ${hadWorkerFailure ? '异常' : '完成'}`,
            `账户数: ${accountStats.length}`,
            `总收集积分: +${totalCollectedPoints}`,
            `原始总计: ${totalInitialPoints} → 新总计: ${totalFinalPoints}`,
            `总运行时间: ${totalDurationMinutes}分钟`
        ]

        if (accountStats.length > 0) {
            lines.push('')
            lines.push('账户明细:')
            for (const stat of accountStats) {
                const status = stat.success ? '成功' : '失败'
                const duration = Number.isFinite(stat.duration) ? stat.duration.toFixed(1) : String(stat.duration)
                const error = stat.error ? ` | ${stat.error}` : ''
                lines.push(
                    `${stat.email} | +${stat.collectedPoints} | ${stat.initialPoints}→${stat.finalPoints} | ${duration}秒 | ${status}${error}`
                )
            }
        }

        return lines.join('\n')
    }

    private async sendPushPlusSummary(
        accountStats: AccountStats[],
        runStartTime: number,
        hadWorkerFailure: boolean
    ): Promise<void> {
        const pushplus = this.config?.webhook?.pushplus
        if (!pushplus?.enabled || !pushplus.token) {
            return
        }

        const content = this.buildSummaryMessage(accountStats, runStartTime, hadWorkerFailure)
        await sendPushPlus(pushplus, content)
    }

    private async sendServerChanSummary(
        accountStats: AccountStats[],
        runStartTime: number,
        hadWorkerFailure: boolean
    ): Promise<void> {
        const serverchan = this.config?.webhook?.serverchan
        if (!serverchan?.enabled || !serverchan.sendKey) {
            return
        }

        const content = this.buildSummaryMessage(accountStats, runStartTime, hadWorkerFailure)
        await sendServerChan(serverchan, content)
    }

    private async sendClawBotSummary(
        accountStats: AccountStats[],
        runStartTime: number,
        hadWorkerFailure: boolean
    ): Promise<void> {
        const clawbot = this.config?.webhook?.clawbot
        if (!clawbot?.enabled) {
            return
        }

        const content = this.buildSummaryMessage(accountStats, runStartTime, hadWorkerFailure)
        await sendClawBot(clawbot, content)
    }

    private async runTasks(accounts: Account[], runStartTime: number): Promise<AccountStats[]> {
        const accountStats: AccountStats[] = []

        for (const [accountIndex, account] of accounts.entries()) {
            if (accountIndex > 0) {
                await this.waitBeforeNextAccount(account.email)
            }

            const accountStartTime = Date.now()
            const accountEmail = account.email
            // 每个账号重置初始余额：否则账号 A 失败时会把账号 B 的初始余额当成自己的，
            // 算出错误的"已赚积分"。NaN = 本轮还没读到初始余额（失败分支靠它判断能否做差额）。
            this.userData.initialPoints = Number.NaN
            this.userData.userName = this.utils.getEmailUsername(accountEmail)
            this.userData.timezoneOffset = String(new Date().getTimezoneOffset())

            try {
                const cachedRegion =
                    account.geoLocale === 'auto' ? loadResolvedRegion(this.config.sessionPath, accountEmail) : undefined
                this.accountLocale = resolveAccountLocale(account, cachedRegion)
                this.userData.langCode = this.accountLocale.language
                this.userData.geoLocale = this.accountLocale.country ?? 'US'

                this.logger.info(
                    'main',
                    'ACCOUNT-START',
                    `开始处理账户: ${accountEmail} | geoLocale: ${account.geoLocale} | locale: ${this.accountLocale.locale}${
                        cachedRegion ? ` | 缓存区域: ${cachedRegion}` : ''
                    }`
                )

                this.http = new HttpClient(account.proxy, {
                    'Accept-Language': this.accountLocale.acceptLanguage
                })

                let flowError: string | undefined
                const result: AccountRunResult | undefined = await this.Main(account).catch(error => {
                    flowError = error instanceof Error ? error.message : String(error)

                    // 这里以前写死"移动端流程失败"、并以 isMobile=true 记录 —— 实测那次的失败
                    // 发生在**桌面端**登录（FIDO/passkey 页空转到 25 轮），于是文案和结构化
                    // platform 字段一起撒谎，把排查引向错误的子系统。AsyncLocalStorage 的上下文
                    // 此刻已经退出，拿不到当时的平台，所以报告"最后进入的阶段"并把日志归到 MAIN，
                    // 宁可少说，不再乱指。
                    const seen = this.logger.lastPlatform
                    const phase = seen === 'main' || seen === null ? '未进入浏览器阶段' : seen ? '移动端' : '桌面端'

                    void this.logger.error(
                        'main',
                        'FLOW',
                        `${accountEmail} 的账号流程失败: ${flowError} | 最后阶段=${phase}`
                    )
                    return undefined
                })

                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)

                if (result) {
                    const collectedPoints = result.collectedPoints ?? 0
                    const accountInitialPoints = result.initialPoints ?? 0
                    const accountFinalPoints = accountInitialPoints + collectedPoints

                    if (result.skippedForBotWarning) {
                        accountStats.push({
                            email: accountEmail,
                            initialPoints: accountInitialPoints,
                            finalPoints: accountInitialPoints,
                            collectedPoints: 0,
                            duration: parseFloat(durationSeconds),
                            success: false,
                            error: 'Microsoft bot-score warning detected'
                        })

                        this.logger.warn(
                            'main',
                            'ACCOUNT-SKIP',
                            `跳过账户: ${accountEmail} | 原因=Fraud_UserWarning_BotScore_UX | 持续秒数=${durationSeconds}`
                        )
                    } else {
                        accountStats.push({
                            email: accountEmail,
                            initialPoints: accountInitialPoints,
                            finalPoints: accountFinalPoints,
                            collectedPoints: collectedPoints,
                            duration: parseFloat(durationSeconds),
                            success: true
                        })

                        this.logger.info(
                            'main',
                            'ACCOUNT-END',
                            `账户完成: ${accountEmail} | 获得积分=${collectedPoints} | 原余额=${accountInitialPoints} | 现余额=${accountFinalPoints} | 持续秒数=${durationSeconds}`,
                            'green'
                        )
                    }
                } else {
                    const errorDetail = flowError && flowError !== 'undefined'
                        ? flowError.replace(/\r?\n/g, ' ').slice(0, 120)
                        : '流程失败（未捕获到错误详情）'

                    // 中途失败时之前直接记 0 分，于是"桌面端已经赚到、后面某个阶段才失败"
                    // 这类账号的分被从本轮账本里抹掉（实测少算了一个账号的 350 分）。
                    // 这里把已赚的分尽量捞回来：只有本账号的初始余额已经读到才做差额，
                    // 余额复核失败就如实记 0 —— 不猜，也不把账号原有的余额当成赚到的。
                    let accountInitialPoints = 0
                    let salvagePoints = 0

                    if (Number.isFinite(this.userData.initialPoints)) {
                        accountInitialPoints = this.userData.initialPoints as number
                        try {
                            const balanceNow = await Promise.race([
                                this.browser.func.getCurrentPoints(),
                                new Promise<number>(resolve => setTimeout(() => resolve(Number.NaN), 20000))
                            ])
                            if (Number.isFinite(balanceNow)) {
                                salvagePoints = Math.max(0, balanceNow - accountInitialPoints)
                            }
                        } catch {
                            // 会话可能已随失败关闭；复核不到就记 0。
                        }
                    }

                    if (salvagePoints > 0) {
                        this.logger.warn(
                            'main',
                            'ACCOUNT-PARTIAL',
                            `${accountEmail} | 流程失败但已获得积分=${salvagePoints} | 原余额=${accountInitialPoints} | 现余额=${
                                accountInitialPoints + salvagePoints
                            } | 错误=${errorDetail}`
                        )
                    }

                    accountStats.push({
                        email: accountEmail,
                        initialPoints: accountInitialPoints,
                        finalPoints: accountInitialPoints + salvagePoints,
                        collectedPoints: salvagePoints,
                        duration: parseFloat(durationSeconds),
                        success: false,
                        error: errorDetail
                    })
                }
            } catch (error) {
                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)
                this.logger.error(
                    'main',
                    'ACCOUNT-ERROR',
                    `${accountEmail} | 错误=${error instanceof Error ? error.message : String(error)}`
                )

                accountStats.push({
                    email: accountEmail,
                    initialPoints: 0,
                    finalPoints: 0,
                    collectedPoints: 0,
                    duration: parseFloat(durationSeconds),
                    success: false,
                    error: error instanceof Error ? error.message : String(error)
                })
            }
        }

        if (this.config.clusters <= 1 && cluster.isPrimary) {
            const totalCollectedPoints = accountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
            const totalInitialPoints = accountStats.reduce((sum, s) => sum + s.initialPoints, 0)
            const totalFinalPoints = accountStats.reduce((sum, s) => sum + s.finalPoints, 0)
            const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)

            this.logger.info(
                'main',
                'RUN-END',
                `全部账户完成 | 处理账户数=${accountStats.length} | 获得积分=${totalCollectedPoints} | 原余额=${totalInitialPoints} | 现余额=${totalFinalPoints} | 运行分钟数=${totalDurationMinutes}`,
                'green'
            )

            const hadFailure = accountStats.some(s => !s.success)
            await this.sendPushPlusSummary(accountStats, runStartTime, hadFailure)
            await this.sendServerChanSummary(accountStats, runStartTime, hadFailure)
            await this.sendClawBotSummary(accountStats, runStartTime, hadFailure)
            await flushAllWebhooks()

            if (!hadFailure) markRunSucceeded()
            process.exit(0)
        }

        return accountStats
    }

    private async gapBetweenWorkers(): Promise<void> {
        const delayMs = this.utils.randomDelay(60000, 240000)
        this.logger.debug(this.isMobile, 'FLOW', `大任务间隔等待 | ${Math.round(delayMs / 1000)}秒`)
        await this.utils.wait(delayMs)
    }

    private async waitBeforeNextAccount(nextEmail?: string): Promise<void> {
        const { min, max } = this.config.accountDelay
        const minMs = typeof min === 'number' ? min : this.utils.stringToNumber(min)
        const maxMs = typeof max === 'number' ? max : this.utils.stringToNumber(max)

        if (minMs < 0 || maxMs < 0 || maxMs < minMs) {
            throw new Error('accountDelay must use non-negative values with max greater than or equal to min')
        }

        const delayMs = this.utils.randomNumber(Math.ceil(minMs), Math.floor(maxMs))
        this.logger.info(
            'main',
            'ACCOUNT-DELAY',
            `等待 ${(delayMs / 1000).toFixed(1)} 秒后开始下一个账户${
                nextEmail ? ` (${nextEmail})` : ''
            }`
        )
        await this.utils.wait(delayMs)
    }

    async createDesktopSession(account: Account): Promise<BrowserSession> {
        const session = await this.browserFactory.createBrowser(account)
        this.mainDesktopPage = await session.context.newPage()
        this.fingerprintDesktop = session.fingerprint

        this.logger.info(this.isMobile, 'BROWSER', `桌面浏览器已启动 | ${account.email}`)

        await this.login.login(this.mainDesktopPage, account)
        await this.browser.func.checkpointActiveSession('LOGIN-CHECKPOINT')
        this.cookies.desktop = await session.context.cookies()

        return session
    }

    async Main(account: Account): Promise<AccountRunResult> {
        const accountEmail = account.email
        this.logger.info('main', 'FLOW', `开始为 ${accountEmail} 创建会话`)

        this.accessToken = ''
        this.cookies = { mobile: [], desktop: [] }
        this.fingerprintMobile = undefined
        this.fingerprintDesktop = undefined
        this.reactSnapshot = null
        this.reactSnapshots = { mobile: null, desktop: null }
        this.reactParseSkips = { loginShell: 0, noFlight: 0 }
        this.reportedQuestChildren = new Set()
        this.searchTopicsCache = null

        const apiSearch = this.config.experimental.apiSearch
        const apiSearchOnBing = this.config.experimental.apiSearchOnBing
        const fullApi = apiSearch && (apiSearchOnBing || !this.config.activities.searchOnBing)
        const needsAppActivities =
            this.config.workers.doDailyCheckIn ||
            this.config.workers.doAppPromotions ||
            this.config.workers.doReadToEarn
        const needsAppAccessToken = this.config.experimental.edgeBrowsing || needsAppActivities

        let mobileSession: BrowserSession | null = null
        let desktopSession: BrowserSession | null = null
        const edgeBrowsingController = new AbortController()
        let edgeBrowsingTask: Promise<void> | null = null
        let edgeBrowsingFinished = false

        const closeMobileSession = async (): Promise<void> => {
            const session = mobileSession
            if (!session) return
            mobileSession = null

            await executionContext.run({ isMobile: true, account }, async () => {
                await this.browser.func.checkpointActiveSession('PRE-BROWSER-CLOSE')
                await this.browser.func.closeBrowser(session.context, accountEmail)
            })
        }

        const closeDesktopSession = async (): Promise<void> => {
            const session = desktopSession
            if (!session) return
            desktopSession = null

            await executionContext.run({ isMobile: false, account }, async () => {
                await this.browser.func.checkpointActiveSession('PRE-BROWSER-CLOSE')
                await this.browser.func.closeBrowser(session.context, accountEmail)
            })
        }

        try {
            return await executionContext.run({ isMobile: true, account }, async () => {
                mobileSession = await this.browserFactory.createBrowser(account)
                const initialContext: BrowserContext = mobileSession.context
                this.mainMobilePage = await initialContext.newPage()

                this.logger.info('main', 'BROWSER', `移动浏览器已启动 | ${accountEmail}`)

                await this.login.login(this.mainMobilePage, account)

                if (needsAppAccessToken) {
                    try {
                        this.accessToken = await this.login.getAppAccessToken(this.mainMobilePage, accountEmail)
                    } catch (error) {
                        this.logger.error(
                            'main',
                            'FLOW',
                            `获取移动端访问令牌失败: ${error instanceof Error ? error.message : String(error)}`
                        )
                        this.accessToken = ''
                    }
                }

                await this.browser.func.checkpointActiveSession('LOGIN-CHECKPOINT')
                this.cookies.mobile = await initialContext.cookies()
                this.fingerprintMobile = mobileSession.fingerprint

                // 桌面会话预热：登录完立即保存并关闭，把需要人工批准的桌面登录
                // 挪到运行开头（紧跟移动端批准之后）；后续桌面阶段从 SQLite 恢复会话，不再触发批准
                const prewarmDesktop =
                    this.config.prewarmDesktopLogin &&
                    (this.config.workers.doPunchCards ||
                        this.config.workers.doVisualSearch ||
                        (this.config.workers.doDesktopSearch && !apiSearch))

                if (prewarmDesktop) {
                    try {
                        await executionContext.run({ isMobile: false, account }, async () => {
                            desktopSession = await this.createDesktopSession(account)
                        })
                        await closeDesktopSession()
                        this.logger.info(
                            'main',
                            'FLOW',
                            '桌面会话预热完成 | 后续桌面阶段将直接复用已保存会话'
                        )
                    } catch (error) {
                        this.logger.warn(
                            'main',
                            'FLOW',
                            `桌面会话预热失败，将在桌面阶段重试登录 | 原因=${
                                error instanceof Error ? error.message : String(error)
                            }`
                        )
                    }
                }

                if (fullApi) {
                    await closeMobileSession()
                    this.logger.info(
                        'main',
                        'FLOW',
                        '移动端登录浏览器已关闭；继续使用已保存的会话和 HTTP 请求'
                    )
                }

                const data: DashboardData = await this.browser.func.getDashboardData()
                const hasBotScoreWarning =
                    Array.isArray(data.dashboard.userWarnings) &&
                    data.dashboard.userWarnings.some(warning => warning?.name === 'Fraud_UserWarning_BotScore_UX')

                if (hasBotScoreWarning) {
                    const availablePoints = data.dashboard.userStatus.availablePoints ?? 0

                    if (!this.config.contintueOnBotWarning) {
                        this.logger.warn(
                            'main',
                            'BOT-WARNING',
                            `Microsoft Rewards 报告 ${accountEmail} 存在机器人评分警告（Fraud_UserWarning_BotScore_UX）。` +
                                '为安全起见将跳过该账户。建议暂停该账户的自动化并等待几天。' +
                                '如仍要继续（不推荐），可设置 "contintueOnBotWarning": true。'
                        )

                        return {
                            initialPoints: availablePoints,
                            collectedPoints: 0,
                            skippedForBotWarning: true
                        }
                    }

                    this.logger.warn(
                        'main',
                        'BOT-WARNING',
                        `Microsoft Rewards 报告 ${accountEmail} 存在机器人评分警告（Fraud_UserWarning_BotScore_UX），但 contintueOnBotWarning=true。` +
                            '按配置继续运行（不推荐）；等待几天才是首选做法。'
                    )
                }

                const profileCountry = normalizeCountry(data.dashboard.userProfile.attributes.country)

                if (account.geoLocale === 'auto') {
                    if (profileCountry) {
                        saveResolvedRegion(this.config.sessionPath, accountEmail, profileCountry)
                    } else {
                        this.logger.warn(
                            'main',
                            'GEO-LOCALE',
                            `Microsoft 个人资料返回了无效的国家/地区；保留 ${
                                this.accountLocale.country ?? 'US fallback'
                            }`
                        )
                    }
                }

                this.accountLocale = resolveAccountLocale(account, profileCountry ?? this.accountLocale.country)
                this.userData.langCode = this.accountLocale.language
                this.userData.geoLocale = this.accountLocale.country ?? 'US'
                this.http.setDefaultHeaders({
                    'Accept-Language': this.accountLocale.acceptLanguage
                })

                let appData: AppDashboardData | null = null

                if (this.accessToken && needsAppActivities) {
                    try {
                        appData = await this.browser.func.getAppDashboardData()
                    } catch (error) {
                        this.logger.warn(
                            'main',
                            'LOGIN-APP',
                            `App 仪表板不可用 - 本次运行将跳过 App 活动 | 信息=${error instanceof Error ? error.message : String(error)}`
                        )
                        this.accessToken = ''
                    }
                }

                // 基线只能来自可信的完整仪表板。走 flyout 兜底时拿到的是"部分仪表板"，
                // 里面的 availablePoints 可能是 0 —— 那不是"账号余额为 0"，而是"没读到"。
                // 之前这里直接采信、并把缺失兜成 0，于是差额被算成了整个余额：
                // 10-11 的 chuzheng973528 报出 +295（原余额 0、现余额 295），
                // 10-09 的 chanyuyiyan531256 报出 +320，都是这么来的。
                const baseline = data.dashboard.userStatus.availablePoints
                const baselineTrustworthy = !this.browser.func.usedFlyoutDashboardFallback()

                this.userData.initialPoints = baselineTrustworthy ? baseline : Number.NaN
                this.userData.currentPoints = baseline

                if (!baselineTrustworthy) {
                    this.logger.warn(
                        'main',
                        'FLOW',
                        `初始余额不可信（部分仪表板）| 读到=${baseline} | 本轮不报差额 | 账户=${accountEmail}`
                    )
                }

                const initialPoints = this.userData.initialPoints ?? Number.NaN

                const browserEarnable = await this.browser.func.getBrowserEarnablePoints(data)
                let appEarnable: AppEarnablePoints | null = null

                if (this.accessToken && needsAppActivities) {
                    try {
                        appEarnable = await this.browser.func.getAppEarnablePoints()
                    } catch (error) {
                        this.logger.warn(
                            'main',
                            'LOGIN-APP',
                            `App 可赚积分查询失败 - 本次运行将跳过 App 活动 | 信息=${error instanceof Error ? error.message : String(error)}`
                        )
                        this.accessToken = ''
                        appData = null
                    }
                }

                const appAvailable = Boolean(this.accessToken && appData)

                this.logger.info(
                    'main',
                    'POINTS',
                    `今日可赚取 | 移动端: ${browserEarnable.mobileSearchPoints} | 浏览器: ${
                        browserEarnable.desktopSearchPoints
                    } | App: ${appEarnable?.totalEarnablePoints ?? 0} | ${accountEmail} | locale: ${this.accountLocale.locale}`
                )

                const parallel = this.config.searchSettings.parallelSearching
                const doBonus = this.config.workers.doBonusSearches
                const doVisualSearch = this.config.workers.doVisualSearch

                let mobilePoints = 0
                let desktopPoints = 0
                let bonusPoints = 0

                if (this.config.experimental.edgeBrowsing) {
                    edgeBrowsingTask = this.activities
                        .doEdgeBrowsing(data, edgeBrowsingController.signal)
                        .catch(error => {
                            this.logger.error(
                                this.isMobile,
                                'EDGE-BROWSING',
                                `意外的后台任务失败 | 信息=${
                                    error instanceof Error ? error.message : String(error)
                                }`
                            )
                        })
                        .finally(() => {
                            edgeBrowsingFinished = true
                        })
                }

                if (fullApi) {
                    if (this.config.ensureStreakProtection) {
                        await this.activities.doEnsureStreakProtection()
                    }
                    if (this.config.workers.doPunchCards) {
                        await this.activities.doPunchCardsMobile(data)
                        await this.gapBetweenWorkers()
                    }
                    if (this.config.workers.doActivateSearchPerk) {
                        await this.activities.doActivateSearchPerk(data)
                        await this.gapBetweenWorkers()
                    }

                    const plan = await this.searchManager.getSearchPoints()
                    const doMobileSearch = plan.doMobile
                    const doDesktopSearch = plan.doDesktop
                    const desktopBrowserNeeded = this.config.workers.doPunchCards || doVisualSearch

                    if (doDesktopSearch && !desktopBrowserNeeded) {
                        this.cookies.desktop = [...this.cookies.mobile]
                        this.fingerprintDesktop = await this.browserFactory.generateFingerprint(false)
                    }

                    if (desktopBrowserNeeded) {
                        await executionContext.run({ isMobile: false, account }, async () => {
                            desktopSession = await this.createDesktopSession(account)
                            if (this.config.workers.doPunchCards) await this.activities.doPunchCardsDesktop()
                            if (doVisualSearch) await this.activities.doVisualSearch(data)
                        })
                        await closeDesktopSession()
                    }

                    if (this.config.workers.doDailySet) {
                        await this.activities.doDailySet(data)
                        await this.gapBetweenWorkers()
                    }
                    if (this.config.workers.doMorePromotions) {
                        await this.activities.doMorePromotions(data)
                        await this.gapBetweenWorkers()
                    }
                    if (appAvailable && this.config.workers.doDailyCheckIn) {
                        await this.activities.doDailyCheckIn()
                        await this.gapBetweenWorkers()
                    }
                    if (appAvailable && this.config.workers.doAppPromotions && appData) {
                        await this.activities.doAppPromotions(appData)
                        await this.gapBetweenWorkers()
                    }
                    if (appAvailable && this.config.workers.doReadToEarn) {
                        await this.activities.doReadToEarn()
                        await this.gapBetweenWorkers()
                    }

                    if (doMobileSearch) mobilePoints = await this.searchManager.searchMobile(account)
                    if (doBonus) bonusPoints = await this.searchManager.bonusMobile(account)
                    if (doDesktopSearch) desktopPoints = await this.searchManager.searchDesktop(account)
                } else {
                    if (this.config.ensureStreakProtection) {
                        await this.activities.doEnsureStreakProtection()
                    }
                    if (this.config.workers.doDailySet) {
                        await this.activities.doDailySet(data)
                        await this.gapBetweenWorkers()
                    }
                    if (this.config.workers.doActivateSearchPerk) {
                        await this.activities.doActivateSearchPerk(data)
                        await this.gapBetweenWorkers()
                    }
                    if (this.config.workers.doMorePromotions) {
                        await this.activities.doMorePromotions(data)
                        await this.gapBetweenWorkers()
                    }
                    if (appAvailable && this.config.workers.doDailyCheckIn) {
                        await this.activities.doDailyCheckIn()
                        await this.gapBetweenWorkers()
                    }
                    if (appAvailable && this.config.workers.doAppPromotions && appData) {
                        await this.activities.doAppPromotions(appData)
                        await this.gapBetweenWorkers()
                    }
                    if (appAvailable && this.config.workers.doReadToEarn) {
                        await this.activities.doReadToEarn()
                        await this.gapBetweenWorkers()
                    }
                    if (this.config.workers.doPunchCards) {
                        await this.activities.doPunchCardsMobile(data)
                        await this.gapBetweenWorkers()
                    }

                    const plan = await this.searchManager.getSearchPoints()
                    const doMobileSearch = plan.doMobile
                    const doDesktopSearch = plan.doDesktop

                    const desktopBrowserNeeded =
                        this.config.workers.doPunchCards || doVisualSearch || (doDesktopSearch && !apiSearch)

                    if (apiSearch && doDesktopSearch && !desktopBrowserNeeded) {
                        this.cookies.desktop = [...this.cookies.mobile]
                        this.fingerprintDesktop = await this.browserFactory.generateFingerprint(false)
                    }

                    if (parallel && !apiSearch && doMobileSearch && doDesktopSearch) {
                        await executionContext.run({ isMobile: false, account }, async () => {
                            desktopSession = await this.createDesktopSession(account)
                            if (this.config.workers.doPunchCards) await this.activities.doPunchCardsDesktop()
                            if (doVisualSearch) await this.activities.doVisualSearch(data)
                        })

                        const mobileWork = async (): Promise<[number, number]> => {
                            try {
                                const searchPoints = await this.searchManager.searchMobile(account)
                                const extraPoints = doBonus ? await this.searchManager.bonusMobile(account) : 0
                                return [searchPoints, extraPoints]
                            } finally {
                                await closeMobileSession()
                            }
                        }
                        const desktopWork = async (): Promise<number> => {
                            try {
                                return await this.searchManager.searchDesktop(account)
                            } finally {
                                await closeDesktopSession()
                            }
                        }

                        ;[[mobilePoints, bonusPoints], desktopPoints] = await Promise.all([mobileWork(), desktopWork()])
                    } else {
                        if (apiSearch) await closeMobileSession()

                        if (doMobileSearch) mobilePoints = await this.searchManager.searchMobile(account)
                        if (doBonus) bonusPoints = await this.searchManager.bonusMobile(account)

                        if (!apiSearch) await closeMobileSession()

                        if (desktopBrowserNeeded) {
                            await executionContext.run({ isMobile: false, account }, async () => {
                                desktopSession = await this.createDesktopSession(account)

                                if (this.config.workers.doPunchCards) await this.activities.doPunchCardsDesktop()
                                if (doVisualSearch) await this.activities.doVisualSearch(data)
                                if (doDesktopSearch && !apiSearch) {
                                    desktopPoints = await this.searchManager.searchDesktop(account)
                                }
                            })
                            await closeDesktopSession()
                        }

                        if (doDesktopSearch && apiSearch) {
                            desktopPoints = await this.searchManager.searchDesktop(account)
                        }
                    }
                }

                this.logger.info(
                    'main',
                    'SEARCH-MANAGER',
                    `搜索汇总 | 移动端=${mobilePoints} | 桌面端=${desktopPoints} | 额外=${bonusPoints} | 总计=${
                        mobilePoints + desktopPoints + bonusPoints
                    }`
                )

                if (this.config.workers.doClaimBonusPoints) {
                    await this.gapBetweenWorkers()
                    await this.activities.doClaimBonusPoints()
                }

                if (edgeBrowsingTask) {
                    if (!edgeBrowsingFinished) {
                        this.logger.info(
                            this.isMobile,
                            'EDGE-BROWSING',
                            '前台活动已完成；正在等待后台 Edge 浏览活动'
                        )
                    }
                    await edgeBrowsingTask
                    edgeBrowsingTask = null
                }

                // 末次余额读取是收尾动作，不是这一轮工作的成果本身。
                // 读失败时沿用最近一次真实读到的余额，而不是把整轮标记成失败。
                let finalPoints = this.userData.currentPoints ?? initialPoints

                try {
                    finalPoints = await this.browser.func.getCurrentPoints()
                } catch (error) {
                    this.logger.warn(
                        'main',
                        'FLOW',
                        `末次余额读取失败，沿用最近一次已知余额 | 余额=${finalPoints} | 账户=${accountEmail} | 信息=${
                            error instanceof Error ? error.message : String(error)
                        }`
                    )
                }

                // 基线不可信时不报差额：宁可在日志里说"不知道"，也不给出一个
                // 把整个余额当成当日产出的数字。
                if (!Number.isFinite(initialPoints)) {
                    this.logger.warn(
                        'main',
                        'FLOW',
                        `积分已收集（基线未知，不报差额） | 现余额=${finalPoints} | 账户=${accountEmail}`
                    )

                    return {
                        initialPoints: 0,
                        collectedPoints: 0
                    }
                }

                const collectedPoints = finalPoints - initialPoints

                this.logger.info(
                    'main',
                    'FLOW',
                    `积分已收集 | 获得积分=${collectedPoints} | 现余额=${finalPoints} | 账户=${accountEmail}`
                )

                return {
                    initialPoints,
                    collectedPoints: collectedPoints || 0
                }
            })
        } finally {
            if (edgeBrowsingTask) {
                edgeBrowsingController.abort()
                await edgeBrowsingTask
                edgeBrowsingTask = null
            }

            if (mobileSession) {
                try {
                    await closeMobileSession()
                } catch (error) {
                    this.logger.debug(
                        'main',
                        'CLEANUP',
                        `移动端上下文关闭失败 | ${error instanceof Error ? error.message : String(error)}`
                    )
                }
            }

            if (desktopSession) {
                try {
                    await closeDesktopSession()
                } catch (error) {
                    this.logger.debug(
                        'main',
                        'CLEANUP',
                        `桌面端上下文关闭失败 | ${error instanceof Error ? error.message : String(error)}`
                    )
                }
            }
        }
    }
}

export { executionContext }

async function main(): Promise<void> {
    checkNodeVersion()
    const rewardsBot = new MicrosoftRewardsBot()

    process.on('beforeExit', () => {
        void flushAllWebhooks()
    })
    process.on('SIGINT', async () => {
        rewardsBot.logger.warn('main', 'PROCESS', '收到 SIGINT 信号，正在刷新并退出...')
        await flushAllWebhooks()
        process.exit(130)
    })
    process.on('SIGTERM', async () => {
        rewardsBot.logger.warn('main', 'PROCESS', '收到 SIGTERM 信号，正在刷新并退出...')
        await flushAllWebhooks()
        process.exit(143)
    })
    process.on('uncaughtException', async error => {
        if (isBrowserClosedError(error)) {
            rewardsBot.logger.debug(
                'main',
                'UNCAUGHT-EXCEPTION',
                `忽略清理阶段良性的浏览器已关闭错误 | ${error instanceof Error ? error.message : String(error)}`
            )
            return
        }
        rewardsBot.logger.error('main', 'UNCAUGHT-EXCEPTION', error)
        await flushAllWebhooks()
        process.exit(1)
    })
    process.on('unhandledRejection', async reason => {
        if (isBrowserClosedError(reason)) {
            rewardsBot.logger.debug(
                'main',
                'UNHANDLED-REJECTION',
                `忽略清理阶段良性的浏览器已关闭拒绝 | ${reason instanceof Error ? reason.message : String(reason)}`
            )
            return
        }
        rewardsBot.logger.error('main', 'UNHANDLED-REJECTION', reason as Error)
        await flushAllWebhooks()
        process.exit(1)
    })

    try {
        await rewardsBot.initialize()
        await rewardsBot.run()
    } catch (error) {
        rewardsBot.logger.error('main', 'MAIN-ERROR', error as Error)
        await flushAllWebhooks()
        process.exitCode = 1
    }
}

main().catch(async error => {
    const tmpBot = new MicrosoftRewardsBot()
    tmpBot.logger.error('main', 'MAIN-ERROR', error as Error)
    await flushAllWebhooks()
    process.exit(1)
})
