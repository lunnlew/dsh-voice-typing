/**
 * 客户端配置词表 + 保存前归一化（纯函数，可被 Node 原生 import）。
 *
 * 为什么单独成文件：
 *   这些枚举/默认值/归一化函数原先内联在 `main.js` 里（原 535–938 行区间），
 *   实测**零浏览器全局、零对 main.js 的回头引用**，属于纯代码；
 *   留在巨石文件里，想确认一个配置项的客户端合法取值就得在 7000 多行里滚动定位。
 *
 * 引用方向是**单向**的：本文件不引用 `main.js` 的任何符号，
 * `main.js` 与测试直接消费这里的导出；构建时由 `scripts/build-client.mjs`
 * 内联回 `lib/client.js`（浏览器模块的 require 只能解析包名）。
 *
 * 与宿主的关系（第 3 步 3.3 之后）：
 *   这个文件里**没有任何一份手抄的宿主规则**：
 *     - 枚举词表与词表上限：`src/shared/config-vocab.js`（宿主 `lib/config-schema.js` 也用它，
 *       两端拿到的是同一个冻结数组，`test/config-contract.test.mjs` 断言的是绑定同一性）；
 *     - 默认值：`src/shared/config-spec.js` 的 `CONFIG_DEFAULTS` —— `UI_DEFAULTS` 就是它本身，
 *       宿主的 `DEFAULTS` 也是它本身；
 *     - 字符串长度上限：`CONFIG_MAX_LENS`（由每个键的 `maxLen` 派生）；
 *     - 数值夹取区间：`rangeFor(key)`。
 *   留在本文件里的只有**浏览器侧表现层**：UI 档位（RATE/PITCH/VOLUME_OPTIONS、
 *   IDLE_RELEASE_OPTIONS）、输入形状（RATE/PITCH/VOLUME_PATTERN、`CHOICE_STRING_MAX_LEN`）、
 *   保存前归一化 `normalizeForSave` 与错误文案映射。
 *   「加一个配置项」现在等于：改 `src/shared/config-spec.js` 一处 + 设置面板加一行。
 */

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
} from '../../shared/config-vocab.js'
import {
  CONFIG_DEFAULTS,
  CONFIG_MAX_LENS,
  rangeFor,
} from '../../shared/config-spec.js'
import { configErrorText, configFieldLabel } from './config-error-text.js'

// 客户端的历史名字（main.js、测试与产物里用的都是这些）。
// 用**局部别名**而不是 `export ... as ...`：`export { A as B }` 不会建立局部绑定，
// 本文件里 normalizeLanguage / parseWordsText 等还在用这些名字。
const LANGUAGE_CODES = ASR_LANGUAGES
const SOVITS_LANGS = SOVITS_LANGUAGES
const WORDS_MAX_ENTRIES = MAX_WORDS
const WORDS_MAX_CHARS = MAX_WORD_CHARS

export {
  TTS_ENGINES,
  LIVE_ASR_MODES,
  INTERACTION_MODES,
  VOICE_PROMPT_MODES,
  TTS_FORMATS,
  LANGUAGE_CODES,
  SOVITS_LANGS,
  WORDS_MAX_ENTRIES,
  WORDS_MAX_CHARS,
}

// 下面这几个是**浏览器侧表现层**的选择，宿主 schema 里没有对应物，不进 shared：
// 语速/音调/音量给的是档位而不是自由文本（宿主把这三项当字符串，只校验形状），
// 「空闲释放」宿主允许 0..1440 任意整数，UI 只给常用档位。
export const RATE_OPTIONS = ['-50%', '-40%', '-30%', '-20%', '-10%', '+0%', '+10%', '+15%', '+20%', '+30%', '+40%', '+50%', '+75%', '+100%']
export const PITCH_OPTIONS = ['-50Hz', '-30Hz', '-20Hz', '-10Hz', '+0Hz', '+10Hz', '+20Hz', '+30Hz', '+50Hz']
export const VOLUME_OPTIONS = ['-50%', '-30%', '-20%', '-10%', '+0%', '+10%', '+20%', '+30%', '+50%']
/** rate / pitch / volume 是宿主 schema 里的自由字符串；收窄到 UI 认识的形状。 */
export const RATE_PATTERN = /^[+-]?\d+(?:\.\d+)?%$/
export const PITCH_PATTERN = /^[+-]?\d+(?:\.\d+)?Hz$/
export const VOLUME_PATTERN = /^[+-]?\d+(?:\.\d+)?%$/
/**
 * 选项字符串（rate/pitch/volume）的长度上限。
 *
 * 宿主把这三项声明为 `type:'string', maxLen:16`，客户端的 `limitChoiceString`
 * 也按 16 收 —— 数字原先是**写死在函数里**的，宿主哪天改 maxLen 这里不会跟着动。
 * 提成具名常量后，`test/config-contract.test.mjs` 能把它和宿主 maxLen 逐键对比。
 */
