/**
 * 配置 schema（纯函数）—— 35 个配置项的**校验与清洗**规则。
 * （每个键的类型 / 范围 / 默认值在 `src/shared/config-spec.js`，枚举词表在
 *  `src/shared/config-vocab.js`；本文件是它们的宿主入口。）
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
 *   - `sanitizeConfig(raw, defaults)` 的 `defaults` 由调用方传入（宿主传 `CONFIG_DEFAULTS`），
 *     这样「清洗时的回退值」和「落盘时的初始值」可以是不同来源（行配置覆盖）；
 *   - 未知键**忽略**（向前/向后兼容旧配置文件），但不会被写进结果。
 *
 * 键的**类型、合法范围与默认值**都不在这里：住在 `src/shared/config-spec.js`
 * （单源，浏览器侧 `src/client/pure/config-normalize.js` 引的是同一个模块）；
 * 枚举词表住在 `src/shared/config-vocab.js`。
 * 本文件只负责「拿到一份规则之后怎么校验、怎么清洗」。
 * 历史形态是宿主 `lib/index.js` 里一份 `DEFAULTS` + 本文件一份 `SPECS` +
 * 客户端一份 `UI_DEFAULTS` + 客户端一份 `STRING_LIMITS`，四处靠
 * `test/config-contract.test.mjs` 横断言维持一致 —— 3.3b 把它们合成一处。
 *
 * 原有导出面（词表名、`CONFIG_SPEC_KEYS`、`sanitizeConfig` 等）保持不变，
 * `lib/index.js` 与既有测试的 import 不用改。
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
} from '../shared/config-vocab.js'
import {
  CONFIG_SPECS,
  CONFIG_SPEC_KEYS,
  CONFIG_DEFAULTS,
  CONFIG_MAX_LENS,
  DEFAULT_SOVITS_URL,
  rangeFor,
  specFor,
} from '../shared/config-spec.js'
import { CONFIG_ERROR_REASONS } from '../shared/config-error-codes.js'

export {
  TTS_ENGINES,
  ASR_LANGUAGES,
  SOVITS_LANGUAGES,
  LIVE_ASR_MODES,
  INTERACTION_MODES,
  VOICE_PROMPT_MODES,
  TTS_FORMATS,
  MAX_WORDS,
  MAX_WORD_CHARS,
}

// 字段规则与默认值：宿主公共面上仍然叫 `CONFIG_SPEC_KEYS`，默认值经本文件再导一次，
// 这样 `lib/index.js` 只需要认识 config-schema 这一个模块。
// `CONFIG_SPECS` 也导出去：测试与诊断要读「某个键合法取值/范围/默认值」时，
// 应该读这份**数据**，而不是拿源码正则去刮字面量（历史上有三处测试那么做过，
// 每次规则搬家都要跟着改正则）。
export {
  CONFIG_SPECS,
  CONFIG_DEFAULTS,
  CONFIG_MAX_LENS,
  CONFIG_SPEC_KEYS,
  DEFAULT_SOVITS_URL,
  rangeFor,
  specFor,
}

/**
 * 每个配置键的 schema —— **就是** `src/shared/config-spec.js` 里的 `CONFIG_SPECS`。
 *
 * 保留 `SPECS` 这个内部名字：下面的清洗与校验代码按它取值，
 * 全量改名会把这次「搬家」的 diff 淹在无关行里。
 * 每个键的类型 / 枚举 / 范围 / maxLen / 默认值（`def`）都写在真源那一侧，
 * 这里只说明各类型在本模块里的处理方式：
 *   - `enum`   ：枚举字符串（大小写不敏感匹配）；
 *   - `boolean`：严格布尔；
 *   - `number` ：数字（POST 时允许安全强转「数字字符串」，如 '15'）；
 *   - `integer`：`number` 的附加要求，清洗时四舍五入；
 *   - `string` ：字符串（trim，受 `maxLen` 限制；空串合法 = 清空）；
 *   - `url`    ：http(s) URL 或空串（空串 = 用默认地址）；
 *   - `words`  ：词表数组（string 或 {correct, replace} 对象，统一归一化成字符串形式）。
 */
const SPECS = CONFIG_SPECS

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

/**
 * 校验 URL：返回 `{ value }` / `{ empty:true }` / `{ invalid:true, code, reason }`。
 *
 * `code` 是 `src/shared/config-error-codes.js` 里的原因码（给界面查字典用），
 * `reason` 是这句原始中文（只给 sanitize 的告警文本和日志用，不进界面）。
 * 非字符串这种写法在 URL 字段上也归 `not-a-string`：界面上要做的动作一样
 * （那一格填一段文本），区分「它本该是 URL」由字段名自己说。
 */
function inspectUrl(value) {
  if (typeof value !== 'string') {
    return { invalid: true, code: CONFIG_ERROR_REASONS.NOT_A_STRING, reason: '应为字符串 URL' }
  }
  const text = value.trim()
  if (!text) return { empty: true }
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    return { invalid: true, code: CONFIG_ERROR_REASONS.URL_MALFORMED, reason: '不是合法的 URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      invalid: true,
      code: CONFIG_ERROR_REASONS.URL_NOT_HTTP,
      reason: '必须是 http(s) 地址',
    }
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
 * @returns {{ok: true, value: object} | {ok: false, errors: {key: string, reason: string, detail: string}[]}}
 *   `ok:true` 时 `value` 只包含合法且已归一化的已知键。
 *   `ok:false` 时每条错误是 `{key, reason, detail}`：**`reason` 是
 *   `src/shared/config-error-codes.js` 里的原因码**（不是句子，界面按它查字典），
 *   `detail` 是这句原始中文（只进响应体与日志，客户端不显示它，批次 20 / docs §8.62）。
 */
export function validateConfigPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return {
      ok: false,
      errors: [{
        key: '',
        reason: CONFIG_ERROR_REASONS.PATCH_NOT_OBJECT,
        detail: '配置必须是 JSON 对象',
      }],
    }
  }
  const errors = []
  const value = {}
  for (const key of CONFIG_SPEC_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue
    const checked = validateValue(key, patch[key])
    if (checked.ok) value[key] = checked.value
    else errors.push({ key, reason: checked.code, detail: checked.detail })
  }
  if (errors.length) return { ok: false, errors }
  return { ok: true, value }
}

