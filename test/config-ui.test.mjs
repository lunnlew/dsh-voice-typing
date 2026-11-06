/**
 * 配置加固（客户端）行为测试 —— 覆盖 task-18 的 1/2/3/4/5/6/7/8 关键点。
 *
 * 两类断言：
 *   A. 纯函数（模块导出的 `__test`）：引擎/枚举/数值归一化、词表文本↔数组、
 *      保存前 normalizeForSave（含 neuralModel 残留纠正、模型语言过滤、
 *      单说话人归零、默认值对齐）、400 校验错误转可读文案、/tts 回退头解析、
 *      /tts/env 引擎行归一化（含宿主新增的 sovits 行）；
 *   B. SSR：设置面板的关键显隐与提示（在真渲染出的 HTML 上查，不查写法）。
 *
 * 交互路径的判据不住这里：批次 5b 起，「词表不逐键归一化 / 保存发的是归一化后的
 * payload / 400 的可读错误 / 快捷键非法时按钮禁用 / 热键状态行的拉取时机」
 * 都在 `test/client-behavior.test.mjs` 的场景 26-28 里**真挂面板、真点按钮**判
 * （docs §8.34 批次 5b）。这个文件只剩「纯函数 + SSR」两类，因为它跑得比那三段快得多，
 * 归一化规则本身（A 段那些）确实适合用纯函数判。
 */
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { CONFIG_DEFAULTS } from '../src/host/config-schema.js'
import { TTS_ENV_REASONS } from '../src/shared/tts-env-reasons.js'

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
  console.error('✗ lib/client.js 没有导出 __test（构建产物过期？先 npm run build:client）')
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

// 这里不再有「扫客户端源码文本」的判据：批次 5a 把 7 条文案正则搬进了
// `test/i18n-status-line.test.mjs`（判字典数据），批次 5b 把下面这些交互形状正则
// 搬进了 `test/client-behavior.test.mjs` 的场景 26-28（真挂面板）。
// 需要读源码的守卫请看 test/helpers/client-source.mjs 的使用方（宿主侧那几个文件）。

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
    // 全局语音 / AI 界面操控（v1）：与宿主 DEFAULTS 同键名同默认值。
    globalVoice: false, globalShortcut: 'Ctrl+Alt+V', voicePromptMode: 'queue',
    uiControl: false, uiConfirm: true, globalHotkeyHelper: false,
    // v3：唤醒词（默认「小鱼」；空串 = 关闭）。
    wakeWord: '小鱼',
    ...configOverrides,
  }
  return renderToStaticMarkup(React.createElement(SettingsSection, {
    __initialConfig: config, __initialModels: models, t: (k) => k,
  }))
}