export const CHOICE_STRING_MAX_LEN = 16
/** 「空闲释放」UI 提供的档位（宿主 schema 允许 0..1440 任意整数，UI 只给常用值）。 */
export const IDLE_RELEASE_OPTIONS = [0, 5, 10, 30, 60]
/**
 * 支持流式解码（边喂边出字）的模型 id。
 *
 * 只有 zipformer2 是流式模型 —— 宿主的 `/asr-stream` 只认它。
 *
 * 客户端不能 import 宿主模块（浏览器模块的 require 只能解析包名），
 * 所以这里维护一份。**换流式模型时要同步改这里** ——
 * test/live-asr.test.mjs 会检查它与宿主的 STREAM_MODEL_ID 一致。
 */
export const STREAM_MODEL_IDS = ['zipformer2-zh']
/**
 * 字符串字段的长度上限 = 宿主 schema 的 `maxLen`（同一份，见 `src/shared/config-spec.js`）。
 *
 * 这里以前是一张手抄的数字表：宿主把某个 `maxLen` 改掉，客户端不会跟着动，
 * 表现是「粘贴超长地址 → 原样 POST → 400 → 界面只显示保存失败」（`sovitsUrl` 真漂过一次）。
 * 派生之后表里会多出 rate/pitch/volume 三项（宿主同样是 `maxLen:16`），
 * 但客户端对那三项走 `limitChoiceString` + `CHOICE_STRING_MAX_LEN`（形状收窄属 UI 表现层），
 * 按键取值，互不影响。
 */
export const STRING_LIMITS = CONFIG_MAX_LENS

/**
 * UI 兜底用的默认配置 —— **就是宿主的 `DEFAULTS`**（同一个对象，见
 * `src/shared/config-spec.js` 的 `CONFIG_DEFAULTS`）。
 *
 * 保留 `UI_DEFAULTS` 这个名字是因为 `main.js`、产物与测试都按它引用。
 * 它是冻结对象：客户端只做读取与 `{ ...UI_DEFAULTS, ...cfg }` 式的合并，
 * 谁要是就地写它会在严格模式里直接抛错（这是好事——那份改动以前会悄悄改掉宿主的默认值）。
 */
export const UI_DEFAULTS = CONFIG_DEFAULTS

/** 归一化语音引擎；非法返回 ''（调用方决定回退值）。 */
export function normalizeEngine(value) {
  const text = String(value ?? '').trim().toLowerCase()
  return TTS_ENGINES.includes(text) ? text : ''
}

/** 归一化枚举；非法回退 fallback。 */
export function normalizeEnum(value, allowed, fallback) {
  const text = String(value ?? '').trim().toLowerCase()
  return allowed.includes(text) ? text : fallback
}

/** 识别语言：非法回退 auto。 */
export function normalizeLanguage(value) {
  return normalizeEnum(value, LANGUAGE_CODES, 'auto')
}

/** GPT-SoVITS 语言：非法回退 zh。 */
export function normalizeSovitsLang(value) {
  return normalizeEnum(value, SOVITS_LANGS, 'zh')
}

/** 数值归一化：非法/越界 → 回退/夹取；整数可指定取整。 */
export function normalizeNumber(value, { min, max, fallback, integer = false }) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  let out = Math.max(min, Math.min(max, n))
  if (integer) out = Math.round(out)
  return out
}

/**
 * 「发送前等待」：空输入回退默认（而不是 `Number('')=0`）。
 * 区间取自宿主 schema（`rangeFor`），不再在这里手写 0/5000 ——
 * 手写的那份在宿主改范围时不会跟着动，表现是滑杆能拖出 400。
 * `integer: true` 是**客户端输入框**的行为（毫秒取整），与宿主是否要求整数无关。
 */
