// 账号名单语义的回归测试。
//
// 要点有两个，都是踩过的坑：
//   1. 名单以 .env 文件为准——**加**和**删**账号都即时生效，不需要重启控制 API
//      （以前删掉的账号会一直留在 process.env 里，账户总览/运行/计划/会话管理四处
//      一起显示旧账号）。
//   2. 注射给机器人的环境必须把已删槽位清空——`_resolveEnv()` 先铺控制 API 自己的
//      process.env 再盖 override，只要 override 没提到某个 ACCOUNT_N_* 键，它就会
//      活到机器人那里，于是"面板上已经删了"的账号又被跑一遍。
//
// 跑法：node scripts/api/test-accounts-roster.mjs   （退出码 0 = 全部通过）

import {
    buildAllAccountsEnv,
    buildExcludedAccountsEnv,
    buildSingleAccountEnv,
    loadAccounts,
    resolveAccountsEnv
} from './accounts.js'

let passed = 0
const failures = []

function check(name, fn) {
    try {
        fn()
        passed++
    } catch (err) {
        failures.push(`${name}\n      ${err.message}`)
    }
}

function eq(actual, expected, what) {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    if (a !== e) throw new Error(`${what}：期望 ${e}，实际 ${a}`)
}

function withProcessEnv(extra, fn) {
    const saved = {}
    for (const [key, value] of Object.entries(extra)) {
        saved[key] = process.env[key]
        process.env[key] = value
    }
    try {
        return fn()
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
}

const FILE_ENV = {
    ACCOUNT_11_EMAIL: 'eleven@outlook.com',
    ACCOUNT_11_PASSWORD: 'pw-eleven',
    ACCOUNT_12_EMAIL: 'twelve@outlook.com'
}
// 控制 API 启动时读到的旧世界：里面还有后来被删掉的 5。
const STALE_ENV = {
    ACCOUNT_5_EMAIL: 'five@outlook.com',
    ACCOUNT_5_PASSWORD: 'pw-five',
    ACCOUNT_11_EMAIL: 'stale-eleven@outlook.com',
    PATH: '/usr/bin'
}

check('文件里的名单说了算：删掉的槽位不再出现在名单里', () => {
    const resolved = resolveAccountsEnv(STALE_ENV, FILE_ENV)
    eq(loadAccounts(resolved).map(a => a.index), [11, 12], '解析出的名单')
    eq(resolved.ACCOUNT_5_EMAIL, undefined, '已删槽位被剔除')
    eq(resolved.ACCOUNT_5_PASSWORD, undefined, '已删槽位的配套键也被剔除')
})

check('同一个键文件优先，process.env 里的配套键保留', () => {
    const resolved = resolveAccountsEnv(STALE_ENV, FILE_ENV)
    eq(resolved.ACCOUNT_11_EMAIL, 'eleven@outlook.com', '文件覆盖 process.env')
    eq(resolved.ACCOUNT_11_PASSWORD, 'pw-eleven', '配套键来自文件')
    eq(resolved.PATH, '/usr/bin', '非账号键不受影响')
})

check('文件里一个账号都没有时，名单仍由 process.env 决定（容器部署）', () => {
    const resolved = resolveAccountsEnv({ ACCOUNT_5_EMAIL: 'five@outlook.com' }, { SOME_FLAG: '1' })
    eq(loadAccounts(resolved).map(a => a.index), [5], '纯环境变量部署的名单')
    eq(resolved.SOME_FLAG, '1', '文件里的其它变量照样生效')
})

check('文件里只有空邮箱时不当作名单，不会误删 process.env 的账号', () => {
    const resolved = resolveAccountsEnv({ ACCOUNT_5_EMAIL: 'five@outlook.com' }, { ACCOUNT_99_EMAIL: '   ' })
    eq(resolved.ACCOUNT_5_EMAIL, 'five@outlook.com', '名单未被清空')
})

check('全量运行的注入环境把已删槽位清空（机器人不会自己捡回来）', () => {
    withProcessEnv(
        { ACCOUNT_5_EMAIL: 'five@outlook.com', ACCOUNT_5_PASSWORD: 'pw-five' },
        () => {
            const roster = resolveAccountsEnv(process.env, FILE_ENV)
            const all = buildAllAccountsEnv(roster)
            eq(all.env.ACCOUNT_5_EMAIL, '', '已删槽位被清空')
            eq(all.env.ACCOUNT_5_PASSWORD, '', '已删槽位的配套键被清空')
            eq(all.env.ACCOUNT_11_EMAIL, 'eleven@outlook.com', '名单内的键保留')
            eq(all.env.ACCOUNT_11_PASSWORD, 'pw-eleven', '名单内的配套键保留')
            eq(loadAccounts(all.env).map(a => a.index), [11, 12], '机器人看到的名单')
            eq(all.includedAccounts.map(a => a.index), [11, 12], 'includedAccounts')
        }
    )
})

check('单账号运行：已删槽位清空，被选账号重编号成 ACCOUNT_1', () => {
    withProcessEnv({ ACCOUNT_5_EMAIL: 'five@outlook.com' }, () => {
        const roster = resolveAccountsEnv(process.env, FILE_ENV)
        const single = buildSingleAccountEnv(12, roster)
        eq(single.env.ACCOUNT_5_EMAIL, '', '旧槽位被清空')
        eq(single.env.ACCOUNT_1_EMAIL, 'twelve@outlook.com', '被选账号重编号')
        eq(single.env.ACCOUNT_11_EMAIL, '', '没被选的槽位也被清空')
        eq(loadAccounts(single.env).length, 1, '机器人只看到 1 个账号')
    })
})

check('已经删掉的槽位不能再被单独启动', () => {
    withProcessEnv({ ACCOUNT_5_EMAIL: 'five@outlook.com' }, () => {
        const roster = resolveAccountsEnv(process.env, FILE_ENV)
        let code = null
        try {
            buildSingleAccountEnv(5, roster)
        } catch (err) {
            code = err.code
        }
        eq(code, 'BAD_REQUEST', '启动已删账号应被拒绝')
    })
})

check('排除式运行的名单同样只含文件里的槽位', () => {
    withProcessEnv({ ACCOUNT_5_EMAIL: 'five@outlook.com' }, () => {
        const roster = resolveAccountsEnv(process.env, FILE_ENV)
        const excluded = buildExcludedAccountsEnv([12], roster)
        eq(excluded.includedAccounts.map(a => a.index), [11], '剩下 11 要跑')
        eq(excluded.excludedAccounts.map(a => a.index), [12], '12 被排除')
        eq(excluded.env.ACCOUNT_5_EMAIL, '', '已删槽位被清空')
    })
})

console.log(`账号名单回归测试：通过 ${passed}/${passed + failures.length}`)
if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`)
    process.exitCode = 1
}