/**
 * 严格校验单个值（POST 用）。
 *
 * @param {string} key - 配置键。
 * @param {unknown} rawValue - 提交的原始值。
 * @returns {{ok: true, value: unknown} | {ok: false, code: string, detail: string}}
 *   失败时给的是原因码 + 原始中文（`detail` 不进界面，见 `validateConfigPatch`）。
 */
function validateValue(key, rawValue) {
  const spec = SPECS[key]
  const bad = (code, detail) => ({ ok: false, code, detail })
  switch (spec.type) {
    case 'boolean':
      return typeof rawValue === 'boolean'
        ? { ok: true, value: rawValue }
        : bad(CONFIG_ERROR_REASONS.NOT_BOOLEAN, '应为布尔值（true/false）')
    case 'enum': {
      const matched = matchEnum(spec.values, rawValue)
      return matched
        ? { ok: true, value: matched }
        : bad(CONFIG_ERROR_REASONS.NOT_IN_ENUM, `应为 ${spec.values.join(' / ')} 之一`)
    }
    case 'number': {
      const parsed = toFiniteNumber(rawValue)
      if (parsed === null) return bad(CONFIG_ERROR_REASONS.NOT_A_NUMBER, '应为数字（或数字字符串）')
      if (spec.integer && !Number.isInteger(parsed)) return bad(CONFIG_ERROR_REASONS.NOT_INTEGER, '应为整数')
      if (parsed < spec.min || parsed > spec.max) {
        return bad(CONFIG_ERROR_REASONS.OUT_OF_RANGE, `应在 ${spec.min}..${spec.max} 之间`)
      }
      return { ok: true, value: parsed }
    }
    case 'string': {
      if (typeof rawValue !== 'string') return bad(CONFIG_ERROR_REASONS.NOT_A_STRING, '应为字符串')
      const text = rawValue.trim()
      if (text.length > spec.maxLen) {
        return bad(CONFIG_ERROR_REASONS.TOO_LONG, `长度不能超过 ${spec.maxLen}`)
      }
      return { ok: true, value: text }
    }
    case 'url': {
      const checked = inspectUrl(rawValue)
      // inspectUrl 已经把「非字符串」归到 not-a-string，这里原样传出去。
      if (checked.invalid) return bad(checked.code, checked.reason)
      if (checked.empty) return { ok: true, value: '' }
      if (checked.value.length > spec.maxLen) {
        return bad(CONFIG_ERROR_REASONS.TOO_LONG, `URL 不能超过 ${spec.maxLen} 字符`)
      }
      return { ok: true, value: checked.value }
    }
    case 'words': {
      if (!Array.isArray(rawValue)) return bad(CONFIG_ERROR_REASONS.NOT_AN_ARRAY, '应为数组')
      if (rawValue.length > MAX_WORDS) {
        return bad(CONFIG_ERROR_REASONS.WORDS_TOO_MANY, `最多 ${MAX_WORDS} 条`)
      }
      const out = []
      for (let i = 0; i < rawValue.length; i += 1) {
        const entry = rawValue[i]
        if (typeof entry === 'string') {
          const text = entry.trim()
          if (!text) return bad(CONFIG_ERROR_REASONS.WORDS_EMPTY_ENTRY, `第 ${i + 1} 条为空`)
          if (text.length > MAX_WORD_CHARS) {
            return bad(CONFIG_ERROR_REASONS.WORDS_ENTRY_TOO_LONG, `第 ${i + 1} 条超过 ${MAX_WORD_CHARS} 字符`)
          }
          out.push(text)
          continue
        }
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          const correct = typeof entry.correct === 'string' ? entry.correct.trim() : ''
          if (!correct) {
            return bad(CONFIG_ERROR_REASONS.WORDS_MISSING_CORRECT, `第 ${i + 1} 条缺少 correct`)
          }
          if (correct.length > MAX_WORD_CHARS) {
            return bad(CONFIG_ERROR_REASONS.WORDS_ENTRY_TOO_LONG, `第 ${i + 1} 条超过 ${MAX_WORD_CHARS} 字符`)
          }
          const replace = typeof entry.replace === 'string' ? entry.replace.trim() : ''
          if (replace.length > MAX_WORD_CHARS) {
            return bad(CONFIG_ERROR_REASONS.WORDS_ENTRY_TOO_LONG, `第 ${i + 1} 条 replace 超过 ${MAX_WORD_CHARS} 字符`)
          }
          out.push(replace ? `${correct}=${replace}` : correct)
          continue
        }
        return bad(CONFIG_ERROR_REASONS.WORDS_ENTRY_SHAPE, `第 ${i + 1} 条应为字符串或 {correct, replace} 对象`)
      }
      return { ok: true, value: out }
    }
    default:
      return bad(CONFIG_ERROR_REASONS.UNKNOWN_SPEC_TYPE, '未知的配置类型')
  }
}
