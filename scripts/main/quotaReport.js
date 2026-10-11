#!/usr/bin/env node
/**
 * 每日配额报告：从日志里读出「每个账号每天拿了多少、还差多少、数字可不可信」。
 *
 * 日志行格式（取自真实日志，字段位置就是解析依据）：
 *   2026-10-11 02:21:08.915 [2026/10/11 02:21:08] [qiaobaochong823680] [INFO] MOBILE [SEARCH-BING] 剩余搜索积分 | Edge=0 | 桌面端=15 | 移动端=0
 *   └ 日期 ────────────────┘ └ 冗余时间戳 ────────┘ └ 账号 ──────┘ └ 级别 ┘ └平台┘ └ 标签 ─────┘ └ 正文
 *
 * 注意：账号在第三个方括号、标签在第五个。用错括号只会拿到级别（DEBUG/INFO/…），
 * 解析会静默返回空结果而不是报错 —— 所以正则里每个括号都写死了。
 *
 * scripts/ 目录是 ESM（scripts/package.json 里 "type": "module"），所以这里用 import，
 * 并且 __dirname 要自己从 import.meta.url 推。
 *
 * 用法：node scripts/main/quotaReport.js   （或 npm run quota-report）
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const LOG_DIR = path.join(here, '..', '..', 'logs')

const LINE =
    /^(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}\.\d+ \[[^\]]+\] \[([^\]]+)\] \[(INFO|WARN|DEBUG|ERROR)\] (\S+) \[([A-Z][A-Z0-9-]+)\] (.*)$/

const RE_COLLECTED = /积分已收集 \| 获得积分=(-?\d+) \| 现余额=(-?\d+) \| 账户=(\S+)/
const RE_ACCOUNT_END = /账户完成: (\S+) \| 获得积分=(-?\d+) \| 原余额=(-?\d+) \| 现余额=(-?\d+)/
const RE_REMAINING = /剩余搜索积分 \| Edge=(\d+) \| 桌面端=(\d+) \| 移动端=(\d+)/

// 机器人侧新增的两行（src/index.ts）：基线不可信时它会明说，而不是给出一个假差额。
// 老日志里没有这两行，所以下面 verdict() 里那个「原余额=0 且获得=现余额」的推断仍然保留。
const RE_UNTRUSTED_BASELINE = /初始余额不可信（部分仪表板）/
const RE_UNKNOWN_BASELINE = /积分已收集（基线未知，不报差额）/

function rows() {
    if (!fs.existsSync(LOG_DIR)) {
        console.error(`找不到日志目录: ${LOG_DIR}`)
        process.exit(1)
    }

    const files = fs
        .readdirSync(LOG_DIR)
        .filter(name => /^\d{4}-\d{2}-\d{2}\.log$/.test(name))
        .sort()

    if (files.length === 0) {
        console.error(`日志目录里没有 YYYY-MM-DD.log: ${LOG_DIR}`)
        process.exit(1)
    }

    /** @type {Map<string, any>} */
    const days = new Map()

    for (const file of files) {
        const lines = fs.readFileSync(path.join(LOG_DIR, file), 'utf8').split(/\r?\n/)

        for (const raw of lines) {
            const m = LINE.exec(raw)
            if (!m) continue

            const [, date, account, level, platform, tag, message] = m
            const key = `${date}|${account}`
            let row = days.get(key)

            if (!row) {
                row = {
                    date,
                    account,
                    collected: null,
                    initialBalance: null,
                    finalBalance: null,
                    remaining: null,
                    errors: 0,
                    activities: new Map(),
                    hasAccountEnd: false,
                    baselineUntrusted: false,
                    baselineUnknown: false
                }
                days.set(key, row)
            }

            if (level === 'ERROR') row.errors++

            if (tag !== 'SEARCH-CLOSE-TABS') {
                row.activities.set(tag, (row.activities.get(tag) ?? 0) + 1)
            }

            if (RE_UNTRUSTED_BASELINE.test(message)) {
                row.baselineUntrusted = true
                continue
            }

            if (RE_UNKNOWN_BASELINE.test(message)) {
                row.baselineUnknown = true
                continue
            }

            const collected = RE_COLLECTED.exec(message)
            if (collected) {
                row.collected = Number(collected[1])
                row.finalBalance = Number(collected[2])
                continue
            }

            const end = RE_ACCOUNT_END.exec(message)
            if (end) {
                row.collected = Number(end[2])
                row.initialBalance = Number(end[3])
                row.finalBalance = Number(end[4])
                row.hasAccountEnd = true
                continue
            }

            const remaining = RE_REMAINING.exec(message)
            if (remaining) {
                row.remaining = {
                    edge: Number(remaining[1]),
                    desktop: Number(remaining[2]),
                    mobile: Number(remaining[3])
                }
            }
        }
    }

    return [...days.values()].sort(
        (a, b) => a.date.localeCompare(b.date) || a.account.localeCompare(b.account)
    )
}

