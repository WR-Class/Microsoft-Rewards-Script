import { accountIndexesFromEnv, envStrFrom, normalizeGeoLocale, normalizeLanguageCode } from '../env.js'

function sanitizeProxyUrl(value) {
    try {
        const url = new URL(value)
        url.username = ''
        url.password = ''
        return url.toString().replace(/\/$/, '')
    } catch {
        return value.replace(/^(?:[^/@\s]+@|([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@)/i, '$1')
    }
}

export function loadAccounts(sourceEnv = process.env) {
    const accounts = []

    for (const i of accountIndexesFromEnv(sourceEnv)) {
        const email = envStrFrom(sourceEnv, `ACCOUNT_${i}_EMAIL`)
        if (!email) continue

        const proxyUrl = envStrFrom(sourceEnv, `ACCOUNT_${i}_PROXY_URL`)
        accounts.push({
            index: i,
            email,
            emailKey: email, // internal history join key; removed before returning the response
            geoLocale: normalizeGeoLocale(envStrFrom(sourceEnv, `ACCOUNT_${i}_GEO_LOCALE`) ?? 'auto'),
            langCode: normalizeLanguageCode(envStrFrom(sourceEnv, `ACCOUNT_${i}_LANG_CODE`) ?? 'en'),
            hasRecoveryEmail: Boolean(envStrFrom(sourceEnv, `ACCOUNT_${i}_RECOVERY_EMAIL`)),
            hasTotp: Boolean(envStrFrom(sourceEnv, `ACCOUNT_${i}_TOTP_SECRET`)),
            proxy: proxyUrl
                ? {
                      url: sanitizeProxyUrl(proxyUrl),
                      port: envStrFrom(sourceEnv, `ACCOUNT_${i}_PROXY_PORT`) ?? null,
                      hasCredentials: Boolean(
                          envStrFrom(sourceEnv, `ACCOUNT_${i}_PROXY_USERNAME`) &&
                          envStrFrom(sourceEnv, `ACCOUNT_${i}_PROXY_PASSWORD`)
                      )
                  }
                : null
        })
    }
    return accounts
}

const ACCOUNT_KEY = /^ACCOUNT_\d+_/

// `_resolveEnv()` in the Control API lays its own `process.env` down first and applies the
// override on top, so an `ACCOUNT_N_*` key the override does not mention survives into the
// bot. Every builder therefore has to blank the union of both sources — blanking only the
// override's own keys used to be enough (the override was a superset of `process.env`),
// but the roster resolver below drops deleted slots, which is exactly the case where it
// stops being a superset.
function blankAccountKeys(target, ...sources) {
    for (const source of sources) {
        for (const key of Object.keys(source || {})) {
            if (ACCOUNT_KEY.test(key)) target[key] = ''
        }
    }
    return target
}

/**
 * 账号名单的权威来源。
 *
 * 控制 API 只在启动时读一次 `.env`，之后把文件里的值叠在 `process.env` 上。于是：
 *   - **加**账号：键还不存在，叠进来即可 → 一直都是"立刻生效"；
 *   - **删**账号：键在 `process.env` 里已经存在，没有人再比对文件里还在不在，于是删掉
 *     的账号会一直留在名单里，直到重启控制 API。账户总览、运行、计划、诊断→会话管理
 *     四个页面都读这份名单，所以会一起显示已经删掉的账号。
 *
 * 这里把名单改成以文件为准：文件里定义了任一非空 `ACCOUNT_*_EMAIL` 时，名单就是文件里
 * 那些槽位，`process.env` 里已被删掉的槽位一律剔除 —— 加和删都立刻生效。文件里一个账号
 * 都没有时（容器里只给环境变量的部署方式），名单仍然完全由 `process.env` 决定。
 */
export function resolveAccountsEnv(processEnv = {}, fileEnv = {}) {
    const slots = new Set()
    for (const [key, value] of Object.entries(fileEnv || {})) {
        const match = /^ACCOUNT_(\d+)_EMAIL$/.exec(key)
        if (match && String(value ?? '').trim()) slots.add(match[1])
    }

    const env = {}
    for (const [key, value] of Object.entries(processEnv || {})) {
        const match = ACCOUNT_KEY.exec(key)
        if (slots.size && match && !slots.has(match[1])) continue
        env[key] = value
    }
    for (const [key, value] of Object.entries(fileEnv || {})) env[key] = value
    return env
}

/**
 * 不带筛选的全量运行要给机器人的环境。
 *
 * 与 `buildSingleAccountEnv` / `buildExcludedAccountsEnv` 同样的道理：必须先清掉
 * `process.env` 里那些已经不在名单上的 `ACCOUNT_*` 键，否则机器人从继承来的
 * `process.env` 里把删掉的账号又捡回去，跑出面板根本没显示的账号。
 */
export function buildAllAccountsEnv(sourceEnv = process.env) {
    const env = blankAccountKeys({}, process.env, sourceEnv)
    for (const [key, value] of Object.entries(sourceEnv)) {
        if (ACCOUNT_KEY.test(key)) env[key] = value
    }

    return {
        env,
        includedAccounts: loadAccounts(sourceEnv).map(({ index, email }) => ({ index, email }))
    }
}

export function buildSingleAccountEnv(accountIndex, sourceEnv = process.env) {
    const index = Number(accountIndex)
    if (!Number.isSafeInteger(index) || index < 1) {
        const err = new Error('`accountIndex` must be a positive integer.')
        err.code = 'BAD_REQUEST'
        throw err
    }

    const selectedPrefix = `ACCOUNT_${index}_`
    const selected = Object.entries(sourceEnv).filter(([key]) => key.startsWith(selectedPrefix))
    const email = envStrFrom(sourceEnv, `${selectedPrefix}EMAIL`)
    if (!email) {
        const err = new Error(`ACCOUNT_${index} is not configured.`)
        err.code = 'BAD_REQUEST'
        throw err
    }

    const env = blankAccountKeys({}, process.env, sourceEnv)

    for (const [key, value] of selected) {
        const suffix = key.slice(selectedPrefix.length)
        env[`ACCOUNT_1_${suffix}`] = value
    }

    return {
        env,
        account: { index, email }
    }
}

export function buildExcludedAccountsEnv(excludedAccountIndexes, sourceEnv = process.env) {
    if (!Array.isArray(excludedAccountIndexes)) {
        const err = new Error('`excludedAccountIndexes` must be an array of positive integers.')
        err.code = 'BAD_REQUEST'
        throw err
    }

    const excluded = [...new Set(excludedAccountIndexes.map(Number))]
    if (excluded.some(index => !Number.isSafeInteger(index) || index < 1)) {
        const err = new Error('`excludedAccountIndexes` must contain only positive integers.')
        err.code = 'BAD_REQUEST'
        throw err
    }

    const accounts = loadAccounts(sourceEnv)
    const knownIndexes = new Set(accounts.map(account => account.index))
    const unknown = excluded.filter(index => !knownIndexes.has(index))
    if (unknown.length) {
        const err = new Error(
            `Unknown account slot${unknown.length === 1 ? '' : 's'}: ${unknown.map(index => `ACCOUNT_${index}`).join(', ')}.`
        )
        err.code = 'BAD_REQUEST'
        throw err
    }

    const excludedSet = new Set(excluded)
    const included = accounts.filter(account => !excludedSet.has(account.index))
    if (!included.length) {
        const err = new Error('A scheduled run cannot exclude every configured account.')
        err.code = 'BAD_REQUEST'
        throw err
    }

    const env = blankAccountKeys({}, process.env, sourceEnv)

    included.forEach((account, position) => {
        const sourcePrefix = `ACCOUNT_${account.index}_`
        const targetPrefix = `ACCOUNT_${position + 1}_`
        for (const [key, value] of Object.entries(sourceEnv)) {
            if (!key.startsWith(sourcePrefix)) continue
            env[`${targetPrefix}${key.slice(sourcePrefix.length)}`] = value
        }
    })

    return {
        env,
        excludedAccounts: accounts
            .filter(account => excludedSet.has(account.index))
            .map(({ index, email }) => ({ index, email })),
        includedAccounts: included.map(({ index, email }) => ({ index, email }))
    }
}

export function mergeAccountStats(accounts, runs) {
    // Index history results by email.
    const byEmail = new Map()
    for (const run of runs) {
        const when = run.endedAt || run.startedAt || null
        for (const acc of run.accounts || []) {
            if (!byEmail.has(acc.email)) byEmail.set(acc.email, [])
            byEmail.get(acc.email).push({ ...acc, when })
        }
    }

    return accounts.map(a => {
        const results = byEmail.get(a.emailKey) || [] // already most-recent-first
        const last = results[0] || null
        const streakProtection = results.find(result => result.streakProtection != null)?.streakProtection ?? null
        const edgeBrowsing = results.find(result => result.edgeBrowsing != null)?.edgeBrowsing ?? null

        let totalCollected = 0
        for (const r of results) totalCollected += r.collected || 0

        // Consecutive successes from the most recent run backwards.
        let successStreak = 0
        for (const r of results) {
            if (r.success === true) successStreak++
            else break
        }

        const { emailKey, ...safe } = a
        void emailKey
        return {
            ...safe,
            runs: results.length,
            totalCollected,
            successStreak,
            lastRunAt: last?.when ?? null,
            lastCollected: last?.collected ?? null,
            lastSuccess: last ? last.success : null,
            lastError: last?.error ?? null,
            streakProtection,
            edgeBrowsing
        }
    })
}
