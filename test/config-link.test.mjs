/**
 * 配置联动测试。
 *
 * 设置面板有一堆「只在特定条件下才有意义」的参数：
 *   - 「朗读回复」关闭时，合成设置仍然可见但**仅保存、不生效**（允许预配 TTS）
 *   - 音调只有在线 Edge 支持
 *   - 音量神经模型 / GPT-SoVITS 不支持
 *   - 音频格式只有在线支持
 *   - 说话人只有「多说话人」神经模型才有意义
 *   - 「发送前等待」只有自动发送打开时才有意义
 *   - 模型下拉只列已下载可用的
 *   - 识别语言只有 SenseVoice 支持；其它模型禁用并提示
 *   - 流式实时字依赖 zipformer2；「说完就关」依赖自动发送
 *
 * 这些条件很容易在改代码时被改坏，而且从界面上看不出来。
 * 这里直接渲染设置面板，检查该出现的出现了、该消失/禁用的消失了。
 *
 * 用法：node test/config-link.test.mjs
 */
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// 基于当前文件位置，不写死本地路径 —— 换台机器、换个目录也能跑。
const require = createRequire(fileURLToPath(new URL('..', import.meta.url)))
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

const registrations = []
const slots = {
  inject: (_name, fn) => fn(),
  register: (options, component) => {
    registrations.push({ options, component })
    return () => {}
  },
}
const locale = { register: () => () => {} }
const effect = (fn) => { fn(); return () => {} }
mod.apply({ inject: (_names, cb) => cb({ slots, locale, effect }) })

const settingsReg = registrations.find((r) => r.options.name === 'settings.section')
if (!settingsReg) {
  console.error('✗ 找不到 settings.section 注册')
  process.exit(1)
}
const SettingsSection = settingsReg.component

let passed = 0
let failed = 0

/**
 * 假的模型列表：模拟「模型已下载可用」的状态。
 * 组件从宿主接口拿真实列表，测试里直接注入。
 */
let fakeModels = []
const setFakeModels = (list) => { fakeModels = list }

/**
 * 用给定配置渲染设置面板。
 * @param {object} overrides - 覆盖的配置。
 * @returns {string} 渲染结果字符串（含标签与文本）。
 */
function render(overrides = {}) {
  const config = {
    model: 'sensevoice',
    language: 'auto',
    liveAsr: 'full',
    ttsEngine: 'online',
    voice: 'zh-CN-XiaoxiaoNeural',
    localVoice: 'Microsoft Huihui Desktop',
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
    readAloud: true,
    readAloudLag: 7.5,
    mode: 'toggle',
    silenceMs: 1500,
    autoSendExtraMs: 1200,
    removeFillers: false,
    words: [],
    shortcut: 'Alt+V',
    idleReleaseMinutes: 10,
    preloadModels: true,
    // 全局语音 / AI 界面操控（v1）：与宿主 DEFAULTS 同键名同默认值。
    globalVoice: false,
    globalShortcut: 'Ctrl+Alt+V',
    voicePromptMode: 'queue',
    uiControl: false,
    uiConfirm: true,
    globalHotkeyHelper: false,
    // v3：唤醒词（默认「小D」；空串 = 关闭）。
    wakeWord: '小鱼',
    ...overrides,
  }
  // 传 t 透传 key，这样断言可以针对稳定的 key 而不是中文文案
  return renderToStaticMarkup(React.createElement(SettingsSection, { __initialConfig: config, t: (k) => k, __initialModels: fakeModels }))
}

