import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../../index'

export class EmailLogin {
    private submitButton = 'button[type="submit"]'

    constructor(private bot: MicrosoftRewardsBot) {}

    async enterEmail(page: Page, email: string): Promise<'ok' | 'error'> {
        try {
            const emailInputSelector = 'input[type="email"]'
            const emailField = await page
                .waitForSelector(emailInputSelector, { state: 'visible', timeout: 1000 })
                .catch(() => {})
            if (!emailField) {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-ENTER-EMAIL', '未找到邮箱字段')
                return 'error'
            }

            await this.bot.utils.wait(1000)

            const prefilledEmail = await page
                .waitForSelector('#userDisplayName', { state: 'visible', timeout: 1000 })
                .catch(() => {})
            if (!prefilledEmail) {
                await page.fill(emailInputSelector, '').catch(() => {})
                await this.bot.utils.wait(500)
                await page.fill(emailInputSelector, email).catch(() => {})
                await this.bot.utils.wait(1000)
            } else {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-ENTER-EMAIL', '邮箱已预填充')
            }

            const submitButton = await page
                .waitForSelector(this.submitButton, { state: 'visible', timeout: 2000 })
                .catch(() => null)
            if (!submitButton) {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-ENTER-EMAIL', '未找到提交按钮')
                return 'error'
            }

            const clicked = await this.bot.browser.utils.ghostClick(page, this.submitButton)
            if (!clicked) {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-ENTER-EMAIL', '无法提交邮箱')
                return 'error'
            }
            this.bot.logger.info(this.bot.isMobile, 'LOGIN-ENTER-EMAIL', '邮箱已提交')

            return 'ok'
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN-ENTER-EMAIL',
                `发生错误: ${error instanceof Error ? error.message : String(error)}`
            )
            return 'error'
        }
    }

    async enterPassword(page: Page, password: string): Promise<'ok' | 'needs-2fa' | 'error'> {
        try {
            // The state detector recognises this page by [data-testid="passwordEntry"],
            // while this method looked for input[type="password"] and gave up after one
            // second - so a page that was detected could still fail to be filled. Seen on
            // a real account: detected PASSWORD_INPUT at 11:38:00.646, "未找到密码字段" at
            // 11:38:01.654, fatal at 11:38:01.655. That is a one-second wait, not a state
            // timeout. Accept every shape the detector accepts, and give a freshly
            // rendered page longer than a second to produce a visible field.
            const passwordInputSelector =
                'input[type="password"], [data-testid="passwordEntry"] input, input[name="passwd"], #i0118'
            const passwordField = await page
                .waitForSelector(passwordInputSelector, { state: 'visible', timeout: 5000 })
                .catch(() => {})
            if (!passwordField) {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-ENTER-PASSWORD', '未找到密码字段')
                return 'error'
            }

            await this.bot.utils.wait(1000)
            await passwordField.fill('').catch(() => {})
            await this.bot.utils.wait(500)
            await passwordField.fill(password).catch(() => {})
            await this.bot.utils.wait(1000)

            const submitButton = await page
                .waitForSelector(this.submitButton, { state: 'visible', timeout: 2000 })
                .catch(() => null)

            if (!submitButton) {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-ENTER-PASSWORD', '未找到提交按钮')
                return 'error'
            }

            const clicked = await this.bot.browser.utils.ghostClick(page, this.submitButton)
            if (!clicked) {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-ENTER-PASSWORD', '无法提交密码')
                return 'error'
            }
            this.bot.logger.info(this.bot.isMobile, 'LOGIN-ENTER-PASSWORD', '密码已提交')

            return 'ok'
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN-ENTER-PASSWORD',
                `发生错误: ${error instanceof Error ? error.message : String(error)}`
            )
            return 'error'
        }
    }
}
