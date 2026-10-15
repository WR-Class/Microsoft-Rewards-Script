// check-session-identity.mjs
//
// 背景：人工弹窗登录（npm run manual-login）之后，凭据是「人」输进去的，所以
// "这份存档属于哪个账号"当时只是一个说法，不是事实。2026-10-15 就发生过一次：
// 为 liangqiuyuanluo201716 做的弹窗，实际登进去的是 yuanpangyun381729，
// 存档被写到了 liangqiuyuanluo 名下。机器人不会核对登录的是谁，所以下一次运行
// 会拿 A 的名字用 B 的身份干活，把 B 的积分记到 A 头上。
//
// 本工具就是那道缺失的核对：把存档喂进真浏览器（走项目自己的加载路径），
// 打开奖励页，读「页面自己说的登录邮箱」，和存档的键名比对。
// 输出同时给出一个独立的旁证数字——页面余额，可拿去和面板库里的记录对照。
//
// 用法：
//   node tools/check-session-identity.mjs                  # 检查全部 desktop 存档
//   node tools/check-session-identity.mjs <邮箱> [<邮箱>…]  # 只检查指定账号
//   node tools/check-session-identity.mjs --platform mobile
//
// 退出码：0 = 所有被检查的存档都与键名一致；1 = 有任何一个不一致（或无法读取）。
// 依赖：patchright（项目已有）、node:sqlite。需要一个本机可启动的浏览器
//       （config.json 的 browserChannel，默认 chrome）。
//
// 注意：这是只读检查。它不写数据库，也不改存档。

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { chromium } from 'patchright'

const projectRoot = path.resolve(import.meta.dirname, '..')
const dbPath = path.join(projectRoot, 'sessions', 'sessions.db')
const REWARDS_URL = 'https://rewards.bing.com/'
const MAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g
const IGNORE_MAIL = /bing\.com|microsoft\.com|msn\.com|w3\.org|schema\.org|example\.com/i

function readChannel() {
    try {
        const config = JSON.parse(fs.readFileSync(path.join(projectRoot, 'config.json'), 'utf8'))
        return config.browserChannel ?? 'chromium'
    } catch {
        return 'chromium'
    }
}

// 从页面 HTML 里取"页面自己声明的登录邮箱"，并留下上下文，避免把偶然提到的
// 邮箱当成登录身份。奖励页把它渲染在带有 pii truncate 的节点里。
function signedInEmailFrom(html) {
    const marked = [
        ...html.matchAll(/className\\?":\\?"pii truncate\\?[^}]*?children\\?":\\?"([\w.+-]+@[\w-]+\.[\w.-]+)/g)
    ]
    if (marked.length) return { email: marked[0][1], how: '页面身份节点' }
    const all = [...new Set(html.match(MAIL_RE) ?? [])].filter(m => !IGNORE_MAIL.test(m))
    if (all.length) return { email: all[0], how: '页面内唯一邮箱' }
    return { email: null, how: '页面未声明身份' }
}

function balanceFrom(text) {
    return (text.match(/可用积分\s*\n\s*([\d,]+)/) ?? [])[1] ?? null
}

function displayNameFrom(text) {
    return ((text.match(/([^\n]+)\n\s*(?:银牌|金牌|铜牌)会员/) ?? [])[1] ?? '').trim() || null
}

