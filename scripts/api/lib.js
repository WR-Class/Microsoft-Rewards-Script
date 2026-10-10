import fs from 'node:fs'
import path from 'node:path'

export { envBool, envInt, envStr } from '../env.js'

export function log(level, ...args) {
    const lvl = typeof level === 'string' ? level.toUpperCase() : 'INFO'
    const line = `[api] [${lvl}]`
    if (lvl === 'ERROR') return console.error(line, ...args)
    if (lvl === 'WARN') return console.warn(line, ...args)
    return console.log(line, ...args)
}

export function parseArgs(argv = process.argv.slice(2), { boolean = [] } = {}) {
    const args = { _: [] }
    const booleanOptions = new Set(boolean)

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]

        if (arg === '--') {
            args._.push(...argv.slice(i + 1))
            break
        }
        if (!arg.startsWith('-') || arg === '-') {
            args._.push(arg)
            continue
        }

        const option = arg.replace(/^-+/, '')
        const equalsIndex = option.indexOf('=')
        const key = equalsIndex === -1 ? option : option.slice(0, equalsIndex)

        if (!key) {
            args._.push(arg)
        } else if (equalsIndex !== -1) {
            args[key] = option.slice(equalsIndex + 1)
        } else if (booleanOptions.has(key)) {
            args[key] = true
        } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
            args[key] = argv[++i]
        } else {
            args[key] = true
        }
    }
    return args
}

export function findUnknownOptions(args, allowedOptions) {
    const allowed = new Set(allowedOptions)
    return Object.keys(args).filter(key => key !== '_' && !allowed.has(key))
}

export function getProjectRoot(startDir) {
    let dir = startDir
    let nearestPackageDir = null
    while (dir !== path.parse(dir).root) {
        const packagePath = path.join(dir, 'package.json')
        if (fs.existsSync(packagePath)) {
            nearestPackageDir ??= dir
            try {
                const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
                if (typeof pkg.name === 'string' && pkg.name.trim()) return dir
            } catch {}
        }
        dir = path.dirname(dir)
    }
    if (nearestPackageDir) return nearestPackageDir
    throw new Error('Could not locate project root (package.json not found).')
}

function envFileCandidates(projectRoot) {
    return [
        path.resolve(process.cwd(), '.env'),
        path.join(projectRoot, '.env'),
        path.join(projectRoot, 'dist', '.env')
    ]
}

/**
 * Parse the bot's .env into a plain object WITHOUT touching process.env.
 * Routes that must see an entry added after this process started (a new
 * ACCOUNT_N written by the dashboard, say) read the file per request through
 * this, instead of trusting the one-time load below.
 */
export function readEnvFileValues(projectRoot) {
    const envFile = envFileCandidates(projectRoot).find(p => fs.existsSync(p))
    if (!envFile) return {}

    const values = {}
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1) continue
        const key = trimmed.slice(0, eq).trim()
        if (!key) continue
        let value = trimmed.slice(eq + 1).trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1)
        }
        values[key] = value
    }
    return values
}

export function loadEnvFile(projectRoot) {
    const envFile = envFileCandidates(projectRoot).find(p => fs.existsSync(p))
    if (!envFile) return null

    for (const [key, value] of Object.entries(readEnvFileValues(projectRoot))) {
        if (process.env[key] === undefined) process.env[key] = value
    }
    return envFile
}

export function loadConfigSafe(projectRoot) {
    const candidates = [
        path.join(projectRoot, 'config.json'),
        path.join(projectRoot, 'dist', 'config.json'),
        path.join(projectRoot, 'src', 'config.json'),
        path.resolve(process.cwd(), 'config.json')
    ]
    for (const p of candidates) {
        if (!fs.existsSync(p)) continue
        try {
            return { data: JSON.parse(fs.readFileSync(p, 'utf8')), path: p }
        } catch (error) {
            return { data: null, path: p, error: error instanceof Error ? error.message : String(error) }
        }
    }
    return null
}

export function redactSecrets(config) {
    if (!config || typeof config !== 'object') return config
    const clone = structuredClone(config)
    const mask = '***REDACTED***'
    const wh = clone.webhook
    if (wh && typeof wh === 'object') {
        if (wh.discord?.url) wh.discord.url = mask
        if (wh.ntfy?.url) wh.ntfy.url = mask
        if (wh.ntfy?.token) wh.ntfy.token = mask
        if (wh.telegram?.botToken) wh.telegram.botToken = mask
        if (wh.telegram?.chatId) wh.telegram.chatId = mask
    }
    return clone
}
