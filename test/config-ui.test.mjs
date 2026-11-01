/**
 * 配置加固（客户端）行为测试 —— 覆盖 task-18 的 1/2/3/4/5/6/7/8 关键点。
 *
 * 两类断言：
 *   A. 纯函数（模块导出的 `__test`）：引擎/枚举/数值归一化、词表文本↔数组、
 *      保存前 normalizeForSave（含 neuralModel 残留纠正、模型语言过滤、
 *      单说话人归零、默认值对齐）、400 校验错误转可读文案、/tts 回退头解析、
 *      /tts/env 引擎行归一化（含宿主新增的 sovits 行）；
 *   B. SSR / 源码形状：设置面板的关键显隐、词表输入不再逐键归一化、
 *      引擎回退提示接到 hint 与诊断快照、保存错误可读展示。
 *
 * 不做真实浏览器交互（无 jsdom）；交互路径用「纯函数 + 源码形状」覆盖。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(ROOT + 'package.json')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

global.window = { __ModuleLoader__: { load: (spec) => { global.__spec = spec } } }
await import('../lib/client.js')

const factory = global.__spec.factory
const mod = factory((name) => {
  if (name === 'react') return React
  if (name === 'react/jsx-runtime') return require('react/jsx-runtime')
  throw new Error('unknown require: ' + name)
})
const T = mod.__test
if (!T) {
  console.error('✗ lib/client.js 没有导出 __test（构建产物过期？先 node scripts/bundle-client.mjs）')
  process.exit(1)
}

const registrations = []
const slots = {
  inject: (_name, fn) => fn(),
  register: (options, component) => { registrations.push({ options, component }); return () => {} },
}
const locale = { register: () => () => {} }
const effect = (fn) => { fn(); return () => {} }
mod.apply({ inject: (_names, cb) => cb({ slots, locale, effect }) })
const SettingsSection = registrations.find((r) => r.options?.name === 'settings.section').component

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')) }
}

const CLI = fs.readFileSync(ROOT + 'lib/client.js', 'utf8')
const HOST = fs.readFileSync(ROOT + 'lib/index.js', 'utf8')

function render(configOverrides = {}, models = []) {
  const config = {
    model: 'sensevoice', language: 'auto', liveAsr: 'full', ttsEngine: 'online',
    voice: 'zh-CN-XiaoxiaoNeural', localVoice: '', neuralModel: 'vits-melo-zh_en',
    neuralSpeaker: 0, sovitsUrl: 'http://127.0.0.1:9880', sovitsRefAudio: '',
    sovitsPromptText: '', sovitsTextLang: 'zh', sovitsPromptLang: 'zh',
    rate: '+10%', pitch: '+0Hz', volume: '+0%',
    ttsFormat: 'AUDIO_24KHZ_48KBITRATE_MONO_MP3', autoSend: true, readAloud: true,
    readAloudLag: 7.5, mode: 'toggle', silenceMs: 1500, autoSendExtraMs: 1200,
    removeFillers: false, words: [], shortcut: 'Alt+V', idleReleaseMinutes: 10,
    preloadModels: true,
    ...configOverrides,
  }
  return renderToStaticMarkup(React.createElement(SettingsSection, {
    __initialConfig: config, __initialModels: models, t: (k) => k,
  }))
}

/* ================================================================ */
console.log('A. 纯函数：默认值对齐宿主 DEFAULTS')
{
  // 从宿主源码解析 DEFAULTS 的键集合与关键默认值（宿主模块没导出 DEFAULTS）。
  const defaultsBlock = /const DEFAULTS = \{([\s\S]*?)\n\}/
    .exec(HOST)?.[1] ?? ''
  const hostKeys = [...defaultsBlock.matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((m) => m[1]).sort()
  const clientKeys = Object.keys(T.UI_DEFAULTS).sort()
  check('UI 默认配置键集合 == 宿主 DEFAULTS 键集合', JSON.stringify(hostKeys) === JSON.stringify(clientKeys),
    `host=${hostKeys.length} client=${clientKeys.length}`)
  for (const [key, expected] of [
    ['rate', '+10%'], ['pitch', '+0Hz'], ['volume', '+0%'],
    ['shortcut', 'Alt+V'], ['language', 'auto'], ['mode', 'toggle'],
    ['model', 'sensevoice'], ['liveAsr', 'full'], ['ttsEngine', 'online'],
    ['silenceMs', 1500], ['autoSendExtraMs', 1200], ['readAloudLag', 7.5],
    ['idleReleaseMinutes', 10], ['neuralSpeaker', 0],
    ['ttsFormat', 'AUDIO_24KHZ_48KBITRATE_MONO_MP3'],
    ['sovitsTextLang', 'zh'], ['sovitsPromptLang', 'zh'],
  ]) {
    check(`UI_DEFAULTS.${key} == ${JSON.stringify(expected)}`, T.UI_DEFAULTS[key] === expected, String(T.UI_DEFAULTS[key]))
  }
  check('宿主 DEFAULTS.rate 确实是 +10%（UI 不再用 +0%）', /rate: '\+10%'/.test(HOST))
  check('宿主 DEFAULTS.shortcut 确实是 Alt+V', /shortcut: 'Alt\+V'/.test(HOST))
}

console.log('\nA. 纯函数：引擎/枚举/数值归一化')
{
  check('normalizeEngine 大小写/空白', T.normalizeEngine(' SOVITS ') === 'sovits')
  check('normalizeEngine 非法 → 空串', T.normalizeEngine('gpt-sovits') === '')
  check('normalizeEngine null → 空串', T.normalizeEngine(null) === '')
  check('normalizeLanguage 非法 → auto', T.normalizeLanguage('xx') === 'auto')
  check('normalizeLanguage 合法保留', T.normalizeLanguage('YUE') === 'yue')
  check('normalizeSovitsLang 非法 → zh', T.normalizeSovitsLang('fr') === 'zh')
  check('clampAutoSendExtraMs 空串 → 1200（不是 0）', T.clampAutoSendExtraMs('') === 1200)
  check('clampAutoSendExtraMs 非法 → 1200', T.clampAutoSendExtraMs('abc') === 1200)
  check('clampAutoSendExtraMs 越界 → 5000', T.clampAutoSendExtraMs('99999') === 5000)
  check('clampAutoSendExtraMs 0 保留', T.clampAutoSendExtraMs('0') === 0)
  check('clampSilenceMs 空串 → 1500', T.clampSilenceMs('') === 1500)
  check('clampSilenceMs 越界→夹取', T.clampSilenceMs('100') === 500)
  check('clampReadAloudLag 空串 → 7.5', T.clampReadAloudLag('') === 7.5)
  check('clampReadAloudLag 0.5 步进', T.clampReadAloudLag('7.3') === 7.5)
  check('clampReadAloudLag 上限 120', T.clampReadAloudLag('999') === 120)
}

console.log('\nA. 纯函数：词表文本 ↔ 数组')
{
  check('parseWordsText 去空行/trim', JSON.stringify(T.parseWordsText('  正确=错误 \n\n 热词 \n')) === JSON.stringify(['正确=错误', '热词']))
  check('parseWordsText 保留单词中间空格', JSON.stringify(T.parseWordsText('hello world=hello word')) === JSON.stringify(['hello world=hello word']))
  check('parseWordsText 单条截断到 100 字符', T.parseWordsText('x'.repeat(150))[0].length === 100)
  const many = Array.from({ length: 260 }, (_, i) => '词' + i).join('\n')
  check('parseWordsText 最多 200 条', T.parseWordsText(many).length === 200)
  check('formatWordsText 用换行连接', T.formatWordsText(['a', 'b c']) === 'a\nb c')
  check('formatWordsText 非数组 → 空串', T.formatWordsText(null) === '')
  // 关键回归：输入法打空格/换行不能被逐键吞掉 —— 显示用 formatWordsText(原始文本) 时内容不变。
  const raw = '你好 世界\n第二行'
  check('词表原始文本可原样保留空格与换行', T.formatWordsText(T.parseWordsText(raw)) === raw)
}

console.log('\nA. 纯函数：normalizeForSave')
{
  const normalized = T.normalizeForSave({
    ttsEngine: 'BOGUS', language: 'xx', liveAsr: 'weird', mode: 'bad',
    rate: 'nope', pitch: 'nope', volume: 'nope', ttsFormat: 'nope',
    silenceMs: '1', autoSendExtraMs: '', readAloudLag: '999',
    shortcut: '   ', words: [' 正确=错误 ', '', '热词'], autoSend: 0, readAloud: 'yes',
    preloadModels: 0, removeFillers: 'yes', idleReleaseMinutes: '9999',
    sovitsTextLang: 'fr', sovitsPromptLang: null, sovitsUrl: '  http://x  ',
    voice: '  ', neuralSpeaker: '3.7', model: '',
  })
  check('非法引擎 → online', normalized.ttsEngine === 'online')
  check('非法语言 → auto', normalized.language === 'auto')
  check('非法 liveAsr/mode/rate/pitch/volume/ttsFormat → 默认',
    normalized.liveAsr === 'full' && normalized.mode === 'toggle' && normalized.rate === '+10%'
    && normalized.pitch === '+0Hz' && normalized.volume === '+0%'
    && normalized.ttsFormat === 'AUDIO_24KHZ_48KBITRATE_MONO_MP3')
  check('数值夹取/回退', normalized.silenceMs === 500 && normalized.autoSendExtraMs === 1200
    && normalized.readAloudLag === 120 && normalized.idleReleaseMinutes === 1440)
  check('列表外的合法 rate 保留（不悄悄改成默认）',
    T.normalizeForSave({ rate: '+25%' }).rate === '+25%')
  check('坏形状的 rate 回退默认', T.normalizeForSave({ rate: 'nope' }).rate === '+10%')
  check('ttsFormat 非枚举回退默认',
    T.normalizeForSave({ ttsFormat: 'WAV' }).ttsFormat === 'AUDIO_24KHZ_48KBITRATE_MONO_MP3')
  check('空 shortcut → 默认 Alt+V', normalized.shortcut === 'Alt+V')
  check('词表归一化', JSON.stringify(normalized.words) === JSON.stringify(['正确=错误', '热词']))
  check('布尔值归一化', normalized.autoSend === true && normalized.readAloud === false
    && normalized.preloadModels === true && normalized.removeFillers === false)
  check('sovits 语言非法 → zh', normalized.sovitsTextLang === 'zh' && normalized.sovitsPromptLang === 'zh')
  check('字符串 trim', normalized.sovitsUrl === 'http://x' && normalized.voice === 'zh-CN-XiaoxiaoNeural')
  check('model 空 → 默认 sensevoice', normalized.model === 'sensevoice')
  check('neuralSpeaker 取整', normalized.neuralSpeaker === 4)

  // neuralModel 残留：不在已就绪列表 → 自动纠正
  const fixedModel = T.normalizeForSave(
    { ttsEngine: 'neural', neuralModel: 'vits-gone' },
    { readyNeuralIds: ['vits-melo-zh_en'], neuralSpeakers: 4 },
  )
  check('neuralModel 未安装 → 自动改用第一个已就绪模型', fixedModel.neuralModel === 'vits-melo-zh_en')
  // 单说话人 → speaker 归 0
  const single = T.normalizeForSave({ ttsEngine: 'neural', neuralSpeaker: 3 }, { neuralSpeakers: 1 })
  check('单说话人模型 → neuralSpeaker 归 0', single.neuralSpeaker === 0)
  // 识别语言按模型过滤
  const whisper = T.normalizeForSave({ language: 'ja' }, { asrModel: { engine: 'whisper', languages: ['zh', 'en'] } })
  check('Whisper 模型 → language 归 auto（该模型不消费语言）', whisper.language === 'auto')
  const limited = T.normalizeForSave({ language: 'ja' }, { asrModel: { engine: 'sensevoice', languages: ['zh', 'en'] } })
  check('SenseVoice 不支持的语言 → auto', limited.language === 'auto')
  const supported = T.normalizeForSave({ language: 'ja' }, { asrModel: { engine: 'sensevoice', languages: ['zh', 'en', 'ja'] } })
  check('SenseVoice 支持的语言保留', supported.language === 'ja')
}

console.log('\nA. 纯函数：保存错误 / TTS 回退头 / env 引擎行')
{
  check('errors 对象数组 → 可读文案',
    JSON.stringify(T.collectSaveErrors({ ok: false, errors: [{ key: 'ttsEngine', reason: '必须是 online/neural/local/sovits' }] }))
      === JSON.stringify(['ttsEngine：必须是 online/neural/local/sovits']))
  check('errors 字符串数组', JSON.stringify(T.collectSaveErrors({ errors: ['a', 'b'] })) === JSON.stringify(['a', 'b']))
  check('{error: string}', JSON.stringify(T.collectSaveErrors({ error: 'bad' })) === JSON.stringify(['bad']))
  check('ok:false 无原因 → 兜底文案', T.collectSaveErrors({ ok: false }).length === 1)
  check('空 payload 不崩', Array.isArray(T.collectSaveErrors(null)) && T.collectSaveErrors(null).length === 0)

  const headers = { get: (name) => (name === 'x-tts-engine-fallback' ? 'online' : name === 'x-tts-engine' ? 'edge' : '') }
  const meta = T.extractTtsMeta(headers)
  check('extractTtsMeta 读取回退目标', meta.fallback === 'online' && meta.engine === 'edge')
  check('extractTtsMeta 普通对象', T.extractTtsMeta({ 'x-tts-engine-fallback': 'local' }).fallback === 'local')
  check('extractTtsMeta 无 headers → 空串', T.extractTtsMeta(undefined).fallback === '')

  const env = {
    configured: 'sovits',
    engines: [
      { id: 'online', label: 'Edge', available: true, detail: 'ok' },
      { id: 'neural', label: 'Neural', available: false, detail: 'missing' },
      // 宿主新增的 sovits 行：字段形状不同（supported/url/configured），不能崩；
      // 外部服务不探测 → 不显示成 ✓/✗（中性状态）。
      { id: 'sovits', label: 'GPT-SoVITS', supported: true, configured: true, url: 'http://127.0.0.1:9880' },
    ],
  }
  const rows = T.formatEnvEngines(env, 'online')
  check('formatEnvEngines 行数', rows.length === 3)
  check('formatEnvEngines 状态映射', rows[0].status === 'ok' && rows[1].status === 'bad' && rows[2].status === '')
  check('formatEnvEngines sovits 行用 url 兜底 detail', rows[2].detail === 'http://127.0.0.1:9880')
  check('formatEnvEngines 标出 configured 当前引擎', rows[2].current === true && rows[0].current === false)

  check('validateShortcut 合法', T.validateShortcut('Alt+V').ok === true)
  check('validateShortcut 非法', T.validateShortcut('v').ok === false)
}

/* ================================================================ */
console.log('\nB. SSR：关键显隐与提示')
{
  const off = render({ readAloud: false })
  check('readAloud=false：引擎设置仍可见（可预配）', off.includes('ttsEngine'))
  check('readAloud=false：显示「仅保存、不生效」提示', off.includes('readAloudOffNotice'))

  const invalidEngine = render({ ttsEngine: 'bogus' })
  check('非法引擎值：显示提示', invalidEngine.includes('ttsEngineInvalid'))
  check('非法引擎值：按 online 渲染（显示音调）', invalidEngine.includes('pitch'))

  const staleNeural = render({ ttsEngine: 'neural', neuralModel: 'vits-gone' }, [
    { id: 'vits-melo-zh_en', label: 'MeloTTS', category: 'tts', ready: true, speakers: 1, bytes: 1 },
  ])
  check('神经模型未安装：显示保存自动纠正提示', staleNeural.includes('neuralModelMissingWarning'))

  const whisper = render({ model: 'whisper-tiny' }, [
    { id: 'whisper-tiny', label: 'Whisper', category: 'asr', ready: true, engine: 'whisper', languages: ['zh', 'en'] },
  ])
  check('Whisper：语言下拉禁用 + 提示', whisper.includes('languageModelUnsupported'))
}

console.log('\nB. 源码形状：词表输入 / 回退提示 / 保存错误')
{
  check('词表输入框绑定原始文本 state（不再每键 split/trim/filter）',
    /value: wordsText/.test(CLI) && /setWordsText\(event\.target\.value\)/.test(CLI))
  check('词表失焦/保存时才归一化',
    /onBlur: \(\) => set\('words', parseWordsText\(wordsText\)\)/.test(CLI)
    && /words: parseWordsText\(wordsText\)/.test(CLI))
  check('旧的逐键归一化已移除',
    !/set\('words', event\.target\.value\.split\('\\n'\)/.test(CLI))
  check('词表 hint 写明热词仅 Zipformer2',
    /Zipformer2/.test(CLI) && /热词提示/.test(CLI))

  check('/tts 响应头读取回退标记',
    /x-tts-engine-fallback/.test(CLI) && /x-tts-engine/.test(CLI))
  check('回退提示接到现有 hint 机制',
    /ttsFallbackOnline/.test(CLI) && /ttsFallbackLocal/.test(CLI) && /setHint\(t\(fallbackKey\)/.test(CLI))
  check('回退次数进诊断快照（ttsFallbacks）',
    /ttsFallbacks: ttsFallbackCount/.test(CLI) && /lastTtsFallback/.test(CLI))

  check('保存错误可读展示（saveErrors 渲染）',
    /saveErrors\.length/.test(CLI) && /saveErrors\.map/.test(CLI))
  check('保存 POST 归一化后的 payload', /normalizeForSave\(/.test(CLI) && /JSON\.stringify\(payload\)/.test(CLI))
  check('快捷键非法时保存按钮禁用',
    /saveDisabled = !dirty \|\| !loaded \|\| !shortcutCheck\.ok/.test(CLI))
  check('设置面板卸载时复位 shortcutFieldFocused',
    /shortcutFieldFocused = false \}, \[\]\)/.test(CLI))
}

console.log('\nC. 布局重构：6 组分区 + 说明 + 折叠 + 并排（task-19）')
{
  // 组件实现：Section 可折叠/说明；Row 是模块级 grid 组件（不能在组件体内定义，
  // 否则每次渲染类型变化 → 输入框失焦）。
  check('Section 支持 subtitle/collapsible/defaultOpen',
    /props\.subtitle/.test(CLI) && /props\.collapsible/.test(CLI) && /props\.defaultOpen/.test(CLI))
  check('Section 用原生 details/summary 实现折叠',
    /React\.createElement\(\s*'details'/.test(CLI) && /React\.createElement\(\s*'summary'/.test(CLI))
  check('Row 用 grid auto-fit 并排短字段',
    /const Row = \(props\) => React\.createElement\(/.test(CLI) && /minmax\(220px, 1fr\)/.test(CLI))
  check('Row 定义在模块级、位于设置组件之前',
    CLI.indexOf('const Row = (props)') >= 0
    && CLI.indexOf('const Row = (props)') < CLI.indexOf('function VoiceSettingsSection'))

  const html = render({})
  const groups = ['secRecognition', 'secInteraction', 'secText', 'secSynthesis', 'secModels', 'secAdvanced']
  const positions = groups.map((key) => html.indexOf('>' + key + '<'))
  check('6 个分组全部渲染', positions.every((i) => i >= 0), JSON.stringify(positions))
  check('分组顺序固定', positions.every((v, i) => i === 0 || v > positions[i - 1]))

  const sliceOf = (startKey, endKey) => {
    const start = html.indexOf('>' + startKey + '<')
    const end = endKey === null ? html.indexOf('</details>', start) : html.indexOf('>' + endKey + '<')
    return start >= 0 && end > start ? html.slice(start, end) : ''
  }
  const synthesis = sliceOf('secSynthesis', 'secModels')
  const models = sliceOf('secModels', 'secAdvanced')
  const advanced = sliceOf('secAdvanced', null)
  check('「当前合成方式」在合成组顶部（不再在模型组）',
    synthesis.includes('ttsCurrent') && !models.includes('ttsCurrent'))
  check('高级组无配置控件（纯说明）',
    !advanced.includes('<input') && !advanced.includes('<select')
    && !advanced.includes('<textarea') && !advanced.includes('<button'))
  const detailsTags = html.match(/<details[^>]*>/g) || []
  check('6 组都可折叠，高级组默认收起',
    detailsTags.length === 6
    && detailsTags.slice(0, 5).every((tag) => /\bopen\b/.test(tag))
    && !/\bopen\b/.test(detailsTags[5]))
  check('分组说明齐全',
    ['secRecognitionHint', 'secInteractionHint', 'secTextHint', 'secSynthesisHint', 'secModelsHint', 'secAdvancedHint']
      .every((key) => html.includes(key)))
  check('以并排短字段行承载数值字段（≥3 行）',
    (html.match(/minmax\(220px, 1fr\)/g) || []).length >= 3)
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exit(1)
