/**
 * 回归测试：朗读链路的核心不变量。
 *
 * 背景（2026-10-31）：
 *   1. 客户端监听 sentence 事件的 effect 写着 `if (!on) return undefined`，
 *      于是朗读要**同时**满足两个条件才生效：
 *        1. 设置里勾了「朗读回复」
 *        2. 开着语音模式（麦克风按钮）
 *      而设置面板里那个开关的说明是「把助手的回复念出来」，
 *      压根没提第二个条件 —— 用户勾了却听不到声音。
 *
 *   2. **busy 的置位与复位不对称**（今天引入的回归）：
 *      markBusy(true) 被提到 readAloud 判断之前，但 markBusy(false)
 *      只存在于「开朗读」那条分支的 generator finally 里，
 *      而 readAloud 默认是 false ——
 *      于是助手第一次回话后 /busy 永远返回 true，
 *      客户端 assistantRunning 恒真 → 识别出的文字永远只留在输入框、永远发不出去。
 *
 *   3. SSML 未转义：Edge TTS 把文本原样插进 XML，
 *      一句含 '<' 或 '&' 的回复就让 XML 非法 → 服务端拒绝 → 整段无声。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripForSpeech } from '../lib/speech-clean.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const idx = fs.readFileSync(root + '/lib/index.js', 'utf8')
const lines = idx.split('\n')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

console.log('朗读的判定必须用模块级的 currentSettings')
check('钩子用 currentSettings.readAloud 判断',
  /currentSettings\.readAloud !== true/.test(idx),
  '钩子注册在 ctx.inject 之外，取不到 apply 作用域的 settings')
check('钩子里没有直接用 settings',
  !/ctx\.on\('llm\/stream'[\s\S]{0,900}?\bsettings\.readAloud/.test(idx))
check('广播 sentence 事件（带 turnId 与序号）',
  /emit\('sentence', \{ text, turnId: turn\.turnId, index \}\)/.test(idx),
  '句子必须带 turnId（它属于哪一轮）与 index（本轮第几句）')
check('按句切分并清洗 Markdown', /stripForSpeech\(raw\)/.test(idx))

console.log('\nbusy 的置位与复位必须对称（今天引入过的回归）')
const hookStart = lines.findIndex((l) => l.includes("ctx.on('llm/stream'"))
let hookEnd = hookStart
let depth = 0
for (let k = hookStart; k < lines.length; k++) {
  for (const ch of lines[k]) { if (ch === '(' || ch === '{') depth++; if (ch === ')' || ch === '}') depth-- }
  if (depth <= 0 && k > hookStart) { hookEnd = k; break }
}
const hook = lines.slice(hookStart, hookEnd + 1).join('\n')

const setTrue = (hook.match(/markBusy\(sessionId, true\)/g) ?? []).length
const setFalse = (hook.match(/markBusy\(sessionId, false\)/g) ?? []).length
check('置位与复位各至少一次', setTrue >= 1 && setFalse >= 1, `true×${setTrue} false×${setFalse}`)
check('复位次数不少于置位次数', setFalse >= setTrue,
  `置位 ${setTrue} 次、复位 ${setFalse} 次 —— 少了复位 /busy 就会永不复位`)

const noReadAloud = hook.indexOf('currentSettings.readAloud !== true')
const plainBranch = hook.slice(noReadAloud, noReadAloud + 700)
check('不朗读的分支里也有 markBusy(false)',
  /markBusy\(sessionId, false\)/.test(plainBranch),
  '之前复位只写在「开朗读」的 generator finally 里，而 readAloud 默认 false → /busy 永远为 true → 文字永远发不出去')

console.log('\nSSML 转义（含 < 或 & 的回复不能整段无声）')
// stripForSpeech 已抽到 lib/speech-clean.js，这里直接测导入的纯函数。
const strip = stripForSpeech
check('a < b 被转义', strip('a < b').includes('&lt;'), strip('a < b'))
check('x & y 被转义', strip('x & y').includes('&amp;'), strip('x & y'))
check('普通句子不受影响', strip('你好，今天天气怎么样？') === '你好，今天天气怎么样？', strip('你好，今天天气怎么样？'))
check('转义在最后一步（避免 & 被重复转义）',
  /&amp;/.test(strip('AT&T')) && !/&amp;amp;/.test(strip('AT&T')), strip('AT&T'))

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