/**
 * 一行数字可不可信。这里只做能证明的判断，不猜：
 *  - 基线为 0 而「获得积分」正好等于「现余额」 → 基线读到的很可能是残缺仪表板里的 0，
 *    于是差额被算成了整个余额（chuzheng973528 在 10-11 就是这样报出 +295）。
 *  - 没有 ACCOUNT-END 行 → 这个账号当天没有跑完，基线根本没有被记录。
 */
function verdict(row) {
    if (row.collected === null) return '无数据'
    // 机器人自己说了基线不可信/未知 —— 这是直接证据，优先于任何推断
    if (row.baselineUnknown || row.baselineUntrusted) return '基线未知'
    if (!row.hasAccountEnd) return '未跑完'
    if (row.initialBalance === 0 && row.collected > 0 && row.collected === row.finalBalance) {
        return '基线不可信'
    }
    if (row.collected <= 0) return '无产出'
    return '可信'
}

function main() {
    const data = rows()
    if (data.length === 0) {
        console.log('日志里没有可解析的账号行。')
        return
    }

    const pad = (value, width) => String(value ?? '—').padEnd(width)
    const num = (value, width) => String(value ?? '—').padStart(width)

    console.log('')
    console.log('每日配额报告（来源：logs/YYYY-MM-DD.log）')
    console.log('')
    console.log(
        pad('日期', 12) +
            pad('账号', 34) +
            num('获得', 6) +
            num('原余额', 8) +
            num('现余额', 8) +
            num('桌面余', 7) +
            num('移动余', 7) +
            num('Edge余', 7) +
            num('错误', 5) +
            '  ' +
            pad('判定', 12) +
            '活动明细'
    )
    console.log('-'.repeat(150))

    let flagged = 0

    for (const row of data) {
        const v = verdict(row)
        if (v === '基线不可信' || v === '基线未知' || v === '未跑完') flagged++

        const activities = [...row.activities.entries()]
            .filter(([tag]) => tag !== 'REACT-PARSE' && tag !== 'COOKIE-SYNC')
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([tag, count]) => `${tag}:${count}`)
            .join(' ')

        console.log(
            pad(row.date, 12) +
                pad(row.account, 34) +
                num(row.collected, 6) +
                num(row.initialBalance, 8) +
                num(row.finalBalance, 8) +
                num(row.remaining?.desktop, 7) +
                num(row.remaining?.mobile, 7) +
                num(row.remaining?.edge, 7) +
                num(row.errors, 5) +
                '  ' +
                pad(v, 12) +
                activities
        )
    }

    console.log('')
    console.log(`共 ${data.length} 条「账号 × 日期」，其中 ${flagged} 条数字不可直接采信。`)
    console.log('')
    console.log('判定说明：')
    console.log('  可信        —— 有 ACCOUNT-END，基线不是可疑的 0，且当天有产出')
    console.log('  基线未知    —— 机器人自己记了「初始余额不可信（部分仪表板）」或')
    console.log('                「积分已收集（基线未知，不报差额）」：差额是被有意省略的，')
    console.log('                不等于没产出')
    console.log('  基线不可信  —— 老日志的推断：原余额=0 而获得积分正好等于现余额，基线多半是')
    console.log('                残缺仪表板读到的 0，真实产出未知（差额被算成了整个余额）')
    console.log('  未跑完      —— 当天没有 ACCOUNT-END 行，基线没有被记录')
    console.log('  无产出      —— 跑完了但当天没有积分入账')
    console.log('  无数据      —— 只有零散日志，没有汇总行')
    console.log('')
    console.log('「桌面余/移动余/Edge余」是当天最后一次记录的剩余搜索积分（越小说明越接近打满）。')
}

main()
