/**
 * 配置 schema 的单元测试（纯函数）。
 *
 * 覆盖：
 *   - 枚举（大小写/空格归一化、非法回退）；
 *   - 布尔、数值范围、数字字符串强转、整数规则；
 *   - 字符串 trim / 长度上限 / 空串合法；
 *   - URL（http(s) 合法、空串=默认、非法/协议不对回退）；
 *   - words（字符串 trim、对象 {correct,replace} 归一化、去空、上限）；
 *   - sanitizeConfig：非法值回退默认 + warnings、越界 clamp、未知键忽略、输出键完整；
 *   - validateConfigPatch：错误聚合、未知键忽略、空串合法、数字字符串强转；
 *   - normalizeTtsEngine：trim/小写/非法返回 ''（绝不默认 online）。
 *
 * 运行：node test/config-schema.test.mjs
 */
import {
  TTS_ENGINES,
  CONFIG_SPEC_KEYS,
  MAX_WORDS,
  MAX_WORD_CHARS,
  normalizeTtsEngine,
  sanitizeConfig,
  validateConfigPatch,
} from '../lib/config-schema.js'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

/** 与 lib/index.js 的 DEFAULTS 同形的默认配置（用于测试 sanitize）。 */
const DEFAULTS = {
  model: 'sensevoice',
  language: 'auto',
  liveAsr: 'full',
  ttsEngine: 'online',
  voice: 'zh-CN-XiaoxiaoNeural',
  localVoice: '',
  neuralModel: 'vits-melo-zh_en',
  neuralSpeaker: 0,
  sovitsUrl: 'http://127.0.0.1:9880',
  sovitsRefAudio: '',
  sovitsPromptText: '',
  sovitsTextLang: 'zh',
  sovitsPromptLang: 'zh',
  rate: '+10%',
  pitch: '+0Hz',
  volume: '+0%',
  ttsFormat: 'AUDIO_24KHZ_48KBITRATE_MONO_MP3',
  autoSend: true,
  readAloud: false,
  readAloudLag: 7.5,
  mode: 'toggle',
  silenceMs: 1500,
  autoSendExtraMs: 1200,
  removeFillers: false,
  words: [],
  shortcut: 'Alt+V',
  idleReleaseMinutes: 10,
  preloadModels: true,
}

console.log('== 0. schema 覆盖 28 个配置键 ==')
check('schema 键数为 28', CONFIG_SPEC_KEYS.length === 28, String(CONFIG_SPEC_KEYS.length))
check('DEFAULTS 与 schema 键集合一致（无遗漏/多余）',
  Object.keys(DEFAULTS).length === 28 &&
  Object.keys(DEFAULTS).every((key) => CONFIG_SPEC_KEYS.includes(key)) &&
  CONFIG_SPEC_KEYS.every((key) => key in DEFAULTS),
  JSON.stringify({ defaults: Object.keys(DEFAULTS), spec: CONFIG_SPEC_KEYS }))

console.log('\n== 1. normalizeTtsEngine ==')
for (const [input, expect] of [
  ['online', 'online'],
  ['LOCAL', 'local'],
  [' neural ', 'neural'],
  ['Sovits', 'sovits'],
  ['', ''],
  ['ftp', ''],
  ['sovits2', ''],
  [123, ''],
  [null, ''],
  [undefined, ''],
]) {
  check(`normalizeTtsEngine(${JSON.stringify(input)}) === ${JSON.stringify(expect)}`,
    normalizeTtsEngine(input) === expect, String(normalizeTtsEngine(input)))
}
check('非法引擎不会默认成 online（审计 D1 的根因）', normalizeTtsEngine('bogus') === '')
check('TTS_ENGINES 含 sovits', TTS_ENGINES.includes('sovits'))