async function main() {
    const argv = process.argv.slice(2)
    let platform = 'desktop'
    const wanted = []
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--platform') platform = argv[++i]
        else wanted.push(argv[i])
    }

    if (!fs.existsSync(dbPath)) {
        console.error(`找不到会话库：${dbPath}`)
        process.exit(1)
    }

    const db = new DatabaseSync(dbPath, { readOnly: true })
    let rows = db
        .prepare('SELECT email, storage_state, updated_at FROM sessions WHERE platform = ? ORDER BY email')
        .all(platform)
    if (wanted.length) {
        const low = wanted.map(w => w.toLowerCase())
        rows = rows.filter(r => low.includes(String(r.email).toLowerCase()))
    }
    if (!rows.length) {
        console.error(`会话库里没有 ${platform} 存档${wanted.length ? '（指定账号无匹配）' : ''}`)
        process.exit(1)
    }

    const channel = readChannel()
    const launchOpts = { headless: true }
    if (channel && channel !== 'chromium') launchOpts.channel = channel

    console.log(`检查 ${rows.length} 份 ${platform} 存档 | 浏览器通道: ${channel}`)
    console.log('')

    const browser = await chromium.launch(launchOpts)
    const problems = []

    try {
        for (const row of rows) {
            const email = String(row.email)
            const state = JSON.parse(row.storage_state)
            const savedAt = new Date(Number(row.updated_at)).toISOString().replace('T', ' ').slice(0, 19)

            // 身份要等页面渲染出来才读得到；只等一个固定秒数会误报"没有身份"。
            // 这里轮询到出现身份为止，并给整个账号最多两次尝试——第一次可能撞上
            // 页面还在渲染或一次性的网络抖动。
            let found = { email: null, how: '页面未声明身份' }
            let text = ''
            let landed = ''
            let attempts = 0

            for (let attempt = 1; attempt <= 2; attempt++) {
                attempts = attempt
                const ctx = await browser.newContext({
                    storageState: state,
                    locale: 'en-CN',
                    viewport: { width: 1400, height: 900 }
                })
                try {
                    const page = await ctx.newPage()
                    await page.goto(REWARDS_URL, { waitUntil: 'load', timeout: 60000 }).catch(() => {})

                    const deadline = Date.now() + 25000
                    let html = ''
                    while (Date.now() < deadline) {
                        html = await page.content().catch(() => '')
                        found = signedInEmailFrom(html)
                        if (found.email) break
                        await page.waitForTimeout(1000)
                    }
                    text = await page.evaluate(() => document.body.innerText).catch(() => '')
                    landed = page.url()
                } finally {
                    await ctx.close().catch(() => {})
                }

                if (found.email) break
            }

            // 三种结果，补救办法各不相同，不能混成一句：
            //   match    存档可用
            //   mismatch 登的是别的账号 -> 把存档挪到它真正的主人名下
            //   unknown  页面没声明身份（会话失效/被踢成访客）-> 重新人工登录
            let verdict
            if (!found.email) verdict = 'unknown'
            else if (found.email.toLowerCase() === email.toLowerCase()) verdict = 'match'
            else verdict = 'mismatch'

            const LABEL = {
                match: '✅ 与键名一致',
                mismatch: '❌ 登的是别的账号',
                unknown: '⚠️ 会话没有身份（已失效或被踢成访客）'
            }

            console.log(`账号 ${email}`)
            console.log(
                `   存档: ${state.cookies.length} cookie | ${state.origins.length} origins | 保存于 ${savedAt} UTC`
            )
            console.log(`   落地: ${landed}`)
            console.log(`   页面声明的登录邮箱: ${found.email ?? '（没有声明）'}  [${found.how}]`)
            console.log(
                `   页面显示名: ${displayNameFrom(text) ?? '（无）'} | 页面余额: ${balanceFrom(text) ?? '（无）'}`
            )
            console.log(`   结论: ${LABEL[verdict]}${attempts > 1 ? `（第 ${attempts} 次尝试）` : ''}`)
            console.log(
                `   该怎么做: ${
                    verdict === 'match'
                        ? '可以正常使用'
                        : verdict === 'mismatch'
                          ? `把这份存档移到 ${found.email} 名下，而不是把它删掉`
                          : '重新人工登录这个账号'
                }`
            )
            console.log('')

            if (verdict !== 'match') {
                problems.push({ email, found: found.email, landed, verdict })
            }
        }
    } finally {
        await browser.close().catch(() => {})
    }

    if (problems.length) {
        const wrong = problems.filter(p => p.verdict === 'mismatch')
        const dead = problems.filter(p => p.verdict === 'unknown')
        console.error(`有 ${problems.length} 份存档不能直接用：`)
        if (wrong.length) {
            console.error('')
            console.error(`  登成了别的账号（${wrong.length} 份）—— 把存档挪到真正的主人名下，不要删：`)
            for (const p of wrong) console.error(`     ${p.email}  ->  实际登录的是 ${p.found}`)
        }
        if (dead.length) {
            console.error('')
            console.error(`  会话没有身份（${dead.length} 份）—— 需要重新人工登录：`)
            for (const p of dead) console.error(`     ${p.email}  （落地 ${p.landed}，页面没有声明任何账号）`)
        }
        console.error('')
        console.error('机器人不会核对登录的是谁：拿一份登成别的账号的存档去跑，会把实际登录账号的')
        console.error('积分记到存档键名那个账号头上，面板数据就被污染了。')
        process.exit(1)
    }

    console.log(`✅ ${rows.length} 份存档都与各自挂的账号名一致。`)
    process.exit(0)
}

main().catch(error => {
    console.error(`检查失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
})
