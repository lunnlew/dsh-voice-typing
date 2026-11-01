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
// 保存时写入的是**归一化后的 payload** / 服务端回填的 effective，
// 不再是直接把表单原样写进共享存储（旧实现会把非法值同步给麦克风按钮）。
check('设置面板保存后会写入归一化后的配置',
  /configStore\.set\(payload\)/.test(cli) && /configStore\.set\(effective\)/.test(cli))

/**
 * 取两个锚点之间的源码（不含结束行）。
 * blockOf 用括号配平，模板字符串/正则里的括号会干扰；这里按「下一个已知符号」
 * 切段更稳（save/reload 的边界都是已知的 useCallback 定义）。
 */
function sectionOf(startText, endText) {
  const start = lines.findIndex((l) => l.includes(startText))
  if (start < 0) return ''
  let end = lines.length
  for (let k = start + 1; k < lines.length; k++) {
    if (lines[k].includes(endText)) { end = k; break }
  }
  return lines.slice(start, end).join('\n')
}

console.log('\n编辑中的 reload 不得清掉「未保存」状态（审计 F2）')
{
  const reloadRaw = sectionOf('const reload = useCallback', 'const loadModels = useCallback')
  // 剥注释再断言：注释里会提到「旧实现会 setDirty(false) / setLoaded(true)」，
  // 不剥会把注释当成真代码（恒真/恒假）。
  const reloadBlock = reloadRaw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  check('reload 里有 dirty 保护', /if \(!dirtyRef\.current\) \{/.test(reloadBlock))
  check('reload 只在未 dirty 时 setDirty(false)',
    (reloadBlock.match(/setDirty\(false\)/g) || []).length === 1)
  const dirtyGuard = reloadBlock.indexOf('if (!dirtyRef.current) {')
  const clearDirty = reloadBlock.indexOf('setDirty(false)')
  check('setDirty(false) 位于 dirty 保护块内',
    dirtyGuard >= 0 && clearDirty > dirtyGuard,
    `guard=${dirtyGuard} clear=${clearDirty}`)
  check('加载失败不放开保存（catch 里是 setLoaded(false)）',
    /catch[\s\S]{0,900}?setLoaded\(false\)/.test(reloadBlock)
    && !/catch[\s\S]{0,900}?setLoaded\(true\)/.test(reloadBlock))
}

console.log('\n保存前归一化 + 校验错误可见（审计 F7/F8/F13）')
{
  const saveBlock = sectionOf('const save = useCallback', 'const runEnvCheck = useCallback')
  check('保存前调用 normalizeForSave', /normalizeForSave\(/.test(saveBlock))
  check('POST 的是归一化后的 payload', /body: JSON\.stringify\(payload\)/.test(saveBlock))
  check('400 的 errors 转成可读信息展示', /collectSaveErrors\(data\)/.test(saveBlock))
  check('保存失败保持 dirty（不提前 setDirty(false)）',
    saveBlock.indexOf('setDirty(false)') > saveBlock.indexOf('!resp.ok'))
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
