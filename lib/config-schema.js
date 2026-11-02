/**
 * 配置 schema（纯函数）—— 35 个配置项的类型 / 枚举 / 范围 / 清洗规则。
 *
 * 为什么需要它：
 *   之前 `POST /config` 对写入的值**完全不做校验**（审计报告 task-15 的 R6）：
 *   `ttsEngine: 123`、`readAloudLag: 'abc'`、`neuralSpeaker: 9999` 都会原样落盘，
 *   然后运行期才以「静默走 online / 静默关闭追赶 / 每句 500」的形式爆炸。
 *   这里把「什么值是合法的、非法值怎么处理」收敛成一份纯函数：
 *     - `validateConfigPatch`：POST /config 严格校验（非法 → 错误列表，不落盘）；
 *     - `sanitizeConfig`：加载/GET 时**尽力清洗**（非法 → 回退默认并记 warning，
 *       数值越界 clamp），保证运行期拿到的配置始终是「形状正确」的；
 *     - `normalizeTtsEngine`：引擎取值 trim + 小写 + 枚举，非法返回 ''（绝不默认 online）。
 *
 * 设计约束：
 *   - 纯函数、无宿主依赖（方便单测）；
 *   - `sanitizeConfig(raw, defaults)` 的 `defaults` 由调用方传入（宿主用 lib/index.js 的
 *     DEFAULTS），这样默认值只有一份真源；
 *   - 未知键**忽略**（向前/向后兼容旧配置文件），但不会被写进结果。
 *
 * 键的默认值见 `lib/index.js` 的 `DEFAULTS`；本模块只描述「类型与合法范围」。
 */

/** 支持的 TTS 引擎（顺序与设置面板一致）。 */
export const TTS_ENGINES = ['online', 'local', 'neural', 'sovits']

/** 识别语言提示（auto = 由模型判断）。 */
export const ASR_LANGUAGES = ['auto', 'zh', 'en', 'yue', 'ja', 'ko']

/** GPT-SoVITS 官方 api_v2 支持的语言（没有 auto）。 */
export const SOVITS_LANGUAGES = ['zh', 'en', 'ja', 'ko', 'yue']

/** 实时字方式。 */
export const LIVE_ASR_MODES = ['full', 'stream', 'auto']

/** 交互模式。 */
export const INTERACTION_MODES = ['toggle', 'once']

/**
 * 全局语音文本的注入方式（与宿主注入回合的 mode 一一对应）。
 *   - queue：排到下一轮（默认；助手空闲时就是发一条新消息）；
 *   - steer：插到当前这一步（助手正在生成时用，避免打断整轮）。
 * 客户端与宿主共用同一份枚举，写入配置时大小写不敏感归一化。
 */
export const VOICE_PROMPT_MODES = ['queue', 'steer']

/** Edge TTS 输出格式（与设置面板的两个选项一致）。 */
export const TTS_FORMATS = [
  'AUDIO_24KHZ_48KBITRATE_MONO_MP3',
  'AUDIO_24KHZ_96KBITRATE_MONO_MP3',
]

/** 词表上限。 */
export const MAX_WORDS = 200
/** 词表单条字符上限。 */
export const MAX_WORD_CHARS = 100

/**
 * 每个配置键的 schema。
 *
 * 类型：
 *   - `enum`   ：枚举字符串（大小写不敏感匹配）；
 *   - `boolean`：严格布尔；
 *   - `number` ：数字（POST 时允许安全强转「数字字符串」，如 '15'）；
 *   - `integer`: 整数数字；
 *   - `string` ：字符串（trim，有长度上限；空串合法 = 清空）；
 *   - `url`    ：http(s) URL 或空串（空串 = 用默认地址）；
 *   - `words`  ：词表数组（string 或 {correct, replace} 对象，统一归一化成字符串形式）。
 */