export function clampAutoSendExtraMs(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return UI_DEFAULTS.autoSendExtraMs
  const { min, max } = rangeFor('autoSendExtraMs')
  return normalizeNumber(text, { min, max, fallback: UI_DEFAULTS.autoSendExtraMs, integer: true })
}

/** 静音断句：空/非法回退默认；区间取自宿主 schema（现在是 500..5000）。 */
export function clampSilenceMs(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return UI_DEFAULTS.silenceMs
  const { min, max } = rangeFor('silenceMs')
  return normalizeNumber(text, { min, max, fallback: UI_DEFAULTS.silenceMs, integer: true })
}

/** 追赶秒数：空/非法回退默认；区间取自宿主 schema，0.5 秒步进是 UI 的规则。 */
export function clampReadAloudLag(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return UI_DEFAULTS.readAloudLag
  const n = Number(text)
  if (!Number.isFinite(n)) return UI_DEFAULTS.readAloudLag
  const { min, max } = rangeFor('readAloudLag')
  return Math.max(min, Math.min(max, Math.round(n * 2) / 2))
}

/**
 * 词表文本 → 数组（保存/失焦时用）。
 * 逐行 trim、去空行、单条 ≤100 字符、最多 200 条。
 */
export function parseWordsText(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(0, WORDS_MAX_CHARS))
    .slice(0, WORDS_MAX_ENTRIES)
}

/** 词表数组 → textarea 文本（显示用；**不做 trim**，保留用户输入原样）。 */
export function formatWordsText(words) {
  if (!Array.isArray(words)) return ''
  return words.map((w) => String(w ?? '')).join('\n')
}

/**
 * 空闲释放分钟数归一化（区间取自宿主 schema，现在是 0..1440；UI 只列常用档位）。
 */
export function normalizeIdleReleaseMinutes(value) {
  const { min, max } = rangeFor('idleReleaseMinutes')
  return normalizeNumber(value, {
    min, max, fallback: UI_DEFAULTS.idleReleaseMinutes, integer: true,
  })
}

/** 截断到指定长度（宿主 schema 的 maxLen，避免保存时 400）。 */
export function limitString(value, maxLen, fallback) {
  const text = String(value ?? '').trim()
  if (!text) return fallback
  return text.length > maxLen ? text.slice(0, maxLen) : text
}

/**
 * **只截断、不替换**的长度收敛。
 *
 * 和 `limitString` 的区别是刻意的：`limitString` 的约定是「空 → 回退默认」，
 * 而有些字段的空串是合法值（`sovitsUrl: ''` = 用宿主默认地址），
 * 拿它兜底会把用户特意清空的值又填回去。
 *
 * 只管长度，**不判断值本身合不合法**（比如 URL 格式）——
 * 那是宿主的活，客户端不该把「格式错」悄悄改成形而上对的值。
 */
export function truncateTo(value, maxLen) {
  const text = String(value ?? '').trim()
  return text.length > maxLen ? text.slice(0, maxLen) : text
}

/**
 * 唤醒词归一化：trim + ≤32 字符。
 *
 * **不能用 limitString**：唤醒词允许空串（= 关闭唤醒词），
 * 而 limitString 的约定是「空 → 回退默认值」——那会把用户特意清空的
 * 唤醒词又变回「小鱼」，等于关不掉。
 *
 * @param {unknown} value - 表单/配置里的唤醒词。
 * @returns {string} 归一化后的唤醒词（可能为空串）。
 */
export function normalizeWakeWord(value) {
  const text = String(value ?? '').trim()
  return text.length > STRING_LIMITS.wakeWord ? text.slice(0, STRING_LIMITS.wakeWord) : text
}

/**
 * 形如 `+25%` / `-5Hz` 的「选项字符串」：不符合形状/超长 → 回退默认。
 * 宿主 schema 对 rate/pitch/volume 允许自由字符串（Edge 支持任意值），
 * 但 UI 只认识这几种形状；坏值不应被原样保存（到合成期才失败）。
 */
export function limitChoiceString(value, pattern, fallback) {
  const text = String(value ?? '').trim()
  if (!text || text.length > CHOICE_STRING_MAX_LEN || !pattern.test(text)) return fallback
  return text
}

/**
 * UI 下拉的选项列表里补上「当前值」。
 *
 * 宿主 schema 对 rate/pitch/volume/idle 允许列表外的值（老配置可能有），
 * 直接渲染会让浏览器显示成第一项（看起来像被改了）。把当前值作为额外
 * 选项保留下来，保存时也原样保留，避免「一保存就被悄悄改值」。
 */
