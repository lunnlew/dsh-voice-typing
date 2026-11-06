/**
 * 配置词表双端一致性（横断言）。
 *
 * 为什么需要它：
 *   配置词汇曾经有**两份实现** —— 宿主 `lib/config-schema.js`（校验/清洗的真源）
 *   与客户端 `src/client/pure/config-normalize.js`（UI 兜底 + 保存前归一化）。
 *   那份重复是被**误判为**必要的：浏览器模块的 require 只能解析包名，不能 import 宿主文件
 *   （代码结构规矩原写在这份 README 的技术参考一节，文档清理后住在 `docs/reference.md` 第 6 节；
 *   当初的误判记录在 `docs/architecture-optimization.md` §3 P0-2），于是把「宿主路径跨不过去」
 *   当成了「词汇必须有两份」。3.3 把真源挪到 `src/shared/config-vocab.js`：
 *   纯 ESM、零浏览器全局、零 Node API，两端各自 import 它，产物里由 esbuild 合并成一份。
 *
 *   之前 48 个测试里**没有任何一个横切这两份**：
 *     - `config-schema.test.mjs` 只测宿主；
 *     - `config-ui.test.mjs` / `config-link.test.mjs` 只测面板形状与联动；
 *     - `bundle-sync.test.mjs` 只测产物与源一致。
 *   于是「宿主加了个引擎、客户端下拉没有」这类漂移没有任何信号，
 *   表现是保存被 400 打回、或界面显示成第一项（悄悄改用户设置）。
 *
 * 断言强度的分档（避免把「有意的差异」误判成 bug）：
 *   - **必须相同**：词表是同一个数组对象（引用级，不再是「内容集合相等」）、
 *     数值上下界、词表上限、每个 SPECS 键都有客户端默认值；
 *   - **允许不同**：客户端自己那套表现层选项（语速/音调/音量档位、空闲释放时长等），
 *     宿主 schema 里没有对应物，不参与比对。
 *
 * 运行：node test/config-contract.test.mjs
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'

import {
  TTS_ENGINES,
  ASR_LANGUAGES,
  SOVITS_LANGUAGES,
  LIVE_ASR_MODES,
  INTERACTION_MODES,
  VOICE_PROMPT_MODES,
  TTS_FORMATS,
  MAX_WORDS,
  MAX_WORD_CHARS,
  CONFIG_SPEC_KEYS,
  CONFIG_SPECS,
  CONFIG_DEFAULTS,
  CONFIG_MAX_LENS,
  sanitizeConfig,
  validateConfigPatch,
} from '../src/host/config-schema.js'
import * as client from '../src/client/pure/config-normalize.js'
/** shared 词表的真源：两端入口都必须是它的转发，而不是各自再抄一份。 */
import * as sharedVocab from '../src/shared/config-vocab.js'

let passed = 0
const warnings = []
/** 硬失败：双端已经漂移，必须修。 */
function must(name, fn) {
  try {
    fn()
    passed++
    console.log('  ✓ ' + name)
  } catch (err) {
    failed++
    console.log('  ✗ ' + name + '：' + err.message)
  }
}
/** 软提示：差异是有意的，说出来但不拦住。 */
function note(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name) } else { warnings.push(name + '：' + detail) }
}
let failed = 0

console.log('\n== 1. 枚举词表：两端拿到的是同一个数组对象 ==')
// 词表单源（src/shared/config-vocab.js）之后，「两份集合相等」这条断言已经没有信息量
// —— 同一个对象，内容当然相等，它挡不住的是「两份各自维护、恰好同步」这种随时会漂的状态。
// 所以这里改成守三件仍有意义的事：
//   1) 引用相同：宿主入口、客户端入口、shared 三方是同一个对象，不是三份内容一样的副本；
//   2) 转发完整：shared 新增一个词表，两端入口都要带出去（漏一端 = 那一端看不见这个取值），
//      所以对照表本身必须覆盖 shared 的全部导出；
//   3) 不可就地修改：数组被两端共享，任何一处 .sort()/.push() 会同时改掉另一端 → 必须冻结。
const VOCAB_FORWARDING = [
  ['TTS_ENGINES', 'ttsEngine', 'TTS_ENGINES'],
  ['ASR_LANGUAGES', 'language', 'LANGUAGE_CODES'],
  ['SOVITS_LANGUAGES', 'sovitsTextLang / sovitsPromptLang', 'SOVITS_LANGS'],
  ['LIVE_ASR_MODES', 'liveAsr', 'LIVE_ASR_MODES'],
  ['INTERACTION_MODES', 'mode', 'INTERACTION_MODES'],
  ['VOICE_PROMPT_MODES', 'voicePromptMode', 'VOICE_PROMPT_MODES'],
  ['TTS_FORMATS', 'ttsFormat', 'TTS_FORMATS'],
]
const NUMBER_FORWARDING = [
  ['MAX_WORDS', '词表条数上限', 'WORDS_MAX_ENTRIES'],
  ['MAX_WORD_CHARS', '词表单条字符上限', 'WORDS_MAX_CHARS'],
]

