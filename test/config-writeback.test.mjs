/**
 * 回归测试：配置不能被过期快照覆盖。
 *
 * 背景（2026-10-31）：
 *   麦克风按钮组件挂载时会 `fetch('/config')`，拿到的是**发起请求那一刻**的快照，
 *   然后 `configStore.set(next)` 把这份快照写回共享存储。
 *
 *   如果用户在这期间改了设置并保存，宿主配置已经是最新的，
 *   但这份旧快照回写之后，麦克风按钮的 configRef 又变回旧值。
 *
 *   症状：「明明取消了朗读，过一会儿朗读又出现了」——
 *   取消朗读并保存（宿主已是 false），但那个早先发出的 fetch 晚一步回来，
 *   把 readAloud=true 写了回去，朗读重新生效。
 *
 *   共享存储的权威来源应该是设置面板（加载时和保存时都会 set），
 *   麦克风按钮只需要用自己的 configRef。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { blockOf } from './helpers/block.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const cli = fs.readFileSync(root + '/lib/client.js', 'utf8')
const lines = cli.split('\n')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

console.log('麦克风按钮不得把「拉取到的快照」写回共享存储')
// 麦克风按钮的**完整**代码块（按大括号配平取，不用固定行数窗口 ——
// 加几行代码就把后面的关键代码挤出窗口的话，断言会莫名其妙地失败）。
const mic = blockOf(lines, 'function MicButton')
const micStart = mic.start
const micEnd = mic.end
const micBlock = mic.text
check('麦克风按钮里没有 configStore.set(',
  !/configStore\.set\(/.test(micBlock),
  'fetch 返回的是过期快照，回写会覆盖用户刚保存的设置')
check('麦克风按钮仍然更新自己的 configRef',
  /configRef\.current = next/.test(micBlock))
check('麦克风按钮仍然订阅共享存储（要用设置面板保存的新值）',
  /configStore\.subscribe/.test(micBlock))

console.log('\n共享存储的写入点只应在设置面板')
const writes = []
lines.forEach((l, k) => {
  if (/configStore\.set\(/.test(l)) writes.push({ line: k + 1, text: l.trim() })
})
check('写入点不超过 3 个（设置面板的加载 + 保存两处）', writes.length <= 3,
  `实际 ${writes.length} 个`)
const inMic = writes.filter((w) => w.line > micStart && w.line < micEnd)
check('没有写入点落在麦克风按钮里', inMic.length === 0,
  inMic.map((w) => `行 ${w.line}`).join(', '))

console.log('\n设置面板是共享存储的权威来源')
check('设置面板加载时会写入', /configStore\.set\(data\)/.test(cli))
check('设置面板保存后会写入', /configStore\.set\(data\.config\)/.test(cli))

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
