/**
 * 「保存设置没存进去」的原因码 —— 宿主与浏览器侧共用的**单源**词表。
 *
 * 为什么需要这一份（批次 20，docs/architecture-modernization.md §8.62）：
 *   设置面板保存时 POST `/config`，宿主校验不过就回 400 `{errors:[{key, reason}]}`，
 *   而这个 `reason` 以前是宿主写的中文句子（`'应为 online / neural / local / sovits 之一'`、
 *   `'长度不能超过 200'`、`'请求体不是合法 JSON'`），客户端 `collectSaveErrors` 把它和
 *   一份**客户端自己手写的中文字段名表**（`UI_SAVE_ERROR_LABELS`）拼成
 *   `${label}：${reason}` 直接显示 —— 一句红字里同时泄漏两处「谁在替界面说话」：
 *   宿主的句子和客户端手写的字段名都没走字典。英文界面上这块是中文。
 *   这是批次 18（§8.60）、批次 19（§8.61）那条链路的第三处。
 *
 * 分工照前两批定：**宿主只报码**（说的是「这个值不合哪条规则」这件事实），
 * **句子由客户端的 i18n 决定**（`src/client/pure/config-error-text.js` 的键），
 * **字段名也由字典决定**（字典里本来就有和配置键同名的标签，见该文件的说明）。
 * 原始的中文句子搬到**另一个字段 `detail`**：只进响应体和日志，永远不进界面 ——
 * 排查时「宿主到底怎么说的」还在，界面上一个字都不显示。
 *
 * 有一点和前两批不同，值得写下来：**这句里需要的动态值不用宿主传**。
 * 允许值列表、数值区间、长度上限这些本来就住在 `src/shared/config-spec.js` 里，
 * 两端读的是同一份 —— 所以宿主只给 `key` + 码，客户端自己按 `key` 去 spec 里取值填进句子。
 * 「第 N 条」那种只有宿主知道的序号不进界面，留在 `detail`。
 *
 * 码表放 `src/shared`，因为它同时被 `src/host/config-schema.js`、`src/host/index.js`
 * 和 `src/client/pure/config-error-text.js` import —— 拼错一处会在两端之一当场红掉。
 *
 * 环境约束（`src/shared/*` 的共同规矩，由 `test/bundle-sync.test.mjs` 机械守卫）：
 *   纯 ESM、零浏览器全局、零 Node API、零 React。
 *
 * **不在这里的东西**：
 *   - 每个码的句子 —— 表现层，住 i18n；
 *   - 规则本身（类型、枚举取值、区间、长度上限）—— 住 `config-spec.js`，
 *     这里的码只说「违反了哪一类规则」，不重复「规则是什么」；
 *   - `/diagnostics` 里的 `configWarnings`（ sanitize 阶段的「已回退默认」告警）——
 *     那是给排查看的，客户端不读，因此不在这份词表里（同 §8.60 对 `/tts/warmup` 的裁定）。
 */

/**
 * 二十个码，按「一次保存从上到下会碰到的顺序」排列（只是给读代码的人看的，不是契约）。
 *
 * 还没轮到逐条规则就先失败的（`key` 是空串）：
 * - `body-not-json`：请求体连 JSON 都解析不了。
 * - `body-too-large`：请求体超过大小上限（413）。
 * - `patch-not-object`：解析出来了，但不是个对象（数组、字符串之类）。
 * - `save-failed`：校验都过了，写盘/重载时抛异常（磁盘、权限、配置文件本身坏了）。
 *
 * 按 `config-spec.js` 的字段类型分的规则不合：
 * - `not-boolean`：要开关，给了别的。
 * - `not-in-enum`：枚举值不在允许列表里。
 * - `not-a-number`：要数字（或数字字符串），给了别的。
 * - `not-integer`：数字给了，但带小数。
 * - `out-of-range`：数字合法，但不在区间内。
 * - `not-a-string`：要文本，给了非字符串（URL 字段的非字符串也算这一条）。
 * - `too-long`：文本或 URL 超过该字段的长度上限。
 * - `not-an-array`：词表字段要数组，给了别的。
 *
 * URL 这一类独有的：
 * - `url-malformed`：不是能解析的 URL。
 * - `url-not-http`：解析出来了，但不是 http(s) 地址。
 *
 * 词表（`words`）独有的：
 * - `words-too-many`：条数超上限。
 * - `words-empty-entry`：有一条是空的。
 * - `words-entry-too-long`：有一条超出单条字符上限（`correct` 或 `replace` 都算，具体哪侧看 `detail`）。
 * - `words-missing-correct`：对象写法里没有 `correct`。
 * - `words-entry-shape`：那条既不是字符串也不是 `{correct, replace}` 对象。
 *
 * 宿主内部写错才可能出现的：
 * - `unknown-spec-type`：某个配置键在 spec 里声明了这份表不认识的类型（是 bug，不是用户填错）。
 *
 * 成功没有码：那时压根没有 400，也没有 `errors`。
 */
export const CONFIG_ERROR_REASONS = Object.freeze({
  BODY_NOT_JSON: 'body-not-json',
  BODY_TOO_LARGE: 'body-too-large',
  PATCH_NOT_OBJECT: 'patch-not-object',
  SAVE_FAILED: 'save-failed',
  NOT_BOOLEAN: 'not-boolean',
  NOT_IN_ENUM: 'not-in-enum',
  NOT_A_NUMBER: 'not-a-number',
  NOT_INTEGER: 'not-integer',
  OUT_OF_RANGE: 'out-of-range',
  NOT_A_STRING: 'not-a-string',
  TOO_LONG: 'too-long',
  NOT_AN_ARRAY: 'not-an-array',
  URL_MALFORMED: 'url-malformed',
  URL_NOT_HTTP: 'url-not-http',
  WORDS_TOO_MANY: 'words-too-many',
  WORDS_EMPTY_ENTRY: 'words-empty-entry',
  WORDS_ENTRY_TOO_LONG: 'words-entry-too-long',
  WORDS_MISSING_CORRECT: 'words-missing-correct',
  WORDS_ENTRY_SHAPE: 'words-entry-shape',
  UNKNOWN_SPEC_TYPE: 'unknown-spec-type',
})

/** 上面那张表的值集合（判据用它比对宿主真正报出来的 `reason`）。 */
export const CONFIG_ERROR_REASON_VALUES = Object.freeze(Object.values(CONFIG_ERROR_REASONS))

/**
 * 这个码是不是词表里的？（宿主与客户端都用它，别各自写 `in` 判断。）
 * @param {unknown} reason - 待检查的值（允许 undefined / 非字符串，一律当「不认识」）。
 * @returns {boolean}
 */
export function isConfigErrorCode(reason) {
  return typeof reason === 'string' && CONFIG_ERROR_REASON_VALUES.includes(reason)
}