export function withCurrentOption(options, current) {
  const list = Array.isArray(options) ? options.slice() : []
  const value = current === undefined || current === null ? '' : String(current)
  if (value && !list.includes(value)) list.push(value)
  return list
}

/**
 * 保存前归一化：把表单值收敛成宿主 schema 能接受的形状。
 *
 * - 枚举非法 → 回退默认（ttsEngine/language/liveAsr/mode/rate/pitch/volume/ttsFormat/sovits*）；
 * - 数值越界/非法 → 夹取/回退默认；
 * - `neuralModel` 不在已就绪列表且列表非空 → 自动改用第一个（避免宿主「未知的本地神经模型」）；
 * - 单说话人模型 → neuralSpeaker 归 0；
 * - 识别语言按当前模型过滤（非 SenseVoice / 模型不支持的语言 → auto）。
 *
 * @param {object} raw - 表单里的 config。
 * @param {{readyNeuralIds?: string[], asrModel?: object, neuralSpeakers?: number}} [ctx]
 * @returns {object} 可 POST 的完整配置。
 */
export function normalizeForSave(raw, ctx = {}) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  const engine = normalizeEngine(cfg.ttsEngine) || UI_DEFAULTS.ttsEngine
  const model = String(cfg.model ?? '').trim() || UI_DEFAULTS.model

  // 识别语言按「当前实际选中的模型」过滤：只有 SenseVoice 真正消费 language；
  // 其它模型（whisper / zipformer2）在宿主里根本不读它 → 保存成实际有效的值。
  let language = normalizeLanguage(cfg.language)
  if (ctx.asrModel) {
    const langs = Array.isArray(ctx.asrModel.languages) && ctx.asrModel.languages.length
      ? ctx.asrModel.languages
      : null
    const supportsLanguage = ctx.asrModel.engine === 'sensevoice'
    if (!supportsLanguage) language = 'auto'
    else if (langs && language !== 'auto' && !langs.includes(language)) language = 'auto'
  }

  // 神经模型：配置里的值如果不在已下载列表里，宿主合成时会报「未知的本地神经模型」
  //（整段朗读全部失败）。保存时自动纠正到第一个已就绪模型。
  const readyNeuralIds = Array.isArray(ctx.readyNeuralIds) ? ctx.readyNeuralIds.filter(Boolean) : null
  let neuralModel = String(cfg.neuralModel ?? '').trim() || UI_DEFAULTS.neuralModel
  if (engine === 'neural' && readyNeuralIds && readyNeuralIds.length && !readyNeuralIds.includes(neuralModel)) {
    neuralModel = readyNeuralIds[0]
  }
  let neuralSpeaker = normalizeNumber(cfg.neuralSpeaker, {
    ...rangeFor('neuralSpeaker'), fallback: UI_DEFAULTS.neuralSpeaker, integer: true,
  })
  const speakers = Number(ctx.neuralSpeakers)
  if (Number.isFinite(speakers) && speakers <= 1) neuralSpeaker = 0

  return {
    model: limitString(model, STRING_LIMITS.model, UI_DEFAULTS.model),
    language,
    liveAsr: normalizeEnum(cfg.liveAsr, LIVE_ASR_MODES, UI_DEFAULTS.liveAsr),
    ttsEngine: engine,
    voice: limitString(cfg.voice, STRING_LIMITS.voice, UI_DEFAULTS.voice),
    localVoice: limitString(cfg.localVoice, STRING_LIMITS.localVoice, ''),
    neuralModel: limitString(neuralModel, STRING_LIMITS.neuralModel, UI_DEFAULTS.neuralModel),
    neuralSpeaker,
    // 空串 = 使用默认服务地址（宿主 schema：url 类型，空串合法）。
    // 这里只按宿主 maxLen 2048 截断，不校验格式 —— 格式非法由宿主报 400 并给出人话原因。
    sovitsUrl: truncateTo(cfg.sovitsUrl, STRING_LIMITS.sovitsUrl),
    sovitsRefAudio: limitString(cfg.sovitsRefAudio, STRING_LIMITS.sovitsRefAudio, ''),
    sovitsPromptText: limitString(cfg.sovitsPromptText, STRING_LIMITS.sovitsPromptText, ''),
    sovitsTextLang: normalizeSovitsLang(cfg.sovitsTextLang),
    sovitsPromptLang: normalizeSovitsLang(cfg.sovitsPromptLang),
    // 宿主 schema 里 rate/pitch/volume 是字符串（Edge 允许任意 "+25%"/"-5Hz"），
    // UI 只列常用档位；**不要**把列表外的合法值强制改成默认（会悄悄改用户设置）。
    rate: limitChoiceString(cfg.rate, RATE_PATTERN, UI_DEFAULTS.rate),
    pitch: limitChoiceString(cfg.pitch, PITCH_PATTERN, UI_DEFAULTS.pitch),
    volume: limitChoiceString(cfg.volume, VOLUME_PATTERN, UI_DEFAULTS.volume),
    ttsFormat: normalizeEnum(cfg.ttsFormat, TTS_FORMATS, UI_DEFAULTS.ttsFormat),
    autoSend: cfg.autoSend !== false,
    readAloud: cfg.readAloud === true,
    readAloudLag: clampReadAloudLag(cfg.readAloudLag),
    mode: normalizeEnum(cfg.mode, INTERACTION_MODES, UI_DEFAULTS.mode),
    silenceMs: clampSilenceMs(cfg.silenceMs),
    autoSendExtraMs: clampAutoSendExtraMs(cfg.autoSendExtraMs),
    removeFillers: cfg.removeFillers === true,
    words: parseWordsText(formatWordsText(cfg.words)),
    shortcut: limitString(cfg.shortcut, STRING_LIMITS.shortcut, UI_DEFAULTS.shortcut),
    idleReleaseMinutes: normalizeIdleReleaseMinutes(cfg.idleReleaseMinutes),
    preloadModels: cfg.preloadModels !== false,
    // ---- 全局语音 + AI 界面操控 ----
    // 布尔一律严格比较：旧配置里可能是字符串 "false"（手改 settings.yaml），
    // 用 != false 会把它当成 true，等于偷偷打开了麦克风常驻。
    globalVoice: cfg.globalVoice === true,
    // 快捷键格式由设置面板用 validateShortcut 挡；这里只做长度收敛，
    // 空串回退默认值（不能把空快捷键存进去 —— 保存成功但热键永久失效）。
    globalShortcut: limitString(cfg.globalShortcut, STRING_LIMITS.globalShortcut, UI_DEFAULTS.globalShortcut),
    voicePromptMode: normalizeEnum(cfg.voicePromptMode, VOICE_PROMPT_MODES, UI_DEFAULTS.voicePromptMode),
    uiControl: cfg.uiControl === true,
    uiConfirm: cfg.uiConfirm !== false,
    globalHotkeyHelper: cfg.globalHotkeyHelper === true,
    // v3：空串是合法值（= 关闭唤醒词），不能走 limitString 的「空→默认」。
    wakeWord: normalizeWakeWord(cfg.wakeWord),
  }
}

