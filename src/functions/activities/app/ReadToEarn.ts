import { URLs } from '../../../constants/urls'
import { BING_APP_USER_AGENT } from '../../../constants/userAgents'
import type { HttpRequestConfig } from '../../../util/Http'
import { getReadToEarnArticleLimit } from '../../../util/Humanize'
import { randomBytes } from 'crypto'
import { BaseActivity } from '../BaseActivity'

// 服务端偶尔会拒绝一次"读文"领取：节奏太快、或当天额度已用完都会返回 0 分。
const CLAIM_ATTEMPTS = 3
const CLAIM_RETRY_WAIT = '90sec'

export class ReadToEarn extends BaseActivity {
    public async doReadToEarn() {
        if (!this.bot.accessToken) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'READ-TO-EARN',
                '跳过：应用访问令牌不可用，此活动需要它！'
            )
            return
        }

        const delayMin = this.bot.config.searchSettings.readDelay.min
        const delayMax = this.bot.config.searchSettings.readDelay.max
        const startBalance = Number(this.bot.userData.currentPoints ?? 0)

        this.bot.logger.info(
            this.bot.isMobile,
            'READ-TO-EARN',
            `开始读文赚积分 | geo=${this.bot.userData.geoLocale} | delayRange=${delayMin}-${delayMax} | currentBalance=${startBalance}`
        )

        try {
            const jsonData = {
                amount: 1,
                id: '1',
                type: 101,
                attributes: {
                    offerid: 'ENUS_readarticle3_30points'
                },
                country: this.bot.userData.geoLocale
            }

            const articleCount = getReadToEarnArticleLimit(10)
            let totalGained = 0
            let articlesRead = 0
            let oldBalance = startBalance

            for (let i = 0; i < articleCount; ++i) {
                jsonData.id = randomBytes(64).toString('hex')

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `正在提交读文赚积分活动 | article=${i + 1}/${articleCount} | id=${jsonData.id} | country=${jsonData.country}`
                )

                const request: HttpRequestConfig = {
                    url: URLs.platform.activities,
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.bot.accessToken}`,
                        'User-Agent': BING_APP_USER_AGENT,
                        'Content-Type': 'application/json',
                        'X-Rewards-Country': this.bot.userData.geoLocale,
                        'X-Rewards-Language': this.bot.userData.langCode,
                        'X-Rewards-ismobile': 'true'
                    },
                    data: JSON.stringify(jsonData)
                }

                // 一次 0 分不再等于"结束"：老代码直接 break，把剩余文章的分一起丢掉，
                // 而 readDelay 一旦调短，服务端拒领会变成常见情况。这里最多重试
                // CLAIM_ATTEMPTS 次、每次之间多等一会儿，只有连续失败才收手，并把原因写清。
                let response: { status?: number; data?: { response?: { balance?: number } } } | null = null
                let newBalance = oldBalance
                let gainedPoints = 0

                for (let attempt = 1; attempt <= CLAIM_ATTEMPTS; attempt++) {
                    response = await this.bot.http.request<{ response?: { balance?: number } }>(request)

                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'READ-TO-EARN',
                        `已收到读文赚积分响应 | article=${i + 1}/${articleCount} | attempt=${attempt}/${CLAIM_ATTEMPTS} | status=${response?.status ?? 'unknown'}`
                    )

                    newBalance = Number(response?.data?.response?.balance ?? oldBalance)
                    gainedPoints = newBalance - oldBalance

                    if (gainedPoints > 0 || attempt >= CLAIM_ATTEMPTS) break

                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'READ-TO-EARN',
                        `未获得积分（第 ${attempt}/${CLAIM_ATTEMPTS} 次尝试），等待 ${CLAIM_RETRY_WAIT} 后重试 | article=${i + 1}/${articleCount} | status=${response?.status ?? 'unknown'} | currentBalance=${newBalance}`
                    )
                    await this.bot.utils.wait(CLAIM_RETRY_WAIT)
                }

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `文章后的积分变化 | article=${i + 1}/${articleCount} | previousBalance=${oldBalance} | currentBalance=${newBalance} | pointsGained=${gainedPoints}`
                )

                if (gainedPoints <= 0) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'READ-TO-EARN',
                        `连续 ${CLAIM_ATTEMPTS} 次未获得积分，停止读文赚积分（当天额度可能已满）| article=${i + 1}/${articleCount} | status=${response?.status ?? 'unknown'} | currentBalance=${newBalance}`
                    )
                    break
                }

                this.bot.userData.currentPoints = newBalance
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints
                totalGained += gainedPoints
                articlesRead = i + 1
                oldBalance = newBalance

                this.bot.logger.info(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `已阅读第 ${i + 1}/${articleCount} 篇文章 | status=${response?.status ?? 'unknown'} | pointsGained=${gainedPoints} | currentBalance=${newBalance}`,
                    'green'
                )

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `文章间等待 | article=${i + 1}/${articleCount} | delayRange=${delayMin}-${delayMax}`
                )

                if (i < articleCount - 1) {
                    await this.bot.utils.wait(this.bot.utils.randomDelay(delayMin, delayMax))
                }
            }

            const finalBalance = Number(this.bot.userData.currentPoints ?? startBalance)

            this.bot.logger.info(
                this.bot.isMobile,
                'READ-TO-EARN',
                `读文赚积分完成 | articlesRead=${articlesRead} | pointsGained=${totalGained} | previousBalance=${startBalance} | currentBalance=${finalBalance}`
            )
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'READ-TO-EARN',
                `读文赚积分出错 | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }
}