console.log('\n== 2. sanitizeConfig：枚举/布尔/数值/字符串/URL/words ==')
{
  const { config, warnings } = sanitizeConfig({
    ttsEngine: 123,
    language: 'ZH',
    liveAsr: 'STREAM',
    mode: 'auto',
    autoSend: 'yes',
    readAloud: 1,
    readAloudLag: 'abc',
    silenceMs: 100,
    autoSendExtraMs: 999999,
    neuralSpeaker: -3,
    idleReleaseMinutes: 0,
    model: 42,
    sovitsUrl: 'ftp://x',
    sovitsTextLang: 'auto',
    sovitsPromptLang: 'EN',
    words: ['  热词  ', '', 42, { correct: '正确', replace: '错误' }, { correct: ' ' }],
  }, DEFAULTS)
  const byKey = Object.fromEntries(warnings.map((w) => [w.key, w.reason]))
  check('枚举大小写归一生效', config.language === 'zh' && config.liveAsr === 'stream')
  check('非法枚举回退默认', config.ttsEngine === 'online' && config.mode === 'toggle' && config.sovitsTextLang === 'zh')
  check('枚举大小写归一（sovitsPromptLang EN→en）', config.sovitsPromptLang === 'en')
  check('布尔严格类型（字符串/数字回退默认）', config.autoSend === true && config.readAloud === false)
  check('数字字符串非法 → 回退默认', config.readAloudLag === 7.5 && byKey.readAloudLag)
  check('数值越界 clamp', config.silenceMs === 500 && config.autoSendExtraMs === 5000)
  check('负整数回退下限', config.neuralSpeaker === 0)
  check('整数上限内的合法值保留（0 分钟=永不释放）', config.idleReleaseMinutes === 0)
  check('非字符串的 string 键回退默认', config.model === 'sensevoice')
  check('URL 协议不合法回退默认', config.sovitsUrl === DEFAULTS.sovitsUrl && byKey.sovitsUrl)
  check('words 归一化（trim/去空/对象转字符串形式）',
    JSON.stringify(config.words) === JSON.stringify(['热词', '正确=错误']), JSON.stringify(config.words))
  check('非法项都有 warning', ['ttsEngine', 'autoSend', 'readAloudLag', 'model', 'sovitsUrl'].every((key) => byKey[key]))
  check('输出包含全部 28 键（GET /config 完整性）', Object.keys(config).length === 28, String(Object.keys(config).length))
  check('未知键被忽略', !('hackKey' in sanitizeConfig({ hackKey: 1 }, DEFAULTS).config))
}
{
  const { config } = sanitizeConfig({
    sovitsUrl: '',
    voice: '   ',
    words: ['  a  ', 'b'],
  }, DEFAULTS)
  check('空 URL 回退默认地址', config.sovitsUrl === DEFAULTS.sovitsUrl)
  check('字符串 trim', config.voice === '')
  check('words 字符串 trim', JSON.stringify(config.words) === JSON.stringify(['a', 'b']))
}
{
  const many = Array.from({ length: MAX_WORDS + 5 }, (_, i) => 'w' + i)
  const { config, warnings } = sanitizeConfig({ words: many }, DEFAULTS)
  check('words 截断到上限', config.words.length === MAX_WORDS)
  check('words 超限有 warning', warnings.some((w) => w.key === 'words'))
}
{
  const longWord = 'x'.repeat(MAX_WORD_CHARS + 10)
  const { config } = sanitizeConfig({ words: [longWord] }, DEFAULTS)
  check('words 单条超长被截断', config.words[0].length === MAX_WORD_CHARS)
}
{
  const { config, warnings } = sanitizeConfig({
    ttsEngine: 'sovits',
    readAloudLag: 200,
    sovitsUrl: 'https://example.com/tts',
  }, DEFAULTS)
  check('干净配置无 warning（除 clamp 外）', warnings.length === 1 && warnings[0].key === 'readAloudLag')
  check('越界数值 clamp 到 120', config.readAloudLag === 120)
  check('合法 https URL 保留', config.sovitsUrl === 'https://example.com/tts')
}
check('null/数组配置整份回退默认', (() => {
  const a = sanitizeConfig(null, DEFAULTS).config
  const b = sanitizeConfig([], DEFAULTS).config
  return a.ttsEngine === 'online' && b.ttsEngine === 'online' && Object.keys(a).length === 28
})())

