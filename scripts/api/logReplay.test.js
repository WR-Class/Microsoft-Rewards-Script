import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createRunState } from './logParser.js'
import { listLogFiles, replayLogFiles } from './logReplay.js'

// The bot's file writer puts a bare timestamp in front of the bracketed envelope, so these fixtures
// use that on-disk shape: the test then covers the same route the startup backfill actually reads.
function envelope(user, title, message, level = 'INFO', platform = 'MAIN') {
    return `2026-01-02 03:04:05.678 [1/2/2026, 3:04:05 AM] [${user}] [${level}] ${platform} [${title}] ${message}`
}

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-replay-'))
    fs.writeFileSync(
        path.join(dir, '2026-01-01.log'),
        `${envelope('a', 'RUN-START', '启动微软奖励脚本 | v4.3.2.4 | 账户数: 1 | 集群数: 1')}\n`
    )
    fs.writeFileSync(
        path.join(dir, '2026-01-02.log'),
        [
            envelope('a', 'RUN-START', '启动微软奖励脚本 | v4.3.2.4 | 账户数: 1 | 集群数: 1'),
            envelope(
                'a',
                'ACCOUNT-START',
                '开始处理账户: a@example.com | geoLocale: auto | locale: en-CN | 缓存区域: CN'
            ),
            envelope('a', 'URL-REWARD', 'UrlReward 完成 | offerId=X | pointsGained=30 | currentBalance=430'),
            envelope(
                'a',
                'ACCOUNT-END',
                '账户完成: a@example.com | 获得积分=30 | 原余额=400 | 现余额=430 | 持续秒数=12.5'
            ),
            envelope(
                'a',
                'RUN-END',
                '全部账户完成 | 处理账户数=1 | 获得积分=30 | 原余额=400 | 现余额=430 | 运行分钟数=1.2'
            )
        ].join('\n') + '\n'
    )
    return dir
}

test('replays the newest daily file into the run state', () => {
    const dir = fixture()
    const state = createRunState()
    const result = replayLogFiles({ dir, state })

    assert.deepEqual(
        result.files.map(f => f.file),
        ['2026-01-02.log']
    )
    assert.equal(result.parsed, result.lines)
    assert.equal(result.accounts, 1)
    assert.equal(result.runTotal, 30)
    assert.equal(state.accounts['a@example.com'].live.bySource.urlReward, 30)
})

test('lists the newest files in chronological order and treats a missing directory as empty', () => {
    const dir = fixture()

    assert.deepEqual(
        listLogFiles(dir, 2).map(f => path.basename(f)),
        ['2026-01-01.log', '2026-01-02.log']
    )
    assert.deepEqual(listLogFiles(path.join(dir, 'missing'), 2), [])

    const result = replayLogFiles({ dir: path.join(dir, 'missing'), state: createRunState() })
    assert.equal(result.lines, 0)
    assert.equal(result.accounts, 0)
    assert.equal(result.runTotal, null)
})

test('drops the partial first line when the byte ceiling slices a file', () => {
    const dir = fixture()
    const result = replayLogFiles({ dir, state: createRunState(), maxBytes: 400 })

    assert.equal(result.truncated, true)
    assert.equal(result.parsed, result.lines)
    assert.ok(result.lines < 5)
})