const SPECS = {
  model: { type: 'string', maxLen: 64 },
  language: { type: 'enum', values: ASR_LANGUAGES },
  liveAsr: { type: 'enum', values: LIVE_ASR_MODES },
  ttsEngine: { type: 'enum', values: TTS_ENGINES },
  voice: { type: 'string', maxLen: 200 },
  localVoice: { type: 'string', maxLen: 200 },
  neuralModel: { type: 'string', maxLen: 64 },
  /**
   * 说话人 id。
   *
   * 上限取 1000 而不是「很大」：设置面板只会从模型自带的 speakers 里选，
   * 真实档位的 speaker 数都远小于 1000；把上限放宽到 10000 会让
   * `neuralSpeaker: 9999` 这种明显越界的值通过校验、到合成期才每句 500。
   */
  neuralSpeaker: { type: 'number', min: 0, max: 1000, integer: true },
  sovitsUrl: { type: 'url', maxLen: 2048 },
  sovitsRefAudio: { type: 'string', maxLen: 1024 },
  sovitsPromptText: { type: 'string', maxLen: 500 },
  sovitsTextLang: { type: 'enum', values: SOVITS_LANGUAGES },
  sovitsPromptLang: { type: 'enum', values: SOVITS_LANGUAGES },
  rate: { type: 'string', maxLen: 16 },
  pitch: { type: 'string', maxLen: 16 },
  volume: { type: 'string', maxLen: 16 },
  ttsFormat: { type: 'enum', values: TTS_FORMATS },
  autoSend: { type: 'boolean' },
  readAloud: { type: 'boolean' },
  readAloudLag: { type: 'number', min: 0, max: 120 },
  mode: { type: 'enum', values: INTERACTION_MODES },
  silenceMs: { type: 'number', min: 500, max: 5000 },
  autoSendExtraMs: { type: 'number', min: 0, max: 5000 },
  removeFillers: { type: 'boolean' },
  words: { type: 'words' },
  shortcut: { type: 'string', maxLen: 64 },
  idleReleaseMinutes: { type: 'number', min: 0, max: 1440, integer: true },
  preloadModels: { type: 'boolean' },
  /**
   * 全局语音浮层（任意页面常驻的麦克风/字幕小窗）。
   * 默认关：它会常驻监听入口并占用麦克风，必须是用户显式打开的开关。
   */
  globalVoice: { type: 'boolean' },
  /**
   * 全局语音切换快捷键（窗口内生效；helper 也用它注册系统级热键）。
   * 上限 64 与现有 shortcut 一致：设置面板的录制框只产出短字符串。
   */
  globalShortcut: { type: 'string', maxLen: 64 },
  /** 语音文本注入方式：下一轮 / 当前轮下一步。 */
  voicePromptMode: { type: 'enum', values: VOICE_PROMPT_MODES },
  /**
   * 允许模型通过 `voice_ui` 工具操控界面。
   * 默认关：这是「AI 能操作你的界面」的总开关，不能默认替用户打开。
   */
  uiControl: { type: 'boolean' },
  /** 危险 UI 动作（切会话/新建/执行命令/发消息/中止生成）是否要用户确认。 */
  uiConfirm: { type: 'boolean' },
  /** 是否拉起系统级全局热键 helper（额外进程，仅 Windows）。 */
  globalHotkeyHelper: { type: 'boolean' },
  /**
   * 全局语音待机唤醒词（默认「小D」；空串 = 关闭，回到说话直接发）。
   * 上限 32：设置面板的输入框只收一个短语，真实唤醒词通常 2~4 个字；
   * 放宽上限没有意义，还会让匹配逻辑更慢更易误唤醒。
   */
  wakeWord: { type: 'string', maxLen: 32 },
}

/** schema 覆盖的全部键（顺序与 SPECS 一致）。 */
export const CONFIG_SPEC_KEYS = Object.keys(SPECS)

/**
 * 归一化 TTS 引擎取值：trim + 小写 + 枚举匹配。
 *
 * **非法/空返回 ''**（调用方据此报错/拒绝，绝不静默当成 online）。
 *
 * @param {unknown} value - 配置或查询参数里的引擎值。
 * @returns {'online'|'local'|'neural'|'sovits'|''} 归一化引擎；非法为空串。
 */