console.log('\n== 3. validateConfigPatch：严格校验 + 错误聚合 ==')
{
  const bad = validateConfigPatch({
    ttsEngine: 123,
    readAloudLag: 'abc',
    neuralSpeaker: 9999,
    sovitsUrl: 'ftp://x',
    sovitsTextLang: 'auto',
    unknownKey: 'ignored',
  })
  check('非法 patch 返回 ok:false', bad.ok === false)
  check('错误按 key 聚合（5 条）', bad.errors.length === 5 &&
    ['ttsEngine', 'readAloudLag', 'neuralSpeaker', 'sovitsUrl', 'sovitsTextLang'].every(
      (key) => bad.errors.some((e) => e.key === key)),
    JSON.stringify(bad.errors))
  check('未知键不报错也不写入', !bad.errors.some((e) => e.key === 'unknownKey'))
}
{
  const good = validateConfigPatch({
    ttsEngine: ' SoViTs ',
    readAloudLag: '15',
    silenceMs: '1500',
    neuralSpeaker: '2',
    sovitsUrl: 'http://127.0.0.1:9880',
    sovitsTextLang: 'JA',
    words: ['词', { correct: '对', replace: '错' }],
    unknownKey: 'ignored',
  })
  check('合法 patch 返回 ok:true', good.ok === true, JSON.stringify(good))
  check('引擎 trim+小写归一', good.value.ttsEngine === 'sovits')
  check('数字字符串安全强转', good.value.readAloudLag === 15 && good.value.silenceMs === 1500 && good.value.neuralSpeaker === 2)
  check('枚举大小写归一', good.value.sovitsTextLang === 'ja')
  check('words 对象写法归一化', JSON.stringify(good.value.words) === JSON.stringify(['词', '对=错']))
  check('未知键被忽略', !('unknownKey' in good.value))
}
{
  const emptyUrl = validateConfigPatch({ sovitsUrl: '' })
  check('空 URL 合法（表示使用默认地址）', emptyUrl.ok === true && emptyUrl.value.sovitsUrl === '')
  const emptyVoice = validateConfigPatch({ voice: '' })
  check('空字符串对 string 键合法（清空/回退默认）', emptyVoice.ok === true && emptyVoice.value.voice === '')
}
{
  const cases = [
    ['布尔键传字符串', { autoSend: 'yes' }],
    ['数值键传布尔', { readAloudLag: true }],
    ['整数键传小数', { neuralSpeaker: 1.5 }],
    ['数值超出范围', { silenceMs: 999999 }],
    ['字符串键传数字', { model: 123 }],
    ['URL 传非字符串', { sovitsUrl: 42 }],
    ['words 非数组', { words: 'a' }],
    ['words 条目为空', { words: ['  '] }],
    ['words 超上限', { words: Array.from({ length: MAX_WORDS + 1 }, (_, i) => 'w' + i) }],
    ['words 单条超长', { words: ['x'.repeat(MAX_WORD_CHARS + 1)] }],
    ['配置不是对象', ['array']],
    ['配置为 null', null],
  ]
  for (const [name, patch] of cases) {
    check(`拒绝：${name}`, validateConfigPatch(patch).ok === false, JSON.stringify(validateConfigPatch(patch)))
  }
}
{
  const partial = validateConfigPatch({})
  check('空对象合法且 value 为空（等价不做修改）', partial.ok === true && Object.keys(partial.value).length === 0)
}
{
  const patch = validateConfigPatch({ ttsEngine: 'online', readAloud: true, words: [] })
  check('合法 patch 只含提交的键', Object.keys(patch.value).sort().join(',') === 'readAloud,ttsEngine,words'.split(',').sort().join(','))
}
check('sanitize 与 validate 对同一组合法的取值一致（引擎）',
  sanitizeConfig({ ttsEngine: 'LOCAL' }, DEFAULTS).config.ttsEngine === 'local' &&
  validateConfigPatch({ ttsEngine: 'LOCAL' }).value.ttsEngine === 'local')

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exitCode = failed ? 1 : 0