/**
 * 「保存失败」那行红字里的句子从哪来（批次 20，docs §8.62）：
 *   以前这里是两份手写的中文 —— 一份兜底文案 `UI_DEFAULT_SAVE_ERROR_TEXT`、
 *   一份字段名表 `UI_SAVE_ERROR_LABELS`，再加上宿主 400 里那句中文 `reason`，
 *   拼成 `${中文名}：${宿主句子}` 直接显示。英文界面上这块整条都是中文。
 *   现在三处全部改由字典出：字段名 = `t(配置键)`（字典里的配置项标签本来就是键名），
 *   原因那句 = `configErrorText(码, 键, t)`（`pure/config-error-text.js` 那张表），
 *   兜底那句 = `t('configSaveRejected')`。词表外的 `reason`（老宿主写的整句中文）
 *   **不进界面**，只显示兜底那句。
 */

/**
 * 把 POST /config 的 400 响应变成**给界面显示的那几行**。
 *
 * @param {unknown} payload - `{ok:false, errors:[{key,reason,detail}]}`，
 *   也兼容 `errors` 是字符串数组 / 单个字符串 / `{error}`（老宿主与其它服务的形状）。
 * @param {(key: string, params?: object) => string} [t] - i18n 取词函数。
 *   不传时按「键名就是文案」处理（单测与旧调用点用的就是这个口径）。
 * @returns {string[]} 每行都是 `字段名：那句` —— **两段文字都来自字典**，
 *   宿主给的 `reason` 只有在是词表内的码时才会被翻成句子，
 *   词表外的值（老宿主那句中文）与 `detail` 都不会出现在这里。
 */
