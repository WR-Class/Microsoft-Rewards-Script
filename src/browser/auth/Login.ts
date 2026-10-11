import { URLs, REWARDS_BASE_URL } from '../../constants/urls'
import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../index'
import { saveStorageState } from '../../util/SessionStore'
import { unknownPageDiagnostic } from '../../util/ErrorDiagnostic'
import { configureMediaBlocking, suspendMediaBlocking } from '../MediaBlocker'

import { MobileAccessLogin } from './methods/MobileAccessLogin'
import { EmailLogin } from './methods/EmailLogin'
import { PasswordlessLogin } from './methods/PasswordlessLogin'
import { TotpLogin } from './methods/Totp2FALogin'
import { CodeLogin } from './methods/GetACodeLogin'
import { RecoveryLogin } from './methods/RecoveryEmailLogin'
import { canPromptForInput } from './methods/LoginUtils'

import type { Account } from '../../interface/Account'

type LoginState =
    | 'EMAIL_INPUT'
    | 'PASSWORD_INPUT'
    | 'FOOTER_ACTION'
    | 'SIGN_IN_METHOD_PICKER'
    | 'PASSKEY_ERROR'
    | 'PASSKEY_VIDEO'
    | 'KMSI_PROMPT'
    | 'LOGGED_IN'
    | 'EMAIL_VERIFICATION_INPUT'
    | 'RECOVERY_EMAIL_INPUT'
    | 'ACCOUNT_LOCKED'
    | 'ERROR_ALERT'
    | '2FA_TOTP'
    | 'LOGIN_PASSWORDLESS'
    | 'PASSWORDLESS_SEND_CODE'
    | 'OTP_CODE_ENTRY'
    | 'UNKNOWN'
    | 'CHROMEWEBDATA_ERROR'
    | 'ACCOUNT_ERROR_PAGE'

type SignInMethodOption = {
    index: number
    selector: string
    label: string
    signature: string
}

type SignInMethodType = 'PASSWORD' | 'AUTHENTICATOR' | 'EMAIL' | 'PASSKEY' | 'TOTP' | 'UNKNOWN'

export class Login {
    emailLogin: EmailLogin
    passwordlessLogin: PasswordlessLogin
    totp2FALogin: TotpLogin
    codeLogin: CodeLogin
    recoveryLogin: RecoveryLogin

    private readonly capturedUnknownUrls = new Set<string>()
    private signInMethodsLogged = false
    private passwordlessMethodSelected = false
    // How many email-code tiles this run has already tried on the sign-in method picker.
    // Some pages only reveal the password option one step later, behind one specific tile,
    // so the picker rotates through them instead of clicking the first one forever.
    private emailOptionsTried = 0

    private readonly selectors = {
        primaryButton: 'button[data-testid="primaryButton"]',
        secondaryButton: 'button[data-testid="secondaryButton"]',
        footerAction: '[data-testid="viewFooter"] [role="button"]',
        signInTile: '[data-testid="tile"]',
        emailIconOld: 'img[data-testid="accessibleImg"][src*="picker_verify_email"]',
        passwordlessOptionOld: 'img[data-testid="accessibleImg"][src*="picker_remote_ngc"]',
        recoveryEmail: '[data-testid="proof-confirmation"]',
        emailVerificationInput: 'input#proof-confirmation-email-input',
        accountLocked: '#serviceAbuseLandingTitle',
        // cookie 同意条 #wcpConsentBannerCtrl 自身就是 div[role="alert"]，而且实测是登录页上
        // 唯一的一个。不排除它，登录页每次都会被判成 ERROR_ALERT，同意条文案被当成登录错误。
        errorAlert: 'div[role="alert"]:not(#wcpConsentBannerCtrl)',
        passwordEntry: '[data-testid="passwordEntry"]',
        emailEntry: 'input#usernameEntry',
        kmsiVideo: '[data-testid="kmsiVideo"]',
        passKeyVideo: '[data-testid="biometricVideo"]',
        passKeyError: '[data-testid="registrationImg"]',
        passwordlessCheck: '[data-testid="deviceShieldCheckmarkVideo"]',
        passwordlessNumber: '[data-testid="displaySign"]',
        totpInput: 'input[name="otc"]',
        totpInputOld: 'form[name="OneTimeCodeViewForm"]',
        identityBanner: '[data-testid="identityBanner"]',
        otpCodeEntry: '[data-testid="codeEntry"]',
        backButton: '#back-button',
        bingProfile: '#id_n',
        otpInput: 'div[data-testid="codeEntry"]'
    } as const

    constructor(private bot: MicrosoftRewardsBot) {
        this.emailLogin = new EmailLogin(this.bot)
        this.passwordlessLogin = new PasswordlessLogin(this.bot)
        this.totp2FALogin = new TotpLogin(this.bot)
        this.codeLogin = new CodeLogin(this.bot)
        this.recoveryLogin = new RecoveryLogin(this.bot)
    }