/* ================================================================ */
console.log('A. 纯函数：产物里的默认值 == 宿主的同一份默认值')
{
  // 这条**跨构建边界**：左边是 `lib/client.js`（esbuild 合出来的产物）里的 UI_DEFAULTS，
  // 右边是宿主直接 import 的 CONFIG_DEFAULTS（src/shared/config-spec.js）。
  // 3.3b 之前两端各有一份字面量，这里只能拿正则刮 lib/index.js 的源码；
  // 现在两端同源，比对的是数据而不是文本。
  const hostKeys = Object.keys(CONFIG_DEFAULTS).sort()
  const clientKeys = Object.keys(T.UI_DEFAULTS).sort()
  check('UI 默认配置键集合 == 宿主 DEFAULTS 键集合', JSON.stringify(hostKeys) === JSON.stringify(clientKeys),
    `host=${hostKeys.length} client=${clientKeys.length}`)
  check('逐项默认值都相等（产物没有夹带旧值）',
    JSON.stringify(T.UI_DEFAULTS) === JSON.stringify(CONFIG_DEFAULTS),
    hostKeys.filter((k) => T.UI_DEFAULTS[k] !== CONFIG_DEFAULTS[k]).join(',') || '全部一致')
  for (const [key, expected] of [
    ['rate', '+10%'], ['pitch', '+0Hz'], ['volume', '+0%'],
    ['shortcut', 'Alt+V'], ['language', 'auto'], ['mode', 'toggle'],
    ['model', 'sensevoice'], ['liveAsr', 'full'], ['ttsEngine', 'online'],
    ['silenceMs', 1500], ['autoSendExtraMs', 1200], ['readAloudLag', 7.5],
    ['idleReleaseMinutes', 10], ['neuralSpeaker', 0],
    ['ttsFormat', 'AUDIO_24KHZ_48KBITRATE_MONO_MP3'],
    ['sovitsTextLang', 'zh'], ['sovitsPromptLang', 'zh'],
    // 全局语音 / AI 界面操控：UI 默认值必须与宿主一致。
    ['globalVoice', false], ['globalShortcut', 'Ctrl+Alt+V'], ['voicePromptMode', 'queue'],
    ['uiControl', false], ['uiConfirm', true], ['globalHotkeyHelper', false],
    // v3 唤醒词：UI 默认值必须与宿主一致。
    ['wakeWord', '小鱼'],
  ]) {
    check(`UI_DEFAULTS.${key} == ${JSON.stringify(expected)}`, T.UI_DEFAULTS[key] === expected, String(T.UI_DEFAULTS[key]))
  }
  // 这两条以前靠刮 lib/index.js 的字面量证明「宿主自己也是这个值」。
  // 单源之后两端不可能不同，于是改成守住「值本身没被顺手改掉」——
  // 这些是关键默认值（+10% 是用户要求的、Alt+V 是老用户习惯），改动要有意识地发生。
  check('宿主 CONFIG_DEFAULTS.rate 确实是 +10%（UI 不再用 +0%）',
    CONFIG_DEFAULTS.rate === '+10%', String(CONFIG_DEFAULTS.rate))
  check('宿主 CONFIG_DEFAULTS.shortcut 确实是 Alt+V',
    CONFIG_DEFAULTS.shortcut === 'Alt+V', String(CONFIG_DEFAULTS.shortcut))
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
  // 白名单：normalizeForSave 是**逐个字段重写**，不是「把用户给的对象改改就发出去」。
  // 这条守的是「界面里的只读状态（热键诊断、平台、加速度键）不会被顺手存进配置」——
  // 场景 28 在真产物上判同一件事，但那里的防线有两道（面板不塞 + 这里不透传），
  // 单破一道都是绿的，所以这一半要在纯函数上单独判（缘由记在 §8.34 批次 5b）。
  const leaky = T.normalizeForSave(
    { ...CONFIG_DEFAULTS, hotkeyStatus: { ok: true, status: 'enabled' }, platform: 'win32', accelerator: 'Ctrl+Alt+V' },
    {},
  )
  const leakyKeys = Object.keys(leaky).filter((k) => !(k in CONFIG_DEFAULTS))
  check('normalizeForSave 只输出配置项白名单里的键（未知的一律不透传）',
    leakyKeys.length === 0, `多出这些键：${leakyKeys.join(',')}`)
  check('只读诊断字段确实被丢掉（不是碰巧没传）',
    !('hotkeyStatus' in leaky) && !('platform' in leaky) && !('accelerator' in leaky),
    JSON.stringify(Object.keys(leaky)))
}