for (const [sharedName, key, clientName] of VOCAB_FORWARDING) {
  must(`${key}：宿主/客户端/shared 是同一个数组对象`, () => {
    const shared = sharedVocab[sharedName]
    const host = { TTS_ENGINES, ASR_LANGUAGES, SOVITS_LANGUAGES, LIVE_ASR_MODES,
      INTERACTION_MODES, VOICE_PROMPT_MODES, TTS_FORMATS }[sharedName]
    const guest = client[clientName]
    assert.ok(Array.isArray(shared), `shared 里没有数组 ${sharedName}（导出名漂了？）`)
    assert.equal(host, shared, `宿主入口给的是另一份数组：[${host}] vs shared [${shared}]`)
    assert.equal(guest, shared, `客户端入口给的是另一份数组：[${guest}] vs shared [${shared}]`)
  })
  must(`${key}：shared 词表已冻结（两端共享同一对象，就地排序会互相改掉）`, () => {
    assert.ok(Object.isFrozen(sharedVocab[sharedName]), `${sharedName} 没冻结`)
  })
  must(`${key}：每一项都是非空字符串`, () => {
    for (const value of sharedVocab[sharedName]) {
      assert.equal(typeof value, 'string', `${sharedName} 里有非字符串：${String(value)}`)
      assert.ok(value.trim(), `${sharedName} 里有空白项`)
    }
  })
}
for (const [sharedName, label, clientName] of NUMBER_FORWARDING) {
  must(`${label}：双端是同一个数字`, () => {
    assert.equal(client[clientName], sharedVocab[sharedName], `客户端 ${clientName} 不是 shared 的转发`)
    assert.ok(Number.isInteger(sharedVocab[sharedName]) && sharedVocab[sharedName] > 0,
      `${sharedName} 要是正整数`)
  })
}

must('对照表覆盖了 shared 的全部导出（新增词表必须登记）', () => {
  const listed = [...VOCAB_FORWARDING, ...NUMBER_FORWARDING].map((row) => row[0])
  const sharedNames = Object.keys(sharedVocab)
  const unlisted = sharedNames.filter((n) => !listed.includes(n))
  const ghost = listed.filter((n) => !sharedNames.includes(n))
  assert.deepEqual(unlisted, [], `shared 新增 ${unlisted}，但两端对照表没有它`)
  assert.deepEqual(ghost, [], `对照表引用了 shared 不存在的 ${ghost}`)
})

console.log('\n== 2. 每个 enum 键的取值表就是 shared 词表，默认值落在里面 ==')
{
  // 读 CONFIG_SPECS 这份**数据**。以前这里是拿正则刮 lib/config-schema.js 的源码，
  // 规则每搬一次家（3.3a 词表、3.3b 字段规则）正则就要跟着改一次 —— 那是自伤断言。
  const enumKeys = Object.entries(CONFIG_SPECS).filter(([, spec]) => spec.type === 'enum')
  const vocabArrays = Object.values(sharedVocab).filter((value) => Array.isArray(value))
  must('确实取到了 enum 键（写法大改要能发现）', () => {
    assert.ok(enumKeys.length >= 6, `只取到 ${enumKeys.length} 个 enum 键`)
  })
  for (const [key, spec] of enumKeys) {
    must(`${key}：取值表是 shared 词表里的同一个数组（不是抄的）`, () => {
      assert.ok(vocabArrays.includes(spec.values),
        `values 不是 config-vocab 里的任何数组：[${spec.values}]`)
    })
    must(`${key}：默认值合法，且两端用的是同一个默认值`, () => {
      assert.ok(spec.values.includes(spec.def), `${spec.def} 不是 ${key} 的合法取值`)
      assert.equal(client.UI_DEFAULTS[key], spec.def, '客户端默认值不来自 spec.def')
    })
  }
}