export function normalizeTtsEngine(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim().toLowerCase()
  return TTS_ENGINES.includes(text) ? text : ''
}

/** 把值安全转成有限数字；非法返回 null（不把布尔/数组当数字）。 */
function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** 枚举匹配（大小写不敏感；空/非字符串返回 null）。 */
function matchEnum(values, value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  if (values.includes(text)) return text
  const lower = text.toLowerCase()
  return values.find((item) => item.toLowerCase() === lower) ?? null
}

/** 校验 URL：返回 { value } / { empty:true } / { invalid:true, reason }。 */
function inspectUrl(value) {
  if (typeof value !== 'string') return { invalid: true, reason: '应为字符串 URL' }
  const text = value.trim()
  if (!text) return { empty: true }
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    return { invalid: true, reason: '不是合法的 URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { invalid: true, reason: '必须是 http(s) 地址' }
  }
  return { value: text }
}

/**
 * 把一条词表条目归一化成字符串形式（与 `parseWordEntries` 支持的两种写法等价）：
 *   - 字符串：trim 后保留；
 *   - `{correct}`：热词，归一化为 `correct`；
 *   - `{correct, replace}`：替换规则，归一化为 `correct=replace`。
 *
 * @param {unknown} entry - 词表条目。
 * @returns {string|null} 归一化后的条目；无效返回 null。
 */
function normalizeWordEntry(entry) {
  if (typeof entry === 'string') {
    const text = entry.trim()
    if (!text) return null
    return text.slice(0, MAX_WORD_CHARS)
  }
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const correct = typeof entry.correct === 'string' ? entry.correct.trim() : ''
    if (!correct) return null
    const replace = typeof entry.replace === 'string' ? entry.replace.trim() : ''
    const left = correct.slice(0, MAX_WORD_CHARS)
    if (!replace) return left
    return `${left}=${replace.slice(0, MAX_WORD_CHARS)}`
  }
  return null
}

/** 按 schema 给「缺省且 defaults 里也没有」的键一个类型正确的空值。 */
function emptyValue(spec) {
  switch (spec.type) {
    case 'boolean': return false
    case 'number': return spec.min ?? 0
    case 'words': return []
    default: return ''
  }
}

/**
 * 清洗单个值（加载/GET 用，不报错）。
 *
 * @param {string} key - 配置键。
 * @param {unknown} value - 原始值。
 * @param {unknown} fallback - 默认值（来自 DEFAULTS）。
 * @returns {{value: unknown, warning?: string}} 清洗后的值与告警（可选）。
 */
function sanitizeValue(key, value, fallback) {
  const spec = SPECS[key]
  switch (spec.type) {
    case 'boolean': {
      if (typeof value === 'boolean') return { value }
      return { value: fallback ?? false, warning: '应为布尔值，已回退默认' }
    }
    case 'enum': {
      const matched = matchEnum(spec.values, value)
      if (matched) return { value: matched }
      return {
        value: fallback,
        warning: `取值 ${JSON.stringify(value)} 不在允许范围（${spec.values.join('/')}），已回退默认`,
      }
    }
    case 'number': {
      const parsed = toFiniteNumber(value)
      if (parsed === null) return { value: fallback, warning: '应为数字，已回退默认' }
      let out = Math.max(spec.min, Math.min(spec.max, parsed))
      let warning = ''
      if (out !== parsed) warning = `超出范围 ${spec.min}..${spec.max}，已限制为 ${out}`
      if (spec.integer) {
        const rounded = Math.round(out)
        if (rounded !== out) {
          out = rounded
          warning = warning || '应为整数，已四舍五入'
        }
        out = Math.max(spec.min, Math.min(spec.max, out))
      }
      return warning ? { value: out, warning } : { value: out }
    }
    case 'string': {
      if (typeof value !== 'string') return { value: fallback ?? '', warning: '应为字符串，已回退默认' }
      const text = value.trim()
      if (text.length > spec.maxLen) {
        return { value: text.slice(0, spec.maxLen), warning: `超过长度上限 ${spec.maxLen}，已截断` }
      }
      return { value: text }
    }
    case 'url': {
      const checked = inspectUrl(value)
      if (checked.invalid) return { value: fallback, warning: `${checked.reason}，已回退默认` }
      if (checked.empty) return { value: fallback } // 空串 = 用默认地址
      if (checked.value.length > spec.maxLen) {
        return { value: fallback, warning: `URL 超过长度上限 ${spec.maxLen}，已回退默认` }
      }
      return { value: checked.value }
    }
    case 'words': {
      if (!Array.isArray(value)) {
        return { value: Array.isArray(fallback) ? [...fallback] : [], warning: '应为数组，已回退默认' }
      }
      const out = []
      let dropped = 0
      for (const entry of value) {
        if (out.length >= MAX_WORDS) break
        const normalized = normalizeWordEntry(entry)
        if (normalized === null) { dropped += 1; continue }
        out.push(normalized)
      }
      const notes = []
      if (dropped > 0) notes.push(`丢弃 ${dropped} 条无效词表条目`)
      if (value.length > MAX_WORDS) notes.push(`词表最多 ${MAX_WORDS} 条，已截断`)
      return notes.length ? { value: out, warning: notes.join('；') } : { value: out }
    }
    default:
      return { value: fallback }
  }
}

