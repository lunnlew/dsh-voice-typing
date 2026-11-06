/**
 * 「保存设置没存进去」那行红字 —— 原因码 → i18n 键的**唯一一张表**（批次 20，docs §8.62）。
 *
 * 分工（和批次 18 的 `pure/asr-ready-text.js`、批次 19 的 `pure/hotkey-reason-text.js` 同一条）：
 *   宿主只报「这个值不合哪条规则」这件事实（`src/shared/config-error-codes.js` 里的码），
 *   这句人话由客户端按当前语言出。词表外的值（老宿主写来的整句中文、脏数据）
 *   一律走兜底那句 —— 宿主的原样一个字都不进界面，它留在响应体的 `detail` 里给排查。
 *
 * **这里为什么没有「第 N 条」「允许值列表」「区间」这些动态内容**：
 *   那些值本来就住在 `src/shared/config-spec.js` / `config-vocab.js` 里，两端读同一份。
 *   所以宿主只要给出 `key`，客户端自己就能算出「这一格的允许值是哪些、区间是多少、上限几个字」，
 *   不需要为了传话再发明一套参数协议。只有「第几条出的错」是宿主独有的信息，
 *   它按批次 19 的处理方式留在 `detail`（界面不显示）。
 *
 * **字段名也在这张表之外解决**：字典里的配置项标签用的就是配置键本身
 * （`wakeWord`、`globalHotkeyHelper` 这些，设置面板每一行的标题也是它），
 * 所以 `configFieldLabel(key, t)` 就是 `t(key)`：字典里有就出人话，没有就退回键名本身
 * —— 这正是以前那两条「旧键保持 key：reason 形状」的行为，只是不再需要一张手写的中文表
 * （被删掉的 `UI_SAVE_ERROR_LABELS`，见 `docs/architecture-modernization.md` §8.62）。
 *
 * 环境约束：纯 ESM、零浏览器全局、零 Node API、零 React（`test/bundle-sync.test.mjs` 机械守卫）。
 */
import { isConfigErrorCode } from '../../shared/config-error-codes.js'
import { MAX_WORDS, MAX_WORD_CHARS } from '../../shared/config-vocab.js'
import { specFor } from '../../shared/config-spec.js'

/**
 * 码 → i18n 键。两处**故意合并**（和批次 19 同一个道理：码要分得开，句子不必每个都独有）：
 * `not-a-string` 罩住「文本格填了非文本」和「URL 格填了非文本」；
 * `too-long` 罩住「文本超长」和「URL 超长」—— 界面上要做的动作一样，
 * 而到底是哪一格、上限多少，由 `key` 去 spec 里当场算出来。
 */
export const CONFIG_ERROR_KEYS = Object.freeze({
  'body-not-json': 'configErrorBodyNotJson',
  'body-too-large': 'configErrorBodyTooLarge',
  'patch-not-object': 'configErrorPatchNotObject',
  'save-failed': 'configErrorSaveFailed',
  'not-boolean': 'configErrorBoolean',
  'not-in-enum': 'configErrorEnum',
  'not-a-number': 'configErrorNumber',
  'not-integer': 'configErrorInteger',
  'out-of-range': 'configErrorRange',
  'not-a-string': 'configErrorString',
  'too-long': 'configErrorTooLong',
  'not-an-array': 'configErrorNotArray',
  'url-malformed': 'configErrorUrlMalformed',
  'url-not-http': 'configErrorUrlScheme',
  'words-too-many': 'configErrorWordsTooMany',
  'words-empty-entry': 'configErrorWordsEmpty',
  'words-entry-too-long': 'configErrorWordsEntryTooLong',
  'words-missing-correct': 'configErrorWordsMissingCorrect',
  'words-entry-shape': 'configErrorWordsEntryShape',
  'unknown-spec-type': 'configErrorUnknown',
})

/**
 * 这一条错误该填进句子里的动态值（全部来自 shared 的同一份规则，不是宿主传的）。
 * @param {string} code - 原因码。
 * @param {string} key - 配置键（可能是空串：整份请求体的错）。
 * @returns {object|undefined} 给 `t(key, params)` 的参数；没有占位符时返回 undefined。
 */
function paramsFor(code, key) {
  const spec = key ? specFor(key) : undefined
  switch (code) {
    case 'not-in-enum':
      return spec?.values ? { values: spec.values.join(' / ') } : undefined
    case 'out-of-range':
      return spec ? { min: spec.min, max: spec.max } : undefined
    case 'too-long':
      return spec?.maxLen !== undefined ? { maxLen: spec.maxLen } : undefined
    case 'words-too-many':
      return { max: MAX_WORDS }
    case 'words-entry-too-long':
      return { max: MAX_WORD_CHARS }
    default:
      return undefined
  }
}

/**
 * 把一个原因码翻成界面那句。
 *
 * @param {unknown} reason - 宿主给的 `reason`（应当是码；词表外一律当不认识）。
 * @param {string} key - 出错条目的配置键，用来去 spec 取动态值（可为空串）。
 * @param {(key: string, params?: object) => string} t - 取词函数（i18n）。
 * @param {string} [fallbackKey] - 词表外时用的那句键；调用点可换。
 * @returns {string} `t` 给出的那句。
 */
export function configErrorText(reason, key, t, fallbackKey = 'configErrorUnknown') {
  if (!isConfigErrorCode(reason)) return t(fallbackKey)
  const i18nKey = CONFIG_ERROR_KEYS[reason] ?? fallbackKey
  const params = paramsFor(reason, key)
  return params === undefined ? t(i18nKey) : t(i18nKey, params)
}

/**
 * 这一格的字段名（也是字典出的）。
 * @param {unknown} key - 配置键。
 * @param {(key: string, params?: object) => string} t - 取词函数。
 * @returns {string} 空键返回空串（那句单独成行，不带前缀）。
 */
export function configFieldLabel(key, t) {
  const text = key === undefined || key === null ? '' : String(key)
  if (!text) return ''
  return t(text)
}