console.log('\n== 3. 数值边界：客户端夹取区间就是宿主 schema 的区间 ==')
{
  const CLAMPS = {
    silenceMs: client.clampSilenceMs,
    autoSendExtraMs: client.clampAutoSendExtraMs,
    readAloudLag: client.clampReadAloudLag,
    idleReleaseMinutes: client.normalizeIdleReleaseMinutes,
  }
  for (const [key, clamp] of Object.entries(CLAMPS)) {
    const { min, max } = CONFIG_SPECS[key]
    must(`${key}：越界值夹到 schema 的 [${min}, ${max}]`, () => {
      assert.equal(clamp(max + 1), max, `上界失败：${max + 1} → ${clamp(max + 1)}`)
      assert.equal(clamp(min - 1), min, `下界失败：${min - 1} → ${clamp(min - 1)}`)
      assert.equal(clamp('abc'), client.UI_DEFAULTS[key], '非法值应回退客户端默认')
    })
  }
  must('neuralSpeaker：客户端夹到 schema 的区间并按整数收敛', () => {
    const { min, max } = CONFIG_SPECS.neuralSpeaker
    assert.equal(client.normalizeNumber(max + 999, { min, max, fallback: min, integer: true }), max)
    assert.equal(client.normalizeNumber(1.6, { min, max, fallback: min, integer: true }), 2)
  })
  must('idleReleaseMinutes：客户端 UI 档位是宿主允许区间的子集', () => {
    const { min, max, integer } = CONFIG_SPECS.idleReleaseMinutes
    assert.ok(integer, 'schema 这里要求整数，UI 档位就必须都是整数')
    for (const value of client.IDLE_RELEASE_OPTIONS) {
      assert.ok(value >= min && value <= max && Number.isInteger(value),
        `${value} 不在宿主 ${min}..${max} 整数范围内`)
    }
  })
  // 老写法「客户端夹取函数不再自带数字（区间全部来自 schema）」是一条源码正则
  // （matchAll 找 `normalizeNumber(... min: <数字>`），批次 6l-b 起搬进 eslint 的
  // RANGE_LITERAL_BAN：那是写法约定，而且旧正则只认紧贴的一种排版。
  // 行为侧在这儿已经有了 —— 上面那个逐键循环就是拿 schema 的 min/max 真夹真验。
  // 禁令的边界（min/max 报、fallback 与 rangeFor 写法不报）由 test/no-undef.test.mjs 的探针钉住。
}

console.log('\n== 4. 字符串上限与词表上限 ==')
{
  must('客户端 STRING_LIMITS 就是 schema 派生的那张表（同一个对象）', () => {
    assert.equal(client.STRING_LIMITS, CONFIG_MAX_LENS)
    assert.ok(Object.keys(CONFIG_MAX_LENS).length >= 10, `只派生出 ${Object.keys(CONFIG_MAX_LENS).length} 个上限`)
  })
  for (const [key, maxLen] of Object.entries(CONFIG_MAX_LENS)) {
    must(`${key}：maxLen=${maxLen} 是正整数且来自 spec`, () => {
      assert.equal(CONFIG_SPECS[key].maxLen, maxLen)
      assert.ok(Number.isInteger(maxLen) && maxLen > 0, `${maxLen} 不合法`)
    })
  }
  must('超长字符串不会漏到宿主（截断到上限而不是原样保存）', () => {
    const saved = client.normalizeForSave({
      sovitsUrl: 'http://127.0.0.1:9880/' + 'x'.repeat(4000),
      voice: 'v'.repeat(5000),
      neuralModel: 'n'.repeat(5000),
      shortcut: 's'.repeat(5000),
      globalShortcut: 'g'.repeat(5000),
      wakeWord: 'w'.repeat(5000),
      sovitsRefAudio: 'a'.repeat(5000),
      sovitsPromptText: 'p'.repeat(5000),
    })
    const checked = validateConfigPatch(saved)
    assert.equal(checked.ok, true, JSON.stringify(checked.errors))
    // 空串对 sovitsUrl 是合法值（= 用默认地址），截断不能把它变成别的值。
    assert.equal(client.normalizeForSave({ sovitsUrl: '' }).sovitsUrl, '')
  })
  must('词表上限一致', () => {
    assert.equal(client.WORDS_MAX_ENTRIES, MAX_WORDS)
    assert.equal(client.WORDS_MAX_CHARS, MAX_WORD_CHARS)
  })
  must('唤醒词上限与宿主 wakeWord 的 maxLen 一致', () => {
    assert.equal(client.STRING_LIMITS.wakeWord, CONFIG_SPECS.wakeWord.maxLen)
    // 空串是合法值（= 关闭唤醒词），不能被「空 → 默认」的规则吃掉。
    assert.equal(client.normalizeWakeWord(''), '')
  })
}