    async login(page: Page, account: Account) {
        try {
            suspendMediaBlocking(this.bot, page.context())
            this.capturedUnknownUrls.clear()
            this.signInMethodsLogged = false
            this.passwordlessMethodSelected = false
            this.bot.logger.info(this.bot.isMobile, 'LOGIN', '开始登录流程')

            await page
                .goto(URLs.rewards.userLogin, {
                    waitUntil: 'domcontentloaded'
                })
                .catch(() => {})
            await this.bot.utils.wait(2000)
            await this.bot.browser.utils.reloadBadPage(page)
            await this.bot.browser.utils.disableFido(page)

            const maxIterations = 25
            let iteration = 0
            let previousState: LoginState = 'UNKNOWN'
            let sameStateCount = 0
            let reloadCount = 0

            while (iteration < maxIterations) {
                if (page.isClosed()) throw new Error('Page closed unexpectedly')

                iteration++
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `状态检查迭代 ${iteration}/${maxIterations}`)

                // cookie 同意条要主动关掉：它既可能挡住页面，自身又是个 div[role=alert]。
                // 只点它自己的"接受"按钮 —— tryDismissAllMessages 还会点主按钮，登录过程中不能用。
                const consentAccept = '#wcpConsentBannerCtrl > * > button:first-child'
                if (await this.checkSelector(page, consentAccept)) {
                    await this.tryClick(page, consentAccept, 'cookie 同意条接受')
                }

                const state = await this.detectCurrentState(page)
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `当前状态: ${state}`)

                if (state !== previousState && previousState !== 'UNKNOWN') {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', `状态转换: ${previousState} → ${state}`)
                }

                if (state === previousState && state !== 'LOGGED_IN' && state !== 'UNKNOWN') {
                    sameStateCount++
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'LOGIN',
                        `相同状态计数: ${sameStateCount}/4 状态为 "${state}"`
                    )
                    if (sameStateCount >= 4) {
                        reloadCount++
                        if (reloadCount > 2) {
                            throw new Error(
                                `状态 "${state}" 在刷新 ${reloadCount - 1} 次后仍未变化（URL: ${page.url()}），放弃重试`
                            )
                        }

                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'LOGIN',
                            `在状态 "${state}" 停滞4次循环，刷新页面（第 ${reloadCount}/2 次）`
                        )
                        await page.reload({ waitUntil: 'domcontentloaded' })
                        await this.bot.utils.wait(3000)
                        sameStateCount = 0
                        previousState = 'UNKNOWN'
                        continue
                    }
                } else {
                    sameStateCount = 0
                }
                previousState = state

                if (state === 'LOGGED_IN') {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '登录成功')
                    break
                }

                const shouldContinue = await this.handleState(state, page, account)
                if (!shouldContinue) {
                    throw new Error(`Login failed or aborted at state: ${state}`)
                }

                await this.bot.utils.wait(1000)
            }

            if (iteration >= maxIterations) {
                throw new Error('Login timeout: exceeded maximum iterations')
            }

            await this.finalizeLogin(page, account)
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN',
                `致命错误: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    private async detectCurrentState(page: Page): Promise<LoginState> {
        await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {})

        const url = new URL(page.url())
        const hostname = url.hostname.toLowerCase()
        this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', `当前URL: ${hostname}${url.pathname}`)

        if (hostname === 'chromewebdata') {
            this.bot.logger.warn(this.bot.isMobile, 'DETECT-STATE', '检测到chromewebdata错误页面')
            return 'CHROMEWEBDATA_ERROR'
        }

        // account.live.com/error.htm 是微软的账户错误页（账号被拦、需要验证、被锁等）。
        // 以前它认不出来 → UNKNOWN，而循环里 UNKNOWN 被排除在停滞检测之外（那是为了容忍
        // 瞬时未知状态），于是既不刷新也没有出口，一直转到 25 次迭代上限，最后抛一个
        // 没有任何信息量的"登录超时"。6 次登录超时（10-09 至 10-11）全部卡在这一页。
        if (hostname === 'account.live.com' && /^\/error/i.test(url.pathname)) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'DETECT-STATE',
                '检测到账户错误页 account.live.com/error.htm'
            )
            return 'ACCOUNT_ERROR_PAGE'
        }

        const isLocked = await this.checkSelector(page, this.selectors.accountLocked)
        if (isLocked) {
            this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', '账户锁定选择器被发现')
            return 'ACCOUNT_LOCKED'
        }

        if (hostname === 'bing.com' || hostname.endsWith('.bing.com') || hostname === 'account.microsoft.com') {
            this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', '在Bing/奖励/账户页面，假设已登录')
            return 'LOGGED_IN'
        }

        // Page/state selectors are checked together; page-specific routing is resolved below by priority
        const stateChecks: Array<[string, LoginState]> = [
            [this.selectors.errorAlert, 'ERROR_ALERT'],
            [this.selectors.passwordEntry, 'PASSWORD_INPUT'],
            [this.selectors.emailEntry, 'EMAIL_INPUT'],
            [this.selectors.recoveryEmail, 'RECOVERY_EMAIL_INPUT'],
            [this.selectors.emailVerificationInput, 'EMAIL_VERIFICATION_INPUT'],
            [this.selectors.kmsiVideo, 'KMSI_PROMPT'],
            [this.selectors.passKeyVideo, 'PASSKEY_VIDEO'],
            [this.selectors.passKeyError, 'PASSKEY_ERROR'],
            [this.selectors.signInTile, 'SIGN_IN_METHOD_PICKER'],
            [this.selectors.passwordlessOptionOld, 'SIGN_IN_METHOD_PICKER'],
            [this.selectors.emailIconOld, 'SIGN_IN_METHOD_PICKER'],
            [this.selectors.passwordlessCheck, 'LOGIN_PASSWORDLESS'],
            [this.selectors.passwordlessNumber, 'LOGIN_PASSWORDLESS'],
            [this.selectors.totpInput, '2FA_TOTP'],
            [this.selectors.totpInputOld, '2FA_TOTP'],
            [this.selectors.otpCodeEntry, 'OTP_CODE_ENTRY'],
            [this.selectors.otpInput, 'OTP_CODE_ENTRY']
        ]

        const [results, identityBanner, primaryButton, passwordEntry, footerAction, footerActionText] =
            await Promise.all([
                Promise.all(
                    stateChecks.map(async ([sel, state]) => {
                        const visible = await this.checkSelector(page, sel)
                        return visible ? state : null
                    })
                ),
                this.checkSelector(page, this.selectors.identityBanner),
                this.checkSelector(page, this.selectors.primaryButton),
                this.checkSelector(page, this.selectors.passwordEntry),
                this.checkSelector(page, this.selectors.footerAction),
                page
                    .locator(this.selectors.footerAction)
                    .first()
                    .innerText({ timeout: 200 })
                    .catch(() => '')
            ])

        const visibleStates = results.filter((s): s is LoginState => s !== null)
        if (visibleStates.length > 0) {
            this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', `可见状态: [${visibleStates.join(', ')}]`)
        }

        // Get a sign-in request - distinguish a generic methods footer from a direct email/phone fallback
        if (
            identityBanner &&
            primaryButton &&
            !passwordEntry &&
            !results.includes('2FA_TOTP') &&
            !results.includes('RECOVERY_EMAIL_INPUT') &&
            !results.includes('EMAIL_VERIFICATION_INPUT')
        ) {
            const normalizedFooterAction = this.normalizeSignInText(footerActionText)
            // 通过邮箱/掩码手机号正则区分通用方法入口与具体验证回退，不依赖本地化文案
            const footerTargetsSpecificProof =
                /[\w.+*-]+@[\w.*-]+\.[a-z]{2,}/i.test(normalizedFooterAction) ||
                /(?:\+?\d|[*xX])(?:[\d\s().*xX-]{4,})(?:\d|[*xX])/.test(normalizedFooterAction)

            if (footerAction && !footerTargetsSpecificProof && !this.passwordlessMethodSelected) {
                this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', '有可用的备选登录方式')
                results.push('FOOTER_ACTION')
            } else {
                if (footerAction && footerTargetsSpecificProof) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'DETECT-STATE',
                        '页脚指向具体验证方式；保持主登录方式'
                    )
                }
                this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', '检测到主无密码登录操作')
                results.push('PASSWORDLESS_SEND_CODE')
            }
        }

        let foundStates = results.filter((s): s is LoginState => s !== null)

        if (foundStates.length === 0) {
            this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', '未找到匹配的状态')
            return 'UNKNOWN'
        }

        if (foundStates.includes('ERROR_ALERT')) {
            const errorIsReal = hostname === 'login.live.com' && !foundStates.includes('2FA_TOTP')
            this.bot.logger.debug(
                this.bot.isMobile,
                'DETECT-STATE',
                `发现ERROR_ALERT - 主机名: ${hostname}, 有2FA: ${foundStates.includes('2FA_TOTP')}, 视为真实错误: ${errorIsReal}`
            )
            if (errorIsReal) return 'ERROR_ALERT'
            foundStates = foundStates.filter(s => s !== 'ERROR_ALERT')
        }

        const priorities: LoginState[] = [
            'ACCOUNT_LOCKED',
            'PASSKEY_VIDEO',
            'PASSKEY_ERROR',
            'KMSI_PROMPT',
            'LOGIN_PASSWORDLESS',
            'PASSWORD_INPUT',
            'EMAIL_INPUT',
            'EMAIL_VERIFICATION_INPUT',
            'RECOVERY_EMAIL_INPUT',
            'SIGN_IN_METHOD_PICKER',
            'OTP_CODE_ENTRY',
            'FOOTER_ACTION',
            'PASSWORDLESS_SEND_CODE',
            '2FA_TOTP'
        ]

        for (const priority of priorities) {
            if (foundStates.includes(priority)) {
                this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', `按优先级选择状态: ${priority}`)
                return priority
            }
        }

        this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', `返回第一个找到的状态: ${foundStates[0]}`)
        return foundStates[0] as LoginState
    }

    private async checkSelector(page: Page, selector: string): Promise<boolean> {
        return page
            .waitForSelector(selector, { state: 'visible', timeout: 5000 })
            .then(() => true)
            .catch(() => false)
    }

    /**
     * 读出微软账户错误页自己写的文案，让日志里出现的是"账号被锁 / 需要验证"这类原因，
     * 而不是一个没有信息量的"登录超时"。
     */
    private async readAccountErrorPage(page: Page): Promise<string> {
        const candidates = ['#iPageTitle', 'h1', '[role="heading"]', '.errorText', 'body']

        for (const selector of candidates) {
            const text = (await page.locator(selector).first().innerText({ timeout: 2000 }).catch(() => ''))
                .replace(/\s+/g, ' ')
                .trim()
            if (text) return text.slice(0, 200)
        }

        return '页面未提供可读文案'
    }

    private normalizeSignInText(value: string): string {
        return value.replace(/\s+/g, ' ').trim()
    }

    private sanitizeSignInLabel(value: string): string {
        return this.normalizeSignInText(value)
            .replace(/[\w.+*-]+@[\w.-]+\.[a-z]{2,}/gi, '<email>')
            .replace(/\+?\d[\d\s().*-]{5,}\d/g, '<phone>')
    }

    private async getSignInMethodOptions(page: Page): Promise<SignInMethodOption[]> {
        const tiles = page.locator(this.selectors.signInTile)
        const count = await tiles.count().catch(() => 0)
        const options = await Promise.all(
            Array.from({ length: count }, async (_, index): Promise<SignInMethodOption | null> => {
                const tile = tiles.nth(index)
                if (!(await tile.isVisible().catch(() => false))) return null

                const metadata = await tile
                    .evaluate(element => {
                        const elements = [element, ...Array.from(element.querySelectorAll('*'))]
                        const structuralAttributeNames = new Set([
                            'id',
                            'name',
                            'src',
                            'data-testid',
                            'data-value',
                            'data-bind',
                            'd'
                        ])
                        const accessibleText = elements
                            .flatMap(node => ['aria-label', 'title', 'alt'].map(name => node.getAttribute(name) ?? ''))
                            .filter(Boolean)
                            .join(' ')
                        const structuralAttributes = elements
                            .flatMap(node =>
                                Array.from(node.attributes)
                                    .filter(attribute => structuralAttributeNames.has(attribute.name))
                                    .map(attribute => `${attribute.name}=${attribute.value}`)
                            )
                            .join(' ')

                        return {
                            text: element.textContent ?? '',
                            accessibleText,
                            structuralAttributes
                        }
                    })
                    .catch(() => null)

                if (!metadata) return null

                const label = this.normalizeSignInText(`${metadata.text} ${metadata.accessibleText}`)
                const signature = this.normalizeSignInText(metadata.structuralAttributes).toLowerCase()

                return {
                    index,
                    selector: `${this.selectors.signInTile} >> nth=${index}`,
                    label: label || `Sign-in option ${index + 1}`,
                    signature
                }
            })
        )

        return options.filter((option): option is SignInMethodOption => option !== null)
    }

    private classifySignInMethod(option: SignInMethodOption): SignInMethodType {
        const signature = option.signature

        // Sign in another way - classify method tiles from structural signatures, not translated labels
        if (signature.includes('m5.25 4h13.5a3.25') || signature.includes('picker_verify_email')) return 'EMAIL'
        if (signature.includes('m11.78 10.22a.75')) return 'PASSWORD'
        // Known passkey/security-key SVG signature keeps it out of the Authenticator fallback
        if (/picker_fido|passkey|fido|m18 16\.66a3\.51/.test(signature)) return 'PASSKEY'
        if (/phone[\s_-]*app[\s_-]*otp|\btotp\b/.test(signature)) return 'TOTP'
        // Known Remote NGC/mobile-app SVG signature identifies Microsoft Authenticator language-independently
        if (
            /remote[\s_-]*ngc|picker_remote_ngc|phone[\s_-]*app[\s_-]*notification|push[\s_-]*notification|m15\.75 2c16\.99 2 18 3/.test(
                signature
            )
        ) {
            return 'AUTHENTICATOR'
        }

        return 'UNKNOWN'
    }

    private async clickSignInMethodOption(page: Page, option: SignInMethodOption): Promise<boolean> {
        const ghostClicked = await this.bot.browser.utils.ghostClick(page, option.selector)
        if (ghostClicked) return true

        return page
            .locator(this.selectors.signInTile)
            .nth(option.index)
            .click()
            .then(() => true)
            .catch(() => false)
    }

    // The primary action ("是" / "Yes" / continue) has changed markup more than once,
    // and ghostClick resolves through ghost-cursor, which queries with
    // document.querySelector and therefore cannot see inside an open shadow root.
    // Candidate 0 is always the selector this flow used before, so a page that
    // already works keeps working and the rest only widen what can be matched.
    //
    // Order matters on the KMSI page, which has both buttons: an exact-text match
    // for "是" comes before button[type="submit"], because picking the wrong one
    // there answers "否" and ends the sign-in entirely (observed by hand).
    private static readonly primaryButtonCandidates = [
        'button[data-testid="primaryButton"]',
        '#idSIButton9',
        'button:text-is("是")',
        'button:text-is("Yes")',
        'button[type="submit"]',
        'input[type="submit"]'
    ]

    private async clickPrimaryButton(page: Page, note: string): Promise<boolean> {
        for (const selector of Login.primaryButtonCandidates) {
            if (await this.bot.browser.utils.ghostClick(page, selector)) {
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `主按钮已点击: ${selector} (${note})`)
                return true
            }

            // A locator pierces open shadow roots where the ghost cursor cannot.
            const clicked = await page
                .locator(selector)
                .first()
                .click({ timeout: 2000 })
                .then(() => true)
                .catch(() => false)

            if (clicked) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN',
                    `主按钮已点击(locator): ${selector} (${note})`
                )
                return true
            }
        }

        return false
    }

    /**
     * KMSI 是否已经过去。点"是"会离开 login.live.com，所以先看域名：还留在登录域上时，
     * 再看那个用来识别 KMSI 的视频元素是否也消失了。给它几秒钟等跳转，超时不算失败。
     *
     * 为什么需要这个：ghostClick 用 elementHandle.evaluate 判断点击成功，而导航会销毁
     * 那个 evaluate —— 一次成功的点击于是被读成失败。11:38:43 与 14:24:19 两次 KMSI
     * 致命错误的页面转储标题都是 "Dashboard – Microsoft Rewards"，即程序宣布失败时
     * 它已经登录成功了。
     */
    private async hasLeftKmsiPrompt(page: Page): Promise<boolean> {
        const deadline = Date.now() + 5000

        while (Date.now() < deadline) {
            if (!page.url().includes('login.live.com')) return true
            if (!(await this.checkSelector(page, this.selectors.kmsiVideo))) return true
            await this.bot.utils.wait(500)
        }

        return false
    }

    private logAvailableSignInMethods(options: SignInMethodOption[]): void {
        if (this.signInMethodsLogged) return
        this.signInMethodsLogged = true
        if (options.length === 0) return

        const labels = options.map(option => this.sanitizeSignInLabel(option.label))
        this.bot.logger.info(this.bot.isMobile, 'LOGIN', `可用的登录方式: ${labels.join(' | ')}`)
    }

    private async waitForIdle(page: Page, note: string, timeout = 5000): Promise<void> {
        await page.waitForLoadState('networkidle', { timeout }).catch(() => {
            this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `网络空闲超时: ${note}`)
        })
    }

    private async tryClick(page: Page, selector: string, label: string, timeout = 2000): Promise<boolean> {
        const found = await page.waitForSelector(selector, { state: 'visible', timeout }).catch(() => null)
        if (!found) return false

        const clicked = await this.bot.browser.utils.ghostClick(page, selector)
        if (!clicked) return false

        await this.waitForIdle(page, `after ${label}`)
        this.bot.logger.info(this.bot.isMobile, 'LOGIN', `${label} 已点击`)
        return true
    }

    private async handleState(state: LoginState, page: Page, account: Account): Promise<boolean> {
        this.bot.logger.debug(this.bot.isMobile, 'HANDLE-STATE', `处理状态: ${state}`)

        switch (state) {
            case 'ACCOUNT_LOCKED': {
                const msg = 'This account has been locked! Remove from config and restart!'
                this.bot.logger.error(this.bot.isMobile, 'LOGIN', msg)
                throw new Error(msg)
            }

            case 'ERROR_ALERT': {
                // 页面上可能同时存在多个 role=alert 容器（含跳转瞬间的空 aria-live 区域），
                // 只有携带非空文本的才是真实错误
                const alertEls = page.locator(this.selectors.errorAlert)
                const alertCount = await alertEls.count()
                let errorMsg = ''
                for (let i = 0; i < alertCount; i++) {
                    const text = (await alertEls.nth(i).innerText().catch(() => '')).trim()
                    if (text) {
                        errorMsg = text
                        break
                    }
                }
                // 空文本、以及 cookie 同意条文案，都不算登录错误（选择器里的 :not 是主防线，
                // 这里兜住同意条 id 改名的情况）
                if (!errorMsg || /optional cookies|Privacy Statement|Manage Cookies/i.test(errorMsg)) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN',
                        '告警容器无文本或是 cookie 同意条，视为瞬时状态，稍后重新检测'
                    )
                    await this.bot.utils.wait(2000)
                    return true
                }
                this.bot.logger.error(this.bot.isMobile, 'LOGIN', `账户错误: ${errorMsg}`)
                throw new Error(`Microsoft login error: ${errorMsg}`)
            }

            // 微软账户错误页：这是终点，不是可以重试的中间状态
            case 'ACCOUNT_ERROR_PAGE': {
                const detail = await this.readAccountErrorPage(page)
                this.bot.logger.error(
                    this.bot.isMobile,
                    'LOGIN',
                    `账户错误页：${detail} —— 该账号需要在真实浏览器里处理，本轮跳过`
                )
                throw new Error(`账户错误页: ${detail}`)
            }

            case 'LOGGED_IN':
                return true

            case 'EMAIL_INPUT': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '输入邮箱')
                const result = await this.emailLogin.enterEmail(page, account.email)
                if (result !== 'ok') return false
                await this.waitForIdle(page, 'after email entry')
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '邮箱输入成功')
                return true
            }

            // Enter password - use it only when Microsoft actually presents the password page
            case 'PASSWORD_INPUT': {
                if (!account.password) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'LOGIN',
                        '检测到密码输入页但未配置密码；返回登录方式选择'
                    )
                    if (await this.tryClick(page, this.selectors.backButton, 'Back button')) return true

                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '未配置密码且无法返回登录方式选择')
                    return false
                }

                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '输入密码')
                const result = await this.emailLogin.enterPassword(page, account.password)
                if (result === 'error') return false
                await this.waitForIdle(page, 'after password entry')
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '密码输入成功')
                return true
            }

            // 通用备选方式页脚 - 先打开方式选择器再选择凭据
            case 'FOOTER_ACTION': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '打开备选登录方式')
                const clicked = await this.bot.browser.utils.ghostClick(page, this.selectors.footerAction)
                if (!clicked) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '无法打开备选登录方式')
                    return false
                }
                this.passwordlessMethodSelected = false
                await this.waitForIdle(page, 'after sign-in footer action')
                return true
            }

            // Get a sign-in request - keep the primary Authenticator action when footer is a proof fallback
            case 'PASSWORDLESS_SEND_CODE': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '继续使用主要登录方式')
                const clicked = await this.clickPrimaryButton(page, 'PASSWORDLESS_SEND_CODE')
                if (!clicked) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '无法继续使用主要登录方式')
                    return false
                }
                await this.waitForIdle(page, 'after primary sign-in action')
                return true
            }

            // 其他登录方式 - 优先密码，其次Authenticator，最后交互式邮箱验证码
            case 'SIGN_IN_METHOD_PICKER': {
                const options = await this.getSignInMethodOptions(page)
                this.logAvailableSignInMethods(options)

                const methods = options.map(option => ({ option, type: this.classifySignInMethod(option) }))
                const passwordOption = methods.find(method => method.type === 'PASSWORD')?.option
                const authenticatorOption = methods.find(method => method.type === 'AUTHENTICATOR')?.option
                const emailOptions = methods
                    .filter(method => method.type === 'EMAIL')
                    .map(method => method.option)
                const emailOption = emailOptions[0]

                if (account.password && passwordOption) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '密码登录可用；正在选择')
                    this.passwordlessMethodSelected = false

                    if (!(await this.clickSignInMethodOption(page, passwordOption))) {
                        this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '无法选择密码登录方式')
                        return false
                    }

                    await this.waitForIdle(page, 'after password method selection')
                    return true
                }

                const passwordlessOptionOldFound = await this.checkSelector(page, this.selectors.passwordlessOptionOld)
                if (authenticatorOption || passwordlessOptionOldFound) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '选择Microsoft Authenticator登录')
                    this.passwordlessMethodSelected = true

                    const clicked = authenticatorOption
                        ? await this.clickSignInMethodOption(page, authenticatorOption)
                        : await this.bot.browser.utils.ghostClick(page, this.selectors.passwordlessOptionOld)

                    if (!clicked) {
                        this.passwordlessMethodSelected = false
                        this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '无法选择Microsoft Authenticator')
                        return false
                    }

                    await this.waitForIdle(page, 'after Microsoft Authenticator selection')

                    const passwordlessChallengeVisible =
                        (await this.checkSelector(page, this.selectors.passwordlessCheck)) ||
                        (await this.checkSelector(page, this.selectors.passwordlessNumber))

                    if (
                        !passwordlessChallengeVisible &&
                        (await this.checkSelector(page, this.selectors.primaryButton))
                    ) {
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN', '正在发送Microsoft Authenticator请求')
                        const confirmed = await this.clickPrimaryButton(
                            page,
                            'Microsoft Authenticator request'
                        )
                        if (!confirmed) {
                            this.passwordlessMethodSelected = false
                            this.bot.logger.warn(
                                this.bot.isMobile,
                                'LOGIN',
                                '无法发送Microsoft Authenticator请求'
                            )
                            return false
                        }
                        await this.waitForIdle(page, 'after Microsoft Authenticator request')
                    }

                    return true
                }

                const emailIconOldFound = await this.checkSelector(page, this.selectors.emailIconOld)
                if (emailOption || emailIconOldFound) {
                    const interactive = canPromptForInput()
                    // Without a terminal the code cannot be typed - but giving up here is wrong:
                    // the operator confirmed by hand that the security-email tile leads to a page
                    // where signing in with a password is offered. So click the tile and let the
                    // state loop re-detect; only the code entry itself needs the terminal.
                    // A page that keeps showing this picker rotates to the next email tile, and the
                    // loop's own stagnation detector bounds the attempts.
                    const tileCount = Math.max(emailOptions.length, 1)
                    const tilePosition = (this.emailOptionsTried % tileCount) + 1
                    const emailTile = emailOptions.length
                        ? emailOptions[this.emailOptionsTried % emailOptions.length]
                        : undefined

                    if (interactive) {
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN', '选择邮箱验证码登录')
                    } else {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'LOGIN',
                            `无交互终端：仍点击邮箱验证方式（第 ${tilePosition}/${tileCount} 个），先进入下一层再找密码登录`
                        )
                    }

                    this.passwordlessMethodSelected = false

                    const clicked = emailTile
                        ? await this.clickSignInMethodOption(page, emailTile)
                        : await this.bot.browser.utils.ghostClick(page, this.selectors.emailIconOld)

                    if (!clicked) {
                        this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '无法选择邮箱验证码登录方式')
                        return false
                    }

                    this.emailOptionsTried++
                    await this.waitForIdle(page, 'after email method selection')

                    if (!interactive) return true

                    await this.codeLogin.handle(page)
                    return true
                }

                const ignoredMethods = methods
                    .map(method => method.type)
                    .filter(type => type === 'PASSKEY' || type === 'TOTP' || type === 'UNKNOWN')

                this.bot.logger.error(
                    this.bot.isMobile,
                    'LOGIN',
                    `没有可用的受支持登录方式${ignoredMethods.length ? `；已忽略=${ignoredMethods.join(',')}` : ''}`
                )
                return false
            }

            // Recovery email confirmation
            case 'RECOVERY_EMAIL_INPUT': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '检测到恢复邮箱输入')
                await this.waitForIdle(page, 'on recovery page')
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '启动恢复邮箱处理器')
                await this.recoveryLogin.handle(page, account?.recoveryEmail)
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '恢复邮箱处理器完成')
                return true
            }

            // Verify your email - identical footer actions are validated by their resulting state, not position
            case 'EMAIL_VERIFICATION_INPUT': {
                if (!account.password) {
                    if (!canPromptForInput()) {
                        // Name the FIX, not just the symptom. This account reached the
                        // "verify your email" page and has no password, no recovery address and
                        // no interactive terminal, so nothing in this process can clear it:
                        // a live account lost its whole run to exactly this, and the old
                        // message ("邮箱验证需要已配置的密码或交互式终端输入") did not say which
                        // of the three to supply.
                        this.bot.logger.error(
                            this.bot.isMobile,
                            'LOGIN',
                            `该账号触发了邮箱验证码，但既没配置密码、也没有恢复邮箱，当前运行又没有交互式终端可输入；` +
                                `本轮跳过 ${account?.email ?? ''}（人工登录该账号一次，或在 .env 里补上它的密码）`
                        )
                        return false
                    }

                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '检测到邮箱验证输入')
                    await this.codeLogin.handle(page)
                    return true
                }

                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN',
                    '检测到邮箱验证输入；正在检查备选方式'
                )
                await this.waitForIdle(page, 'on email verification page')

                const footerActions = page.locator(this.selectors.footerAction)
                const footerCount = await footerActions.count().catch(() => 0)

                for (let index = 0; index < footerCount; index++) {
                    const selector = `${this.selectors.footerAction} >> nth=${index}`
                    if (
                        !(await footerActions
                            .nth(index)
                            .isVisible()
                            .catch(() => false))
                    )
                        continue
                    if (!(await this.bot.browser.utils.ghostClick(page, selector))) continue

                    await this.waitForIdle(page, 'after email verification alternative')

                    if (await this.checkSelector(page, this.selectors.passwordEntry)) {
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN', '已选择密码登录选项')
                        return true
                    }

                    if (await this.checkSelector(page, this.selectors.signInTile)) {
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN', '已打开登录方式选择器')
                        return true
                    }

                    if (!(await this.tryClick(page, this.selectors.backButton, 'Back button'))) break
                    if (!(await this.checkSelector(page, this.selectors.emailVerificationInput))) break
                }

                if (canPromptForInput()) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '回退到交互式邮箱验证')
                    await this.codeLogin.handle(page)
                    return true
                }

                this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '未找到可用的邮箱验证备选方式')
                return false
            }

            case 'CHROMEWEBDATA_ERROR': {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '检测到chromewebdata错误，尝试恢复')
                try {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', `导航到 ${REWARDS_BASE_URL}`)
                    await page
                        .goto(REWARDS_BASE_URL, {
                            waitUntil: 'domcontentloaded',
                            timeout: 10000
                        })
                        .catch(() => {})
                    await this.bot.utils.wait(3000)
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '恢复导航成功')
                    return true
                } catch {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '回退到login.live.com')
                    await page
                        .goto(URLs.auth.loginLive, {
                            waitUntil: 'domcontentloaded',
                            timeout: 10000
                        })
                        .catch(() => {})
                    await this.bot.utils.wait(3000)
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '回退导航成功')
                    return true
                }
            }

            case '2FA_TOTP': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '需要TOTP双因素认证')
                await this.totp2FALogin.handle(page, account.totpSecret)
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'TOTP双因素认证处理器完成')
                return true
            }

            // 保持登录 / KMSI 确认
            case 'KMSI_PROMPT': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '接受KMSI提示')
                const clicked = await this.clickPrimaryButton(page, 'KMSI')

                if (!clicked) {
                    // 点击报失败不等于没点中：点"是"会让页面跳走，而成功信号在导航中被销毁。
                    // 先回头看一眼 KMSI 是不是已经过去，过去了就按接受处理，而不是判登录失败。
                    if (await this.hasLeftKmsiPrompt(page)) {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'LOGIN',
                            'KMSI 提示已消失（点击触发了跳转），按接受处理'
                        )
                        await this.waitForIdle(page, 'after KMSI acceptance')
                        return true
                    }

                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '无法接受KMSI提示')
                    return false
                }

                await this.waitForIdle(page, 'after KMSI acceptance')
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'KMSI提示已接受')
                return true
            }

            // Passkey prompt/error - skip back to a supported sign-in method
            case 'PASSKEY_VIDEO':
            case 'PASSKEY_ERROR': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '跳过Passkey提示')
                const clicked = await this.bot.browser.utils.ghostClick(page, this.selectors.secondaryButton)
                if (!clicked) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '无法跳过Passkey提示')
                    return false
                }
                await this.waitForIdle(page, 'after Passkey skip')
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Passkey提示已跳过')
                return true
            }

            // Microsoft Authenticator approval/number challenge
            case 'LOGIN_PASSWORDLESS': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '处理无密码认证')
                await this.passwordlessLogin.handle(page)
                this.passwordlessMethodSelected = false
                await this.waitForIdle(page, 'after passwordless auth')
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '无密码认证完成')
                return true
            }

            // Enter your code - prefer its alternate-method footer before Back to avoid an email-code loop
            case 'OTP_CODE_ENTRY': {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN',
                    '检测到OTP代码输入页面；尝试可用的备选登录方式'
                )

                if (await this.checkSelector(page, this.selectors.footerAction)) {
                    const clicked = await this.bot.browser.utils.ghostClick(page, this.selectors.footerAction)
                    if (clicked) {
                        await this.waitForIdle(page, 'after OTP alternative sign-in action')

                        const stillOnOtp = await this.checkSelector(page, this.selectors.otpCodeEntry)
                        if (!stillOnOtp) {
                            const methodPickerVisible =
                                (await this.checkSelector(page, this.selectors.signInTile)) ||
                                (await this.checkSelector(page, this.selectors.passwordlessOptionOld)) ||
                                (await this.checkSelector(page, this.selectors.emailIconOld))
                            const passwordlessLandingVisible =
                                (await this.checkSelector(page, this.selectors.passwordlessCheck)) ||
                                (await this.checkSelector(page, this.selectors.passwordlessNumber)) ||
                                ((await this.checkSelector(page, this.selectors.identityBanner)) &&
                                    (await this.checkSelector(page, this.selectors.primaryButton)))

                            this.passwordlessMethodSelected = passwordlessLandingVisible
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'LOGIN',
                                methodPickerVisible
                                    ? '已返回登录方式选择'
                                    : passwordlessLandingVisible
                                      ? '已切换到Microsoft Authenticator登录'
                                      : '已离开邮箱验证码登录'
                            )
                            return true
                        }

                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'LOGIN',
                            'OTP页脚操作未离开代码输入页；回退到返回按钮'
                        )
                    }
                }

                this.passwordlessMethodSelected = false
                if (!(await this.tryClick(page, this.selectors.backButton, 'Back button'))) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'OTP页面上没有可用的备选操作')
                    return false
                }

                return true
            }

            // Unknown page - keep diagnostics useful instead of guessing a sign-in action
            case 'UNKNOWN': {
                const rawUrl = page.url()
                const url = new URL(rawUrl)

                // 身份验证挑战页（"Help us protect your account / We've detected something unusual
                // about this sign-in"）：需要人工从恢复邮箱收验证码，机器人无法自行完成。
                // 必须立刻失败并给出可执行提示 —— 之前这里只打 warn 就继续，实测空转 22 次、4 分钟，
                // 最后抛 "Login timeout"，把整个账号（含桌面端）一起废掉。
                if (url.hostname === 'account.live.com' && url.pathname.includes('/identity/confirm')) {
                    this.bot.logger.error(
                        this.bot.isMobile,
                        'LOGIN',
                        `该账号被微软判定为异常登录，需人工用该账号的恢复邮箱收验证码确认一次；本轮跳过 ${
                            account?.email ?? ''
                        }`
                    )
                    return false
                }

                // FIDO / passkey 创建引导页（login.microsoft.com/consumers/fido/*）：
                // 机器人无法完成 passkey 注册，但这一页通常可以直接关掉。
                // 之前它落到下面的通用 warn 分支，一路空转到迭代上限（实测 25 轮 ≈ 2.5 分钟），
                // 然后抛 "Login timeout"，把整个账号连同已完成的桌面端一起废掉。
                if (url.hostname === 'login.microsoft.com' && url.pathname.includes('/consumers/fido/')) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN',
                        `命中 FIDO/passkey 页面（${url.pathname}），先尝试关闭再继续`
                    )

                    const dismissTargets: Array<[string, string]> = [
                        [this.selectors.secondaryButton, 'FIDO 次要按钮（暂不/取消）'],
                        [this.selectors.footerAction, 'FIDO 页脚操作'],
                        [this.selectors.backButton, 'FIDO 返回按钮']
                    ]

                    for (const [selector, label] of dismissTargets) {
                        if (!(await this.tryClick(page, selector, label))) continue

                        await this.bot.utils.wait(2000)
                        if (!page.url().includes('/consumers/fido/')) {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'LOGIN',
                                `已离开 FIDO 页面，继续登录流程 | 当前=${page.url()}`
                            )
                            return true
                        }
                    }

                    this.bot.logger.error(
                        this.bot.isMobile,
                        'LOGIN',
                        `FIDO/passkey 创建页无法自动关闭（${url.pathname}）：该账号需要在真实浏览器里手动跳过/关闭一次 passkey 引导；本轮跳过 ${
                            account?.email ?? ''
                        }`
                    )
                    return false
                }

                this.bot.logger.warn(
                    this.bot.isMobile,
                    'LOGIN',
                    `在 ${url.hostname}${url.pathname} 的未知状态，等待中`
                )

                if (this.bot.config.errorDiagnostics && !this.capturedUnknownUrls.has(rawUrl)) {
                    this.capturedUnknownUrls.add(rawUrl)
                    await unknownPageDiagnostic(page, {
                        platform: this.bot.isMobile ? 'mobile' : 'desktop'
                    })
                }
                return true
            }

            default:
                this.bot.logger.debug(this.bot.isMobile, 'HANDLE-STATE', `未处理的状态: ${state}，继续执行`)
                return true
        }
    }

    private async finalizeLogin(page: Page, account: Account) {
        this.bot.logger.info(this.bot.isMobile, 'LOGIN', '完成登录')

        await page.goto(REWARDS_BASE_URL, { waitUntil: 'networkidle', timeout: 10000 }).catch(() => {})

        const rewardsLanding = new URL(page.url())
        const rewardsHostname = rewardsLanding.hostname.toLowerCase()
        const loginRewardsSuccess = rewardsHostname === 'bing.com' || rewardsHostname.endsWith('.bing.com')
        if (loginRewardsSuccess) {
            if (rewardsHostname === 'rewards.bing.com') {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '成功登录Microsoft Rewards')
            } else {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN',
                    `Rewards登录重定向到Bing主页 (${rewardsHostname})；继续验证`
                )
            }
        } else {
            this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '无法验证奖励仪表板，假定登录有效')
        }

        // Dismiss at rewards dashboard
        await this.bot.browser.utils.tryDismissAllMessages(page).catch(() => {})

        this.bot.logger.info(this.bot.isMobile, 'LOGIN', '开始Bing会话验证')
        await this.verifyBingSession(page, account)

        this.bot.logger.info(this.bot.isMobile, 'LOGIN', '获取奖励上下文')
        await this.getRewardsSession(page)

        const context = page.context()
        const storageState = await context.storageState()
        this.bot.logger.debug(
            this.bot.isMobile,
            'LOGIN',
            `保存会话 | cookies=${storageState.cookies.length} | origins=${storageState.origins.length}`
        )
        saveStorageState(this.bot.config.sessionPath, account.email, this.bot.isMobile, storageState)

        await configureMediaBlocking(this.bot, context)
        this.bot.logger.info(this.bot.isMobile, 'LOGIN', '登录完成，会话已保存')
    }

    async verifyBingSession(page: Page, account: Account) {
        const url = URLs.auth.bingSignIn
        const loopMax = 5

        this.bot.logger.info(this.bot.isMobile, 'LOGIN-BING', '验证Bing会话')

        try {
            await page.goto(url, { waitUntil: 'networkidle', timeout: 10000 }).catch(() => {})

            for (let i = 0; i < loopMax; i++) {
                if (page.isClosed()) break

                this.bot.logger.debug(this.bot.isMobile, 'LOGIN-BING', `验证循环 ${i + 1}/${loopMax}`)

                const u = new URL(page.url())
                const hostname = u.hostname.toLowerCase()
                const atBingPage =
                    (hostname === 'bing.com' || hostname.endsWith('.bing.com')) && hostname !== 'rewards.bing.com'
                if (!atBingPage) {
                    const state = await this.detectCurrentState(page)
                    if (state === 'PASSKEY_ERROR') {
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN-BING', '关闭Passkey错误状态')
                        await this.bot.browser.utils.ghostClick(page, this.selectors.secondaryButton)
                    }

                    await this.handleState(state, page, account)
                }

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'LOGIN-BING',
                    `在Bing页面: ${atBingPage} (${hostname}${u.pathname})`
                )

                if (atBingPage) {
                    await this.bot.browser.utils.tryDismissAllMessages(page).catch(() => {})

                    const signedIn = await page
                        .waitForSelector(this.selectors.bingProfile, { timeout: 3000 })
                        .then(() => true)
                        .catch(() => false)

                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN-BING', `找到个人资料元素: ${signedIn}`)

                    if (signedIn || this.bot.isMobile) {
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN-BING', 'Bing会话验证成功')
                        return
                    }
                }

                await this.bot.utils.wait(1000)
            }

            this.bot.logger.warn(this.bot.isMobile, 'LOGIN-BING', '无法验证Bing会话，继续执行')
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN-BING',
                `验证错误: ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async getRewardsSession(page: Page) {
        this.bot.logger.info(this.bot.isMobile, 'GET-REWARD-SESSION', '引导奖励上下文')

        try {
            await this.bot.browser.func.bootstrap(page)

            const actionsCount = Object.keys(this.bot.nextActions).length
            const snapshot = this.bot.reactSnapshot
            const reportableCount = snapshot?.reportable.length ?? 0
            const availablePoints = snapshot?.account.availablePoints ?? null

            if (!actionsCount) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'GET-REWARD-SESSION',
                    '未解析到操作ID - 本次运行将跳过服务器操作调用（报告/连击保护）'
                )
            }

            if (!snapshot || !snapshot.offers.length) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'GET-REWARD-SESSION',
                    '页面快照为空 - /earn 和 /dashboard 均未渲染出可用的RSC数据'
                )
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'GET-REWARD-SESSION',
                `上下文就绪 | actions=${actionsCount} | reportable=${reportableCount} | available=${availablePoints}`
            )
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)

            this.bot.logger.error(
                this.bot.isMobile,
                'GET-REWARD-SESSION',
                `获取奖励上下文失败: ${message}`
            )

            throw new Error(`获取奖励上下文失败: ${message}`)
        }
    }

    async getAppAccessToken(page: Page, email: string) {
        this.bot.logger.info(this.bot.isMobile, 'GET-APP-TOKEN', '请求移动访问令牌')
        return await new MobileAccessLogin(this.bot, page).get(email)
    }
}