console.log('\nA. 纯函数：保存错误 / TTS 回退头 / env 引擎行')
{
  // 批次 20（docs §8.62）：这里的 `t` 记录它收到过的键和参数，
  // 判据因此能同时钉住「界面那句话是字典的哪个键」「动态值是现场算的还是宿主传的」。
  // 宿主 400 里那句中文原文（老宿主的 `reason`、新宿主的 `detail`）一个字都不该出现在返回的行里。
  const seen = []
  const recT = (key, params) => {
    seen.push(params === undefined ? key : `${key}(${JSON.stringify(params)})`)
    return key
  }
  check('errors 对象数组 → 字段名和句子都出自字典',
    JSON.stringify(T.collectSaveErrors({ ok: false, errors: [{ key: 'ttsEngine', reason: 'not-in-enum' }] }, recT))
      === JSON.stringify(['ttsEngine：configErrorEnum']))
  check('枚举错的允许值由 shared 规则现场算（不是宿主传的）',
    seen.includes(`configErrorEnum({"values":"${T.TTS_ENGINES.join(' / ')}"})`), JSON.stringify(seen))
  check('数值区间的句子带的是 spec 里的 min/max',
    JSON.stringify(T.collectSaveErrors({ ok: false, errors: [{ key: 'silenceMs', reason: 'out-of-range' }] }, recT))
      === JSON.stringify(['silenceMs：configErrorRange']), JSON.stringify(seen))
  check('超长的句子带的是 spec 里的 maxLen',
    JSON.stringify(T.collectSaveErrors({ ok: false, errors: [{ key: 'wakeWord', reason: 'too-long' }] }, recT))
      === JSON.stringify(['wakeWord：configErrorTooLong']))
  check('区间与长度上限这两处参数取自 spec（改 shared 一处，界面跟着动）',
    seen.includes('configErrorRange({"min":500,"max":5000})') && seen.includes('configErrorTooLong({"maxLen":32})'),
    JSON.stringify(seen))
  check('整份请求的错（key 为空）不带字段名前缀',
    JSON.stringify(T.collectSaveErrors({ ok: false, errors: [{ key: '', reason: 'body-not-json' }] }, recT))
      === JSON.stringify(['configErrorBodyNotJson']))
  // 老宿主直接写句子：这些值不在词表里，只能走兜底那句。
  check('词表外的 reason（老宿主的中文句子）不进界面',
    JSON.stringify(T.collectSaveErrors(
      { ok: false, errors: [{ key: 'ttsEngine', reason: '必须是 online/neural/local/sovits' }] },
      recT,
    )) === JSON.stringify(['ttsEngine：configErrorUnknown']))
  check('宿主给的 detail 不进界面',
    !T.collectSaveErrors(
      { ok: false, errors: [{ key: 'sovitsUrl', reason: 'url-not-http', detail: '必须是 http/https：ftp://x' }] },
      recT,
    ).some((line) => line.includes('ftp://x')))
  check('errors 字符串数组 → 每条走兜底那句，原文不进界面',
    JSON.stringify(T.collectSaveErrors({ errors: ['a', 'b'] }, recT))
      === JSON.stringify(['configErrorUnknown', 'configErrorUnknown']))
  check('{error: string} → 兜底那句，原文不进界面',
    JSON.stringify(T.collectSaveErrors({ error: 'bad' }, recT)) === JSON.stringify(['configErrorUnknown']))
  check('ok:false 无原因 → 整份被拒那句',
    JSON.stringify(T.collectSaveErrors({ ok: false }, recT)) === JSON.stringify(['configSaveRejected']))
  check('reason 为空串的条目被跳过（不是当成一个错误）',
    T.collectSaveErrors({ ok: false, errors: [{ key: 'model', reason: '' }] }, recT).length === 1)
  check('空 payload 不崩', Array.isArray(T.collectSaveErrors(null)) && T.collectSaveErrors(null).length === 0)
  check('不传 t 也能用（键名当文案，产物里的旧调用点不会红）',
    JSON.stringify(T.collectSaveErrors({ ok: false, errors: [{ key: 'model', reason: 'not-a-string' }] }))
      === JSON.stringify(['model：configErrorString']))

  const headers = { get: (name) => (name === 'x-tts-engine-fallback' ? 'online' : name === 'x-tts-engine' ? 'edge' : '') }
  const meta = T.extractTtsMeta(headers)
  check('extractTtsMeta 读取回退目标', meta.fallback === 'online' && meta.engine === 'edge')
  check('extractTtsMeta 普通对象', T.extractTtsMeta({ 'x-tts-engine-fallback': 'local' }).fallback === 'local')
  check('extractTtsMeta 无 headers → 空串', T.extractTtsMeta(undefined).fallback === '')

  // 旧宿主（还没跟着批次 22-3-2 改）的行形状：行名与状态都是宿主写的中文。
  // 这一份留着是为了判「旧产物还能不能把中文塞进界面」—— 答案必须是不能。
  const legacy = {
    configured: 'sovits',
    engines: [
      { id: 'online', label: 'Edge', available: true, detail: '可用（服务端返回 32 个音色）' },
      { id: 'neural', label: 'Neural', available: false, detail: '模型还没下载（MeloTTS 中英）' },
      // 宿主新增的 sovits 行：字段形状不同（supported/url/configured），不能崩；
      // 外部服务不探测 → 不显示成 ✓/✗（中性状态）。
      { id: 'sovits', label: 'GPT-SoVITS', supported: true, configured: true, url: 'http://127.0.0.1:9880' },
    ],
  }
  const old = T.formatEnvEngines(legacy, 'online')
  check('formatEnvEngines 行数', old.length === 3)
  check('formatEnvEngines 状态映射', old[0].status === 'ok' && old[1].status === 'bad' && old[2].status === '')
  check('formatEnvEngines 不再搬宿主的句子与行名（§8.67：detail 只剩用户自己填的 url）',
    old[0].detail === '' && old[1].detail === '' && old[2].detail === 'http://127.0.0.1:9880'
      && old.every((row) => row.label === undefined))
  check('formatEnvEngines 标出 configured 当前引擎', old[2].current === true && old[0].current === false)

  // 新宿主：每行只给原因码 + 参数。这里**原样带过去**，不翻译、也不校验词表
  // （校验在 `pure/tts-env-reason-text.js`，词表外的值在那里走兜底句）。
  const env = {
    configured: 'online',
    engines: [
      {
        id: 'online',
        available: true,
        reason: TTS_ENV_REASONS.ONLINE_READY,
        params: { count: '32' },
        detail: '可用（服务端返回 32 个音色）',
      },
      { id: 'local', available: false, reason: TTS_ENV_REASONS.LOCAL_MISSING_ESPEAK, params: {} },
      { id: 'sovits', supported: true, configured: false, url: 'http://127.0.0.1:9880' },
    ],
  }
  const rows = T.formatEnvEngines(env, 'neural')
  check('formatEnvEngines 把原因码与参数原样带到面板',
    rows[0].reason === TTS_ENV_REASONS.ONLINE_READY && rows[0].params.count === '32'
      && rows[1].reason === TTS_ENV_REASONS.LOCAL_MISSING_ESPEAK)
  check('formatEnvEngines 缺字段不崩（没 reason 给空串、没 params 给空对象）',
    rows[2].reason === '' && JSON.stringify(rows[2].params) === '{}')
  check('formatEnvEngines 的 detail 只可能来自 url（宿主那句原文不进这一格）',
    rows[0].detail === '' && rows[2].detail === 'http://127.0.0.1:9880')
  check('formatEnvEngines 新形状下当前引擎仍按 configured 标', rows[0].current === true && rows[1].current === false)

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

// 这一段原来是 8 条扫客户端源码文本的正则，全部搬到 `test/client-behavior.test.mjs`
// 的场景 26/28（挂真产物里的 SettingsSection、喂假 /config·/models·/diagnostics + SSE）：
//   「词表输入框绑定原始文本 state」→ 场景 26：敲进去的空格/换行原样留在 value 里；
//   「词表失焦/保存时才归一化」→ 场景 26：打字期间零 POST，失焦后 POST 的词表是
//     `['你好 世界','第二行']`（空行去掉、逐条 trim、词内空格保留）；
//   「旧的逐键归一化已移除」→ 同上第一条，它判的是同一件事的反面，搬过去后合成一条；
//   「保存 POST 归一化后的 payload」→ 场景 26：非法引擎/档位发出去前被收敛
//     （`ttsEngine:'bogus'→'online'`、`rate:'nope'→'+10%'`），不是原样发给宿主；
//   「保存错误可读展示（saveErrors 渲染）」→ 场景 26：假 400 之后渲染树里出现字典给的
//     那一行（批次 20 之后是 `ttsEngine：configErrorEnum`，宿主原文不进界面），
//     而且用户刚改的词表没被冲掉；
//   「快捷键非法时保存按钮禁用」→ 场景 26：disabled 变 true，对照组（快捷键合法）
//     变 false —— 原来那条正则只钉 `saveDisabled` 那一行的写法；
//   「/tts 响应头读取回退标记」「回退提示接到现有 hint 机制」→ 场景 2b（`引擎回退提示`）
//     更强：它注入真的 `x-tts-engine*` 响应头、走真的合成链路、等树里真的出现
//     `ttsFallbackOnline`，还读了一次 `__DSH_VOICE_DEBUG__()`。正则只能证明字面量还在。
// 留在这里的是 A 段那些**纯函数**判据（如 `extractTtsMeta` 直接吃两种 header 形状），
// 它们判的是同一功能的另一侧（解析规则的分支），不需要渲染。
//
// task-24 那 6 条跨平台/唤醒词/uiControl 文案正则整批搬走（§8.34 批次 5a）：
// 它们判的是「文案含住某个信息点」，而文案是数据，住在 `src/client/pure/i18n.js`。
// 判据现在在 `test/i18n-status-line.test.mjs` 的 PANEL_COPY_RULES 里，
// 好处是①中英两侧一起判（原来只扫客户端源码 = 只判中文那一份），
// ②整句改写不会误红，删掉信息点才红（同文件末尾有反例自证）。

// B2（系统级热键只读状态行）那 4 条源码正则同样搬走了 → 场景 28「面板·热键状态行」：
//   「从 /diagnostics 读取 hotkeyHelper」→ 挂载时真拉一次并把 `hotkeyStatusEnabled` 渲染出来
//     （注入的假诊断给的是 enabled，渲染成「未开启」就红）；
//   「只在挂载/保存后/手动刷新时拉取，不轮询」→ 挂着 0.8 秒增量为 0、点刷新 +1、保存 +1；
//   「诊断失败降级为未知」→ `diagnosticsFail` 时树里是 `hotkeyStatusUnknown`，且不抛异常；
//   「只读展示，不参与保存」→ 那次保存的 POST body 键集合 ⊆ `CONFIG_DEFAULTS` 键集合，
//     而且 `hotkeyStatus`/`accelerator`/`platform` 一个都不在里面。
// SSR 那一边（下面的 C 段）还判着状态行在「高级与诊断」组里、helper 开而浮层关时的
// 「需同时开启浮层」提示 —— 那些是布局与显隐，静态渲染就够，不必挂起来点。

console.log('\nC. 布局重构：6 组分区 + 说明 + 折叠 + 并排（task-19）')
{
  // 组件实现：Section 可折叠/说明；Row 是模块级 grid 组件（不能在组件体内定义，
  // 否则每次渲染类型变化 → 输入框失焦）。
  // 组件实现的两条形状断言（`props.collapsible`、`const Row = …`）已删：
  // 下面 C 段末尾那组「渲染出的 HTML」判据（<details> 数量、open 归属、minmax 行数）
  // 覆盖的是同一件事，而且是在真渲染结果上查 —— 形状绿、渲染坏的情况它才抓得住（§8.34 批次 0）。
  // 「Row 定义在模块级或工厂闭包顶层（不在渲染函数体内）」那条位置正则删掉了。
  // 它担心的是「每次渲染都换组件类型 → 整棵子树卸载重建 → 输入框当场失焦」，
  // 而这个用行为判更准：`test/client-behavior.test.mjs` 场景 28 的最后两条
  // —— 挂起面板、收集渲染树里所有函数型元素类型（按身份），改一次状态再收集一次，
  // 「两次之间没有新出现的类型」才算过；前面还有一条「树里确实有 ≥3 个函数型组件」
  // 防它空跑。写法怎么摆（模块级 / 工厂闭包 / 别的文件）都不再影响判定。

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
  const interaction = sliceOf('secInteraction', 'secText')
  const has = (group, key) => group.includes('>' + key + '<')
  check('「当前合成方式」在合成组顶部（不再在模型组）',
    synthesis.includes('ttsCurrent') && !models.includes('ttsCurrent'))
  // 全局语音（v1）：浮层开关/全局快捷键/注入方式属于「语音交互」；
  // AI 界面操控与系统热键 helper 属于「高级与诊断」（不是纯说明区了）。
  check('全局语音三项在语音交互组',
    has(interaction, 'globalVoice') && has(interaction, 'globalShortcut')
    && has(interaction, 'voicePromptMode'))
  // v3：唤醒词输入框也在「语音交互」组（只对全局浮层生效）。
  check('唤醒词输入框在语音交互组', has(interaction, 'wakeWord'), interaction.slice(0, 80))
  check('AI 界面操控/确认/系统热键 helper 在高级与诊断组',
    has(advanced, 'uiControl') && has(advanced, 'uiConfirm')
    && has(advanced, 'globalHotkeyHelper'))
  check('高级组的新开关是真实可配置控件（3 个 checkbox）',
    (advanced.match(/<input/g) || []).length === 3,
    `实际 ${(advanced.match(/<input/g) || []).length} 个 input`)
  // task-24：高级组底部新增只读「系统级热键状态」行（不是配置项）。
  check('高级组含只读热键状态行（标题/标签/平台/刷新）',
    advanced.includes('>hotkeyStatusTitle<') && advanced.includes('hotkeyStatusLabel')
    && advanced.includes('hotkeyStatusPlatform') && advanced.includes('>hotkeyStatusRefresh<'))
  check('默认 helper 关闭 → 状态行显示「未开启」',
    advanced.includes('hotkeyStatusDisabled'))
  check('状态行不引入新的可配置控件（advanced 无 select/textarea）',
    !advanced.includes('<select') && !advanced.includes('<textarea'))
  {
    const helperOnHtml = render({ globalHotkeyHelper: true })
    const start = helperOnHtml.indexOf('>secAdvanced<')
    const advancedOn = start >= 0 ? helperOnHtml.slice(start) : ''
    check('helper 开启但浮层关闭 → 状态行提示需同时开启浮层',
      advancedOn.includes('hotkeyStatusNeedsOverlay'))
    check('helper 开启、状态未拉到 → 显示「读取中」不谎报已启用',
      advancedOn.includes('hotkeyStatusLoading'))
  }
  const detailsTags = html.match(/<details[^>]*>/g) || []
  check('6 组都可折叠，高级组默认收起',
    detailsTags.length === 6
    && detailsTags.slice(0, 5).every((tag) => /\bopen\b/.test(tag))
    && !/\bopen\b/.test(detailsTags[5]))
  // 补上原来那条形状断言里 `<summary>` 那一半：折叠头必须是原生 summary，
  // 否则浏览器自带的展开/收起就没了（这是渲染结果，不是源码写法）。
  check('每个折叠都有原生 summary 承载折叠头',
    (html.match(/<summary/g) || []).length === 6,
    `实际 ${(html.match(/<summary/g) || []).length} 个`)
  check('分组说明齐全',
    ['secRecognitionHint', 'secInteractionHint', 'secTextHint', 'secSynthesisHint', 'secModelsHint', 'secAdvancedHint']
      .every((key) => html.includes(key)))
  check('以并排短字段行承载数值字段（≥3 行）',
    (html.match(/minmax\(220px, 1fr\)/g) || []).length >= 3)
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exit(1)