/**
 * 清洗整份配置（加载 / GET /config 用，**不报错**）。
 *
 * 规则：
 *   - 非法/越界 → 回退默认（数值按范围 clamp；枚举回退默认；字符串 trim/截断；
 *     words 丢掉无效条目并截断到上限）；
 *   - 非法项记入 `warnings`（宿主挂到 `/diagnostics.configWarnings`，
 *     **不要**混进 `/config` 响应）；
 *   - 只输出 schema 里定义的键（顺序尽量沿用 `defaults` 的键序）；
 *   - 未知键忽略（旧配置里的废弃键不会带进运行期配置）。
 *
 * @param {object} raw - 原始配置（可能来自 rowConfig / 配置文件 / 合并结果）。
 * @param {object} defaults - 默认配置（宿主传 DEFAULTS）。
 * @returns {{config: object, warnings: {key: string, reason: string}[]}} 清洗后的完整配置与告警。
 */
export function sanitizeConfig(raw, defaults = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const base = defaults && typeof defaults === 'object' && !Array.isArray(defaults) ? defaults : {}
  const config = {}
  const warnings = []
  const keyOrder = [...new Set([...Object.keys(base), ...CONFIG_SPEC_KEYS])]
  for (const key of keyOrder) {
    if (!Object.prototype.hasOwnProperty.call(SPECS, key)) continue
    const fallback = Object.prototype.hasOwnProperty.call(base, key) ? base[key] : undefined
    const spec = SPECS[key]
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      const empty = fallback === undefined ? emptyValue(spec) : fallback
      config[key] = Array.isArray(empty) ? [...empty] : empty
      continue
    }
    const result = sanitizeValue(key, source[key], fallback === undefined ? emptyValue(spec) : fallback)
    config[key] = result.value
    if (result.warning) warnings.push({ key, reason: result.warning })
  }
  return { config, warnings }
}

/**
 * 严格校验一份配置 patch（POST /config 用）。
 *
 * 规则：
 *   - 只校验 schema 里出现的键；**未知键忽略**（不报错）；
 *   - 类型/枚举/范围/URL 非法 → 对应错误（不会写盘）；
 *   - 数字键允许安全强转「数字字符串」（如 `'15'` → `15`）；
 *   - 字符串键的空串合法（表示清空；`sovitsUrl` 空串 = 使用默认地址）；
 *   - `words` 接受 `string[]`，也兼容旧的 `{correct, replace}[]`，
 *     统一归一化成字符串形式。
 *
 * @param {unknown} patch - 客户端提交的 patch（JSON 对象）。
 * @returns {{ok: true, value: object} | {ok: false, errors: {key: string, reason: string}[]}}
 *   `ok:true` 时 `value` 只包含合法且已归一化的已知键。
 */