export function collectSaveErrors(payload, t) {
  const translate = typeof t === 'function' ? t : (key) => key
  const out = []
  const push = (value) => {
    if (value === undefined || value === null) return
    if (Array.isArray(value)) { for (const item of value) push(item); return }
    if (typeof value === 'string') {
      // 自由文本不是码，也不该被搬到界面上（批次 20 的核心那条判据）。
      if (value.trim()) out.push(translate('configErrorUnknown'))
      return
    }
    if (typeof value === 'object') {
      const reason = value.reason ?? value.message ?? value.error
      if (reason === undefined || reason === null || reason === '') return
      const key = value.key === undefined || value.key === null ? '' : String(value.key)
      const line = configErrorText(reason, key, translate)
      const label = configFieldLabel(key, translate)
      out.push(label ? `${label}：${line}` : line)
    }
  }
  if (payload && typeof payload === 'object') {
    push(payload.errors)
    if (!out.length) push(payload.error)
    if (!out.length && payload.ok === false) out.push(translate('configSaveRejected'))
  }
  return out.slice(0, 20)
}

/**
 * 读取 /tts 响应头里的引擎信息（`x-tts-engine` / `x-tts-engine-fallback`）。
 * 头对象可能是 Headers（有 get）或普通对象；拿不到就返回空串，绝不抛错。
 */
export function extractTtsMeta(headers) {
  const get = (name) => {
    try {
      if (!headers) return ''
      if (typeof headers.get === 'function') return String(headers.get(name) ?? '')
      const lower = name.toLowerCase()
      return String(headers[name] ?? headers[lower] ?? '')
    } catch {
      return ''
    }
  }
  return {
    engine: get('x-tts-engine').trim().toLowerCase(),
    fallback: get('x-tts-engine-fallback').trim().toLowerCase(),
  }
}

/**
 * 归一化 `/tts/env` 的引擎清单（宿主新版可能返回 `supported/configured/url` 形状）。
 *
 * 返回 `[{ id, status: 'ok'|'bad'|'', reason, params, detail, current }]`；字段缺失不崩。
 *
 * **`reason` 是宿主给的原因码**（`src/shared/tts-env-reasons.js`），这里不翻译、也不校验词表
 * —— 校验在 `tts-env-reason-text.js` 那一头，词表外的值走兜底句（批次 22-3-2，docs §8.67）。
 * **`detail` 现在只剩一种来源**：sovits 那一行的服务地址。改前这里是
 * `item.detail || item.url || item.reason` 三级兜底，把 `src/host/tts-env.js` 写的中文整句
 * 一路搬进面板，英文界面那一块就跟着变中文；宿主那句原文仍留在 `/tts/env` 的响应体里，
 * 但它的读者是 `/diagnostics`，不是这个函数。
 *
 * @param {object} envInfo - `/tts/env` 的响应体。
 * @param {string} currentEngine - 配置里的引擎（`configured` 缺失时用它）。
 * @returns {Array<object>} 面板每一行要的数据。
 */
export function formatEnvEngines(envInfo, currentEngine) {
  const list = Array.isArray(envInfo?.engines) ? envInfo.engines : []
  const configured = typeof envInfo?.configured === 'string' ? envInfo.configured : ''
  const active = configured || normalizeEngine(currentEngine) || 'online'
  return list.map((item, index) => {
    if (!item || typeof item !== 'object') {
      return { id: `engine-${index}`, status: '', reason: '', params: {}, detail: '', current: false }
    }
    const id = String(item.id ?? `engine-${index}`)
    // 宿主两种行形状：
    //   { available, reason, params, detail }（online/local/neural，真探测过）
    //   { supported, url, configured }（sovits 外部服务 —— **不探测**，别显示成 ✓/✗）
    let available
    if (item.available !== undefined) available = item.available
    else if (id === 'sovits' && item.supported === true) available = undefined
    else if (item.supported !== undefined) available = item.supported
    const status = available === true ? 'ok' : available === false ? 'bad' : ''
    return {
      id,
      status,
      reason: typeof item.reason === 'string' ? item.reason : '',
      params: item.params && typeof item.params === 'object' ? item.params : {},
      detail: item.url === undefined || item.url === null ? '' : String(item.url),
      current: item.configured === true || (Boolean(active) && id === active),
    }
  })
}