console.log('\n== 5. 默认值：两端用的是同一张表，且每个键的默认值形状正确 ==')
must('客户端 UI_DEFAULTS 就是宿主的 CONFIG_DEFAULTS（同一个对象）', () => {
  // 「每个键都有客户端默认值」在这种写法下不可能再失守，所以断言从覆盖度升级成引用相同：
  // 一旦有人在客户端又写一份 UI_DEFAULTS 字面量，这条立刻红。
  assert.equal(client.UI_DEFAULTS, CONFIG_DEFAULTS)
})
must('CONFIG_DEFAULTS 由每个键的 def 派生（键序也一致）', () => {
  assert.deepEqual(Object.keys(CONFIG_DEFAULTS), [...CONFIG_SPEC_KEYS])
  for (const key of CONFIG_SPEC_KEYS) {
    assert.equal(CONFIG_DEFAULTS[key], CONFIG_SPECS[key].def, `${key} 的默认值不是 spec.def`)
  }
})
must('每个默认值的形状都符合自己的 type（boolean 的默认值不能是字符串）', () => {
  for (const [key, spec] of Object.entries(CONFIG_SPECS)) {
    const def = spec.def
    switch (spec.type) {
      case 'boolean':
        assert.equal(typeof def, 'boolean', `${key} 默认值 ${JSON.stringify(def)} 不是布尔`)
        break
      case 'number':
        assert.equal(typeof def, 'number', `${key} 默认值不是数字`)
        assert.ok(Number.isFinite(def) && def >= spec.min && def <= spec.max,
          `${key} 默认值 ${def} 不在 ${spec.min}..${spec.max}`)
        break
      case 'enum':
        assert.ok(spec.values.includes(def), `${key} 默认值 ${def} 不在枚举里`)
        break
      case 'string':
        assert.equal(typeof def, 'string', `${key} 默认值不是字符串`)
        assert.ok(def.length <= spec.maxLen, `${key} 默认值超过自己的 maxLen`)
        break
      case 'url':
        assert.equal(typeof def, 'string', `${key} 默认值不是字符串`)
        if (def) {
          // 默认地址必须真的能解析成 http(s)，否则用户一装好就是坏配置。
          let parsed
          try { parsed = new URL(def) } catch { assert.fail(`${key} 默认值不是合法 URL：${def}`) }
          assert.ok(parsed.protocol === 'http:' || parsed.protocol === 'https:', `${key} 默认值协议要是 http(s)`)
        }
        break
      case 'words':
        assert.ok(Array.isArray(def), `${key} 默认值要指数组`)
        break
      default:
        assert.fail(`${key} 的类型 ${spec.type} 不在已知集合里`)
    }
  }
})
// --- 批次 6l-b：宿主那份默认值改成真跑 ---
// 旧判据是两条扫源码的正则（`const DEFAULTS = CONFIG_DEFAULTS` 在不在、
// `const DEFAULTS = {` 有没有），注释里写的理由是「宿主入口一 import 就会拉起接线」——
// 那个前提在 `test/helpers/host-routes.mjs` 之后已经不成立：接线可以被装进临时目录跑。
// 现在把真宿主装起来（空的 DSH_HOME = 磁盘上没有配置文件，rowConfig 不给 = 什么都不覆盖），
// 过一次 GET 配置路由，把**用户实际拿到的那份**逐键对 `CONFIG_DEFAULTS`。
const hostHome = mkdtempSync(path.join(os.tmpdir(), 'dsh-config-contract-'))
const { loadHostRoutes } = await import('./helpers/host-routes.mjs')
const hostEnv = await loadHostRoutes({ dshHome: hostHome })
let hostConfig = null
let hostConfigError = null
try {
  const res = await hostEnv.request('/dsh-voice-typing/config')
  if (res.statusCode !== 200) hostConfigError = `HTTP ${res.statusCode}：${res.text.slice(0, 160)}`
  else hostConfig = res.json()
} catch (error) {
  hostConfigError = String(error?.message ?? error)
} finally {
  hostEnv.restore()
  try {
    rmSync(hostHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch { /* 清理失败不算判据失败 */ }
}
must('宿主装起来后 GET 到的默认值逐键等于 CONFIG_DEFAULTS（旧判据扫的是那句 const DEFAULTS）', () => {
  if (hostConfigError) throw new Error(`配置路由没跑通：${hostConfigError}`)
  assert.ok(hostConfig && Object.keys(hostConfig).length > 0, '配置路由回的是空对象，装的东西没被读到')
  const diff = []
  for (const key of CONFIG_SPEC_KEYS) {
    if (!Object.is(hostConfig[key], CONFIG_DEFAULTS[key])
      && JSON.stringify(hostConfig[key]) !== JSON.stringify(CONFIG_DEFAULTS[key])) {
      diff.push(`${key}：宿主回 ${JSON.stringify(hostConfig[key])}，共享词表是 ${JSON.stringify(CONFIG_DEFAULTS[key])}`)
    }
  }
  assert.deepEqual(diff, [], diff.join('\n    '))
})
must('宿主装起来后不多返回共享 schema 之外的键（私有副本在这里现形）', () => {
  if (hostConfigError) throw new Error(`配置路由没跑通：${hostConfigError}`)
  const known = new Set(CONFIG_SPEC_KEYS)
  const extra = Object.keys(hostConfig).filter((k) => !known.has(k))
  assert.deepEqual(extra, [], `宿主返回了 schema 里没有的键：${extra.join(', ')}`)
})
must('客户端 normalizeForSave 的产出键覆盖宿主 schema 全部键', () => {
  const saved = client.normalizeForSave({})
  const missing = CONFIG_SPEC_KEYS.filter((k) => !(k in saved))
  assert.deepEqual(missing, [], `保存载荷缺键：${missing.join(', ')}`)
})
must('客户端保存产物过得了宿主的严格校验（POST /config 不 400）', () => {
  // 这是这条测试最要紧的一条：客户端归一化的**存在意义**就是
  // 「别让表单值被宿主打回」。漏收敛的字段会在这里现形。
  const cases = [
    { ttsEngine: 'NEURAL', silenceMs: '99999', neuralSpeaker: 9999, rate: 'not-a-rate', wakeWord: '', globalShortcut: 'Ctrl+Alt+V' },
    { sovitsUrl: 'http://127.0.0.1:9880/' + 'x'.repeat(3000) },
    { rate: '+' + '9'.repeat(20) + '%', pitch: '+' + '9'.repeat(20) + 'Hz', volume: '+' + '9'.repeat(20) + '%' },
    { voice: 'v'.repeat(5000), neuralModel: 'n'.repeat(5000), shortcut: 's'.repeat(5000) },
    { words: Array.from({ length: 400 }, (_, i) => 'w' + i) },
  ]
  for (const raw of cases) {
    const saved = client.normalizeForSave(raw)
    const checked = validateConfigPatch(saved)
    assert.equal(checked.ok, true,
      `输入 ${JSON.stringify(raw).slice(0, 60)}… 被宿主打回：${JSON.stringify(checked.errors)}`)
  }
})
must('客户端保存产物不会让宿主清洗报警', () => {
  const saved = client.normalizeForSave({ ttsEngine: 'NEURAL', silenceMs: '99999', readAloudLag: 1000 })
  const host = sanitizeConfig(saved, client.UI_DEFAULTS)
  assert.deepEqual(host.warnings, [], JSON.stringify(host.warnings))
})

console.log('\n== 6. 反向：客户端不许有宿主 schema 不认识的默认键 ==')
{
  // 单源之后「多出/缺少一个键」在结构上已经不可能，所以这条从提示升成硬断言：
  // 键集合必须**正好**等于 CONFIG_SPEC_KEYS（同一份来源）。
  must('UI_DEFAULTS 的键集合 == CONFIG_SPEC_KEYS', () => {
    assert.deepEqual(Object.keys(client.UI_DEFAULTS), [...CONFIG_SPEC_KEYS])
  })
  must('schema 的每个键在设置面板里都有归宿（默认值 + 可保存）', () => {
    // 加配置项的人最容易忘记的是「面板里没这一行」——那条会静默存不回。
    const saved = client.normalizeForSave({})
    for (const key of CONFIG_SPEC_KEYS) {
      assert.ok(key in saved, `normalizeForSave 不产出 ${key}`)
      assert.notEqual(client.UI_DEFAULTS[key], undefined, `没有 ${key} 的默认值`)
    }
  })
}

if (warnings.length) {
  console.log('\n提示（不计失败，属有意差异）')
  for (const w of warnings) console.log('  · ' + w)
}
console.log(`\n通过 ${passed + warnings.length}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
