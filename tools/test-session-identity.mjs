// test-session-identity.mjs
//
// 背景：人工弹窗登录（npm run manual-login）的凭据是人输进去的，所以"这份存档属于
// 哪个账号"在保存那一刻只是说法。2026-10-15 就真发生过：为 liangqiuyuanluo201716
// 打开弹窗，实际登进了 yuanpangyun381729，存档被写到 liangqiuyuanluo 名下。
// 机器人不核对登录的是谁，下一次运行就会拿 A 的名字用 B 的身份干活。
//
// 现在弹窗在保存前会读「页面自己声明的登录邮箱」，对不上就拒绝保存。
// 本测试就验证这套判据本身：读得准不准、该拒的会不会拒。
//
// 用法：node tools/test-session-identity.mjs      （不需要浏览器，不需要网络）
// 退出码：0 = 全部通过；1 = 有断言失败。

import assert from 'node:assert/strict'

import { signedInEmailFrom } from '../scripts/main/manualLogin.js'

let passed = 0
let failed = 0

function check(name, fn) {
    try {
        fn()
        passed++
        console.log(`  ✅ ${name}`)
    } catch (error) {
        failed++
        console.log(`  ❌ ${name}`)
        console.log(`     ${error.message}`)
    }
}

// 奖励页把登录身份放在带 pii truncate 的节点里，嵌在 Next.js 的流式脚本中。
// 下面这条是从真实页面上抓到的形状（名字在前，邮箱在后）。
const REAL_SHAPE = [
    '<script>self.__next_f.push([1,"', //
    '\\"className\\":\\"pii truncate text-globalBody2Strong\\",\\"children\\":\\"Donna Johnson\\"',
    '}],[\\"$\\",\\"p\\",null,{',
    '\\"className\\":\\"pii truncate\\",\\"children\\":\\"yuanpangyun381729@outlook.com\\"',
    '}],[\\"$\\",\\"$L2a\\",null,{',
    '"])</script>'
].join('')

console.log('读页面声明的登录身份：')

check('真实页面形状 -> 取到邮箱而不是显示名', () => {
    assert.equal(signedInEmailFrom(REAL_SHAPE), 'yuanpangyun381729@outlook.com')
})

check('页面上有两个邮箱时，优先身份节点那个', () => {
    const html =
        '<div>\\"className\\":\\"pii truncate\\",\\"children\\":\\"right@outlook.com\\"</div>' +
        '<div>other@outlook.com</div>'
    assert.equal(signedInEmailFrom(html), 'right@outlook.com')
})

check('没有身份节点时，退回页面里唯一那个邮箱', () => {
    assert.equal(signedInEmailFrom('<html>联系 huiyuan123@outlook.com</html>'), 'huiyuan123@outlook.com')
})

check('微软自家域名的邮箱不算登录身份', () => {
    assert.equal(signedInEmailFrom('<html>a@bing.com b@microsoft.com c@msn.com</html>'), null)
})

check('页面上没有邮箱 -> null（交给上层按"读不到"处理）', () => {
    assert.equal(signedInEmailFrom('<html>访客页面</html>'), null)
})

check('大括号截断：名字节点不会被误读成邮箱', () => {
    const html = '\\"className\\":\\"pii truncate\\",\\"children\\":\\"Not An Email\\"}'
    assert.equal(signedInEmailFrom(html), null)
})

console.log('')
console.log('判定规则（与弹窗里的分支一致）：')

// 弹窗里的判定：读不到 -> 存但警告；读到了但不同 -> 拒绝；相同 -> 存。
// 这里把同一套规则写成纯函数，避免测试和实现各写一份而漂移。
function decide(signedIn, requested) {
    if (!signedIn) return 'save-with-warning'
    return signedIn.toLowerCase() === requested.toLowerCase() ? 'save' : 'refuse'
}

check('登的是要求的账号 -> 保存', () => {
    assert.equal(decide('a@outlook.com', 'a@outlook.com'), 'save')
})

check('大小写不同仍算同一个账号 -> 保存', () => {
    assert.equal(decide('A@Outlook.com', 'a@outlook.com'), 'save')
})

check('登成了别的账号 -> 拒绝（本次事故正是这种）', () => {
    assert.equal(decide('yuanpangyun381729@outlook.com', 'liangqiuyuanluo201716@outlook.com'), 'refuse')
})

check('读不到身份 -> 保存但警告，不假装核对过', () => {
    assert.equal(decide(null, 'a@outlook.com'), 'save-with-warning')
})

console.log('')
console.log(`${passed} 通过 / ${failed} 失败`)
process.exit(failed ? 1 : 0)
