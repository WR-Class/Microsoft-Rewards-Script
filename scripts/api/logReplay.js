import fs from 'node:fs'
import path from 'node:path'

import { applyLogToRunState, parseLogLine } from './logParser.js'

const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.log$/

/**
 * The bot's own daily log files, oldest first, trimmed to the newest `limit`.
 * A missing or unreadable directory yields an empty list: no backfill is not an error.
 */
export function listLogFiles(dir, limit = 1) {
    let names
    try {
        names = fs.readdirSync(dir)
    } catch {
        return []
    }

    return names
        .filter(name => DAY_FILE_RE.test(name))
        .sort()
        .slice(-Math.max(1, limit))
        .map(name => path.join(dir, name))
}

/**
 * Rebuild a run state from the bot's log files, through exactly the two functions the live stdout
 * path uses (parseLogLine -> applyLogToRunState) so the file route cannot drift from it.
 *
 * Reads at most `files` newest daily files and at most `maxBytes` from the tail of each. When that
 * ceiling slices a file mid-line the partial first line is dropped instead of parsed as garbage.
 * Replaying several files accumulates their accounts, so the default is the single newest file.
 */
export function replayLogFiles({ dir, state, files = 1, maxBytes = 4_000_000 } = {}) {
    const result = {
        at: new Date().toISOString(),
        dir: dir ?? null,
        files: [],
        lines: 0,
        parsed: 0,
        truncated: false,
        accounts: 0,
        runTotal: null
    }
    if (!state) return result

    for (const file of listLogFiles(dir, files)) {
        let text
        try {
            text = fs.readFileSync(file, 'utf8')
        } catch {
            continue
        }

        if (text.length > maxBytes) {
            text = text.slice(-maxBytes)
            result.truncated = true
            const newline = text.indexOf('\n')
            text = newline === -1 ? '' : text.slice(newline + 1)
        }

        let lines = 0
        let parsed = 0
        for (const raw of text.split(/\r?\n/)) {
            if (!raw.trim()) continue
            lines += 1
            const entry = parseLogLine(raw)
            if (entry.parsed) parsed += 1
            applyLogToRunState(state, entry)
        }

        result.files.push({ file: path.basename(file), lines, parsed })
        result.lines += lines
        result.parsed += parsed
    }

    result.accounts = state.order?.length ?? 0
    result.runTotal = state.totals?.collected ?? null
    return result
}