/**
 * 断言检查。
 * @param {string} name - 用例名。
 * @param {boolean} condition - 条件。
 * @param {string} detail - 说明。
 */
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name} ${detail}`) }
}

const MODELS_BOTH = [
  { id: 'sensevoice', label: 'SenseVoice', category: 'asr', ready: true, host: true, bytes: 0, engine: 'sensevoice', languages: ['zh', 'en', 'yue', 'ja', 'ko'] },
  { id: 'whisper-tiny', label: 'Whisper tiny', category: 'asr', ready: true, bytes: 100, engine: 'whisper', languages: ['zh', 'en'] },
  { id: 'vits-melo-zh_en', label: 'MeloTTS', category: 'tts', ready: true, speakers: 1, bytes: 100, engine: 'vits' },
]

console.log('=== 配置联动测试 ===\n')

// ── 1. 朗读总开关：关闭时仍可预配 TTS ─────────────────
console.log('[1] 朗读总开关（关闭时仍允许预配合成设置）')
{
  setFakeModels(MODELS_BOTH)
  const on = render({ readAloud: true })
  const off = render({ readAloud: false })
  check('开启时显示引擎选择', on.includes('ttsEngine'))
  check('开启时不显示「朗读已关闭」提示', !on.includes('readAloudOffNotice'))
  check('关闭时仍显示引擎选择（可预配）', off.includes('ttsEngine'))
  check('关闭时仍显示语速（可预配）', off.includes('rate'))
  check('关闭时仍显示音调（可预配）', off.includes('pitch'))
  check('关闭时显示「仅保存、不生效」提示', off.includes('readAloudOffNotice'))
  setFakeModels([])
}

// ── 2. 引擎决定哪些参数有效 ───────────────────────────
console.log('\n[2] 引擎联动')
{
  setFakeModels([{ id: 'vits-melo-zh_en', label: 'MeloTTS', category: 'tts', ready: true, speakers: 4, bytes: 100, engine: 'vits' }])
  const online = render({ ttsEngine: 'online' })
  const neural = render({ ttsEngine: 'neural' })
  const local = render({ ttsEngine: 'local' })
  const sovits = render({ ttsEngine: 'sovits' })

  check('在线：显示音调', online.includes('pitch'))
  check('在线：显示音量', online.includes('volume'))
  check('在线：显示音频格式', online.includes('ttsFormat'))
  check('在线：隐藏说话人', !online.includes('neuralSpeaker'))

  check('神经：隐藏音调', !neural.includes('pitch'))
  check('神经：隐藏音量', !neural.includes('volume'))
  check('神经：隐藏音频格式', !neural.includes('ttsFormat'))
  check('神经：多说话人模型显示说话人', neural.includes('neuralSpeaker'))

  check('系统语音：显示音量', local.includes('volume'))
  check('系统语音：隐藏音调', !local.includes('pitch'))
  check('系统语音：隐藏音频格式', !local.includes('ttsFormat'))

  check('GPT-SoVITS：显示服务地址', sovits.includes('sovitsUrl'))
  check('GPT-SoVITS：显示参考音频/文本/语言',
    sovits.includes('sovitsRefAudio') && sovits.includes('sovitsPromptText')
    && sovits.includes('sovitsTextLang') && sovits.includes('sovitsPromptLang'))
  check('GPT-SoVITS：隐藏音调/音量/音频格式',
    !sovits.includes('pitch') && !sovits.includes('volume') && !sovits.includes('ttsFormat'))

  // 单说话人模型：不显示「说话人」下拉
  setFakeModels([{ id: 'vits-melo-zh_en', label: 'MeloTTS', category: 'tts', ready: true, speakers: 1, bytes: 100, engine: 'vits' }])
  const singleSpeaker = render({ ttsEngine: 'neural' })
  check('神经：单说话人模型隐藏说话人下拉', !singleSpeaker.includes('neuralSpeaker'))

  // 未就绪的神经模型：显示回退警告
  const staleNeural = render({ ttsEngine: 'neural', neuralModel: 'vits-not-installed' })
  check('神经：配置的模型未安装时显示警告', staleNeural.includes('neuralModelMissingWarning'))
  setFakeModels([])
}

// ── 3. 自动发送联动 ───────────────────────────────────
console.log('\n[3] 自动发送联动')
{
  const on = render({ autoSend: true })
  const off = render({ autoSend: false })
  check('开启时显示「发送前等待」', on.includes('autoSendExtraMs'))
  check('关闭时隐藏「发送前等待」', !off.includes('autoSendExtraMs'))
  check('关闭自动发送时「说完就关」被禁用',
    /<option[^>]*value="once"[^>]*disabled/.test(off))
  const onceOff = render({ autoSend: false, mode: 'once' })
  check('关闭自动发送且当前是 once 时显示提示', onceOff.includes('modeOnceNeedsAutoSend'))
}

// ── 4. 识别语言按模型过滤 ─────────────────────────────
console.log('\n[4] 识别语言联动')
{
  // Whisper：worker 不消费 language → 禁用下拉并提示
  setFakeModels(MODELS_BOTH)
  const whisper = render({ model: 'whisper-tiny', language: 'auto' })
  check('Whisper：语言下拉被禁用',
    /<select[^>]*disabled[^>]*>[\s\S]{0,2000}?language|language[\s\S]{0,300}?<select[^>]*disabled/.test(whisper)
    || /disabled=""[^>]*>[\s\S]{0,1200}?language/.test(whisper))
  check('Whisper：显示「当前模型不支持语言提示」', whisper.includes('languageModelUnsupported'))

  // SenseVoice：语言选项按模型 languages 过滤（ja/ko 支持；这里都在列表里）
  const sensevoice = render({ model: 'sensevoice', language: 'ja' })
  check('SenseVoice：语言下拉可用（不显示不支持提示）', !sensevoice.includes('languageModelUnsupported'))
  setFakeModels([{ id: 'sensevoice', label: 'SenseVoice', category: 'asr', ready: true, engine: 'sensevoice', languages: ['zh', 'en'] }])
  const limited = render({ model: 'sensevoice', language: 'ja' })
  check('SenseVoice 限制语言列表时：选了不支持的语言显示提示', limited.includes('languageNotInModel'))
  setFakeModels([])
}

// ── 5. 流式实时字依赖 ─────────────────────────────────
console.log('\n[5] liveAsr 依赖提示')
{
  setFakeModels([{ id: 'sensevoice', label: 'SenseVoice', category: 'asr', ready: true, engine: 'sensevoice', languages: ['zh'] }])
  const noStream = render({ liveAsr: 'full' })
  check('zipformer2 未下载：stream 选项被禁用',
    /<option[^>]*value="stream"[^>]*disabled/.test(noStream))
  check('zipformer2 未下载：显示依赖提示', noStream.includes('liveAsrStreamNeedsModel'))

  setFakeModels([
    { id: 'sensevoice', label: 'SenseVoice', category: 'asr', ready: true, engine: 'sensevoice', languages: ['zh'] },
    { id: 'zipformer2-zh', label: 'Zipformer2', category: 'asr', ready: true, engine: 'online', languages: ['zh'] },
  ])
  const withStream = render({ liveAsr: 'full' })
  check('zipformer2 已就绪：stream 选项可用', !/<option[^>]*value="stream"[^>]*disabled/.test(withStream))
  setFakeModels([])
}

// ── 6. 分组结构（task-19：6 组顺序 + 字段归属 + 说明 + 高级默认收起） ──
console.log('\n[6] 分组结构')
{
  const html = render({})
  const groupOrder = ['secRecognition', 'secInteraction', 'secText', 'secSynthesis', 'secModels', 'secAdvanced']
  const positions = groupOrder.map((key) => html.indexOf('>' + key + '<'))
  check('6 个分组都渲染', positions.every((i) => i >= 0), JSON.stringify(positions))
  check('分组顺序：识别→交互→文本→合成→模型→高级',
    positions.every((v, i) => i === 0 || v > positions[i - 1]), JSON.stringify(positions))

  // 分组说明（每个分组标题下方都有小字说明）
  for (const key of ['secRecognitionHint', 'secInteractionHint', 'secTextHint', 'secSynthesisHint', 'secModelsHint', 'secAdvancedHint']) {
    check('分组说明存在：' + key, html.includes(key))
  }

  /** 取某个分组标题到下一个分组标题之间的 HTML（用于断言字段归属）。 */
  const sliceOf = (startKey, endKey) => {
    const start = html.indexOf('>' + startKey + '<')
    const end = endKey === null ? html.indexOf('</details>', start) : html.indexOf('>' + endKey + '<')
    return start >= 0 && end > start ? html.slice(start, end) : ''
  }
  const groups = {
    recognition: sliceOf('secRecognition', 'secInteraction'),
    interaction: sliceOf('secInteraction', 'secText'),
    text: sliceOf('secText', 'secSynthesis'),
    synthesis: sliceOf('secSynthesis', 'secModels'),
    models: sliceOf('secModels', 'secAdvanced'),
    advanced: sliceOf('secAdvanced', null),
  }
  const has = (group, key) => groups[group].includes('>' + key + '<')

  check('识别组含：模型/语言/实时字',
    has('recognition', 'model') && has('recognition', 'language') && has('recognition', 'liveAsr'))
  check('识别组不含交互项',
    !has('recognition', 'mode') && !has('recognition', 'autoSend') && !has('recognition', 'shortcut'))
  check('交互组含：模式/静音/自动发送/发送前等待/快捷键',
    has('interaction', 'mode') && has('interaction', 'silenceMs') && has('interaction', 'autoSend')
    && has('interaction', 'autoSendExtraMs') && has('interaction', 'shortcut'))
  check('文本组含：清理语气词/词表',
    has('text', 'removeFillers') && has('text', 'words'))
  check('合成组含：朗读/追赶/引擎/语速/音调/当前合成方式',
    has('synthesis', 'readAloud') && has('synthesis', 'readAloudLag') && has('synthesis', 'ttsEngine')
    && has('synthesis', 'rate') && has('synthesis', 'pitch')
    && groups.synthesis.includes('ttsCurrent'))
  check('合成组含引擎参数（音量/格式）',
    has('synthesis', 'volume') && has('synthesis', 'ttsFormat'))
  check('模型组含：预加载/空闲释放/环境自检/模型列表',
    has('models', 'preloadModels') && has('models', 'idleReleaseMinutes')
    && has('models', 'envCheck') && groups.models.includes('modelGroupAsr'))
  check('模型组不再包含「当前合成方式」', !groups.models.includes('ttsCurrent'))
  check('高级组含诊断/调试说明', has('advanced', 'advancedDiagnostics') && has('advanced', 'advancedDebug'))
  // 全局语音（v1）落在交互组；AI 界面操控 / 确认 / 系统热键 helper 落在高级组，
  // 高级组不再是纯说明区（但仍默认收起）。
  check('交互组含全局语音三项（浮层/快捷键/注入方式）',
    has('interaction', 'globalVoice') && has('interaction', 'globalShortcut')
    && has('interaction', 'voicePromptMode'))
  // v3：唤醒词输入也在交互组（全局浮层待机用；输入框麦克风不受影响）。
  check('交互组含唤醒词输入', has('interaction', 'wakeWord'))
  check('高级组含 AI 界面操控/确认/系统热键 helper',
    has('advanced', 'uiControl') && has('advanced', 'uiConfirm')
    && has('advanced', 'globalHotkeyHelper'))
  check('高级组的三个新开关是真实可配置控件（checkbox）',
    (groups.advanced.match(/<input/g) || []).length === 3,
    `实际 ${(groups.advanced.match(/<input/g) || []).length} 个 input`)
  // task-24：高级组底部还有只读「系统级热键状态」行（不是配置项）。
  check('高级组含只读热键状态行（标题/刷新按钮）',
    groups.advanced.includes('>hotkeyStatusTitle<')
    && groups.advanced.includes('>hotkeyStatusRefresh<'))
  check('状态行不引入新的可配置控件（无 select/textarea）',
    !groups.advanced.includes('<select') && !groups.advanced.includes('<textarea'))
  {
    // helper 开、浮层关：即使还没拉到 diagnostics，也要提示需要开浮层。
    const needsOverlay = render({ globalHotkeyHelper: true, globalVoice: false })
    const start = needsOverlay.indexOf('>secAdvanced<')
    check('helper 开启但浮层关闭 → 显示需开浮层提示',
      start >= 0 && needsOverlay.slice(start).includes('hotkeyStatusNeedsOverlay'))
  }

  // 6 组都用原生 details 折叠；只有高级组默认收起
  const detailsTags = html.match(/<details[^>]*>/g) || []
  check('6 个分组都可折叠（details）', detailsTags.length === 6, String(detailsTags.length))
  check('高级组默认收起、其余展开',
    detailsTags.length === 6
    && detailsTags.slice(0, 5).every((tag) => /\bopen\b/.test(tag))
    && !/\bopen\b/.test(detailsTags[5]))
  check('高级组有 summary 标题与说明',
    html.includes('<summary') && html.includes('>secAdvancedHint<'))

  // 紧凑布局：短字段并排行使用 grid auto-fit
  check('存在并排短字段行（grid auto-fit ≥3 处）',
    (html.match(/minmax\(220px, 1fr\)/g) || []).length >= 3,
    String((html.match(/minmax\(220px, 1fr\)/g) || []).length))
}

// ── 7. 模型可选性 ─────────────────────────────────────
console.log('\n[7] 模型可选性')
{
  // 渲染时没有可用模型列表 → 应显示占位提示，而不是能选具体模型
  const html = render({})
  check('没有可用模型时显示占位', html.includes('modelNoReady'))
  check('没有可用模型时不列出具体模型', !html.includes('value="sensevoice"'))
}

// ── 8. 模型管理的「当前使用」标记 ───────────────────────
console.log('\n[8] 模型管理标记')
{
  const both = [
    { id: 'sensevoice', label: 'SenseVoice', category: 'asr', ready: true, host: true, bytes: 0, engine: 'sensevoice', languages: ['zh'] },
    { id: 'vits-melo-zh_en', label: 'MeloTTS', category: 'tts', ready: true, speakers: 4, bytes: 100, engine: 'vits' },
  ]
  setFakeModels(both)

  // 用在线引擎时，神经模型不该被标成「当前使用」
  const online = render({ ttsEngine: 'online', model: 'sensevoice', neuralModel: 'vits-melo-zh_en' })
  const onlineLabels = online.split('modelInUse').length - 1
  check('在线引擎：只有 1 处「当前使用」（识别模型）', onlineLabels === 1, `实际 ${onlineLabels} 处`)

  // 用神经引擎时，神经模型该被标成「当前使用」
  const neural = render({ ttsEngine: 'neural', model: 'sensevoice', neuralModel: 'vits-melo-zh_en' })
  const neuralLabels = neural.split('modelInUse').length - 1
  check('神经引擎：2 处「当前使用」（识别+合成）', neuralLabels === 2, `实际 ${neuralLabels} 处`)

  // 识别模型始终是当前使用
  const system = render({ ttsEngine: 'local', model: 'sensevoice' })
  const systemLabels = system.split('modelInUse').length - 1
  check('系统语音：只有 1 处「当前使用」（识别模型）', systemLabels === 1, `实际 ${systemLabels} 处`)

  // 「当前朗读方式」始终有显示
  check('在线：显示当前朗读方式', online.includes('ttsCurrent'))
  check('神经：显示当前朗读方式', neural.includes('ttsCurrent'))
  check('系统：显示当前朗读方式', system.includes('ttsCurrent'))

  // 下载中的模型：必须显示「下载中」而不是「下载模型」，
  // 否则用户点了下载完全看不出正在下（识别模型之前就漏了 downloading 字段）。
  setFakeModels([
    { id: 'sensevoice', label: 'SenseVoice', ready: true, host: true, category: 'asr', engine: 'sensevoice', languages: ['zh'] },
    { id: 'whisper-tiny', label: 'Whisper tiny', ready: false, downloading: true, received: 25, total: 100, bytes: 98816730, category: 'asr', engine: 'whisper', languages: ['zh', 'en'] },
    { id: 'vits-melo-zh_en', label: 'MeloTTS', ready: true, host: false, category: 'tts', speakers: 1, engine: 'vits' },
  ])
  const downloading = render({ model: 'sensevoice', ttsEngine: 'online' })
  check('下载中的识别模型显示「下载中」', downloading.includes('neuralDownloading'))
  check('下载中的模型显示进度百分比', downloading.includes('25%'))
  // 用 >...< 精确匹配按钮文本：neuralDownloading 里含有 neuralDownload 子串
  check('下载中的模型不显示「下载模型」按钮', !downloading.includes('>neuralDownload<'))
  check('已就绪的识别模型显示「已下载」', downloading.includes('neuralReady'))

  setFakeModels([])
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exit(1)
