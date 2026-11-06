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
 *
 *   批次 6h（docs/architecture-modernization.md §8.41）：
 *     「按钮不许回写」「按钮要跟着存储更新 configRef」这两条改由
 *     `test/client-behavior.test.mjs` 的场景「配置同步 ⑤」真跑证明（给存储的 set
 *     挂计数探针 + 读运行时诊断快照）。本文件剩下的是产物侧的写入点守卫，
 *     以及 reload / save 那两段的行为（脏状态保护、归一化、错误可见）。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

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
// 这件事原来由四条**产物形状**判据守着，判的都是 `lib/client.js` 里 MicButton
// 那个代码块长什么样：`!/configStore\.set\(/`、`/configRef\.current = next/`、
// `/configStore\d*\.subscribe/`、「写入点的行号不落在按钮那一段里」。
// 批次 6h（docs/architecture-modernization.md §8.41）把它们换成了真跑 ——
// `test/client-behavior.test.mjs` 的场景「配置同步 ⑤」给共享存储的 `set` 挂了计数探针，
// 挂载拉取与开麦重拉各跑一次：
//   · 「按钮回写了几次」是**数**出来的（探针计 0 次才算过）；
//   · 「configRef 跟没跟上面板保存的新值」是从运行时诊断快照 `__DSH_VOICE_DEBUG__().config`
//     读出来的，随后还发了一句真朗读证明这个值真的在用；
//   · 判的是同一件事，但不再依赖任何一个函数体长什么样（搬迁、改名、抽 hook 都不会误红，
//     而真的回写了一次就会红）。
// 这里只留一条产物守卫：**写入点的总数**。它守的是「别再多一个写入方」，
// 与「按钮有没有回写」是两件事（后者由上面那条真跑守）；把算术留在产物文本上做守卫，
// 是因为它天然没有行为面可看 —— 多一个写入方本身不改变任何一次运行的结果。
const writes = []
lines.forEach((l, k) => {
  if (/configStore\.set\(/.test(l)) writes.push({ line: k + 1, text: l.trim() })
})
check('全客户端的共享存储写入点不超过 3 个（设置面板：加载 + 保存 payload + 保存 effective）',
  writes.length <= 3,
  `实际 ${writes.length} 个：${writes.map((w) => `行 ${w.line}`).join(', ')}`)

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
  // 「400 的 errors 转成可读信息展示」这一条原来是 `/collectSaveErrors\(data\)/` ——
  // 钉的是调用点的写法。批次 20（docs §8.62）把它删了，理由两条：
  //   ① 签名加了第二个参数（取词函数），这种判据在契约变一次就红一次，
  //      换成 `/collectSaveErrors\(data, t\)/` 只是把字面量跟着改一遍，没有新信息；
  //   ② 它想判的那件事实（错误行真的显示在界面上）在
  //      `test/client-behavior.test.mjs` 场景「面板·词表与保存」里已经有更强的真跑判据：
  //      挂的是产物里的设置面板、发的是真的 400、数的是渲染树里的字典键，
  //      另加 8 个码逐个跑一遍 + 「宿主原文/`detail` 不进界面」的反例。
  // 这一段剩下的两条判的是「发出去的东西」与「脏标记的时机」，那两面没有渲染可看，仍留在产物侧。
  check('保存失败保持 dirty（不提前 setDirty(false)）',
    saveBlock.indexOf('setDirty(false)') > saveBlock.indexOf('!resp.ok'))
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