export function validateConfigPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, errors: [{ key: '', reason: '配置必须是 JSON 对象' }] }
  }
  const errors = []
  const value = {}
  for (const key of CONFIG_SPEC_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue
    const checked = validateValue(key, patch[key])
    if (checked.ok) value[key] = checked.value
    else errors.push({ key, reason: checked.reason })
  }
  if (errors.length) return { ok: false, errors }
  return { ok: true, value }
}

/**
 * 严格校验单个值（POST 用）。
 *
 * @param {string} key - 配置键。
 * @param {unknown} rawValue - 提交的原始值。
 * @returns {{ok: true, value: unknown} | {ok: false, reason: string}} 校验结果。
 */
function validateValue(key, rawValue) {
  const spec = SPECS[key]
  switch (spec.type) {
    case 'boolean':
      return typeof rawValue === 'boolean'
        ? { ok: true, value: rawValue }
        : { ok: false, reason: '应为布尔值（true/false）' }
    case 'enum': {
      const matched = matchEnum(spec.values, rawValue)
      return matched
        ? { ok: true, value: matched }
        : { ok: false, reason: `应为 ${spec.values.join(' / ')} 之一` }
    }
    case 'number': {
      const parsed = toFiniteNumber(rawValue)
      if (parsed === null) return { ok: false, reason: '应为数字（或数字字符串）' }
      if (spec.integer && !Number.isInteger(parsed)) return { ok: false, reason: '应为整数' }
      if (parsed < spec.min || parsed > spec.max) {
        return { ok: false, reason: `应在 ${spec.min}..${spec.max} 之间` }
      }
      return { ok: true, value: parsed }
    }
    case 'string': {
      if (typeof rawValue !== 'string') return { ok: false, reason: '应为字符串' }
      const text = rawValue.trim()
      if (text.length > spec.maxLen) return { ok: false, reason: `长度不能超过 ${spec.maxLen}` }
      return { ok: true, value: text }
    }
    case 'url': {
      const checked = inspectUrl(rawValue)
      if (checked.invalid) return { ok: false, reason: checked.reason }
      if (checked.empty) return { ok: true, value: '' }
      if (checked.value.length > spec.maxLen) {
        return { ok: false, reason: `URL 不能超过 ${spec.maxLen} 字符` }
      }
      return { ok: true, value: checked.value }
    }
    case 'words': {
      if (!Array.isArray(rawValue)) return { ok: false, reason: '应为数组' }
      if (rawValue.length > MAX_WORDS) return { ok: false, reason: `最多 ${MAX_WORDS} 条` }
      const out = []
      for (let i = 0; i < rawValue.length; i += 1) {
        const entry = rawValue[i]
        if (typeof entry === 'string') {
          const text = entry.trim()
          if (!text) return { ok: false, reason: `第 ${i + 1} 条为空` }
          if (text.length > MAX_WORD_CHARS) {
            return { ok: false, reason: `第 ${i + 1} 条超过 ${MAX_WORD_CHARS} 字符` }
          }
          out.push(text)
          continue
        }
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          const correct = typeof entry.correct === 'string' ? entry.correct.trim() : ''
          if (!correct) return { ok: false, reason: `第 ${i + 1} 条缺少 correct` }
          if (correct.length > MAX_WORD_CHARS) {
            return { ok: false, reason: `第 ${i + 1} 条超过 ${MAX_WORD_CHARS} 字符` }
          }
          const replace = typeof entry.replace === 'string' ? entry.replace.trim() : ''
          if (replace.length > MAX_WORD_CHARS) {
            return { ok: false, reason: `第 ${i + 1} 条 replace 超过 ${MAX_WORD_CHARS} 字符` }
          }
          out.push(replace ? `${correct}=${replace}` : correct)
          continue
        }
        return { ok: false, reason: `第 ${i + 1} 条应为字符串或 {correct, replace} 对象` }
      }
      return { ok: true, value: out }
    }
    default:
      return { ok: false, reason: '未知的配置类型' }
  }
}
