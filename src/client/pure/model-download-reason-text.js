/**
 * 「下载模型」失败那行的原因码 → 界面文案（纯函数，不碰浏览器全局）。
 *
 * 为什么要单独一个模块（批次 22-4-2，docs/architecture-modernization.md §8.71）：
 *   宿主的下载链路现在只回**原因码 + 参数**（`src/shared/model-download-reasons.js`，批次 22-4-1 立的词表），
 *   界面那句话由这里给。改前那条链路有两种相反的毛病（§8.68 的裁定 4）：
 *     ① `POST /model` 被当场拒绝时，面板 `setStatus(body?.error ?? t('downloadFailed'))`
 *        把宿主路由层那句中文（`unknown model: {id}`、`宿主内置模型不可用：{label}`）原样贴上界面；
 *     ② 下载转到后台之后，`model-error` 事件里带了 `model-catalog.js` 的具体原因，
 *        面板却整片丢掉、只留一句「下载失败」—— 用户看不出是网络不通、档位写错还是内容坏了。
 *   一边是原文泄漏，一边是原因丢失，接上码表之后两边都由字典出句子。
 *
 * 映射表住在这里而不是 `voice-settings-section.js`，是因为它需要被单测直接驱动：
 *   词表里每个码都要有对应键（漏一个就是装机上一句生硬的兜底文案），
 *   而词表外的值（宿主版本不一致、脏数据、旧产物）必须走兜底而不是原样显示出来。
 *   覆盖与「占位符 ↔ 参数协议」那两条判据在 `test/i18n-status-line.test.mjs`，
 *   真渲染进树的判据在 `test/client-behavior.test.mjs`。
 *
 * 环境约束（`src/client/pure/*` 的共同规矩）：不依赖浏览器全局、不依赖 React，Node 里可原生 import。
 */
import { isModelDownloadReason, MODEL_DOWNLOAD_REASON_PARAMS } from '../../shared/model-download-reasons.js'

/**
 * 原因码 → i18n 键。命名跟着 `downloadReason*` 走，和 `envReason*` / `hotkeyReason*` 同一族。
 *
 * 每个码一句，**没有合并**：这十个码让人做的事分三类 ——
 * 再试一次（网络类：`file-failed` / `chunk-failed` / `chunk-incomplete` / `merged-size-mismatch` / `sha-mismatch`）、
 * 重试没用（档位本身有问题：`no-downloadable-files` / `file-not-in-repo` / `unknown-model` / `hosted-unavailable`）、
 * 什么都不知道（`failed-unknown`）。合并的代价是把「重试没用」说成「再试一次」，
 * 那是让用户白点按钮。
 */
export const MODEL_DOWNLOAD_REASON_KEYS = Object.freeze({
  'no-downloadable-files': 'downloadReasonNoDownloadableFiles',
  'file-failed': 'downloadReasonFileFailed',
  'file-not-in-repo': 'downloadReasonNotInRepo',
  'chunk-failed': 'downloadReasonChunkFailed',
  'chunk-incomplete': 'downloadReasonChunkIncomplete',
  'merged-size-mismatch': 'downloadReasonMergedSizeMismatch',
  'sha-mismatch': 'downloadReasonShaMismatch',
  'unknown-model': 'downloadReasonUnknownModel',
  'hosted-unavailable': 'downloadReasonHostedUnavailable',
  'failed-unknown': 'downloadReasonFailedUnknown',
})

/**
 * 只填这个码**协议里点名**的参数（`MODEL_DOWNLOAD_REASON_PARAMS`），其余一律不进句子。
 * 宿主多给一个键（未来的码表改动、或诊断字段）不会顺着句子漏到界面上。
 */
function paramsFor(code, params) {
  const given = params && typeof params === 'object' ? params : {}
  const wanted = MODEL_DOWNLOAD_REASON_PARAMS[code] ?? []
  const out = {}
  for (const name of wanted) {
    const value = given[name]
    if (value === undefined || value === null) continue
    out[name] = String(value)
  }
  return out
}

/**
 * 把宿主回的原因码翻成当前语言的句子。
 *
 * 三种「没有码」的情况分开走，因为它们的成因不一样、诚实的说法也不一样：
 *   - `reason` 是空（旧宿主、或面板拿到的是非 2xx 但没有码的响应）→ 短词那句 `downloadFailed`，
 *     这是**兼容路径**，不是数据坏了；
 *   - `reason` 有值但不在词表里（两端版本不一致、脏数据）→ `downloadReasonUnknown`，
 *     承认「读不出来」而不是编一句原因；
 *   - 码在表里、字典里却没有这个键（改了词表忘了改字典）→ 也走 `downloadReasonUnknown`，
 *     这条本该被 `test/i18n-status-line.test.mjs` 的覆盖判据先拦住。
 *
 * @param {unknown} reason - 宿主回的 `reason`（空值与非字符串都算「没带码」）。
 * @param {(key: string, params?: object) => string} t - i18n 取词函数（测试里传恒等函数）。
 * @param {object} [params] - 宿主给的参数（只取这个码要的那几个名字）。
 * @param {string} [noCodeKey] - 完全没带码时用的那句键；调用点可换。
 * @returns {string} 界面要显示的那一句。宿主那句原文**永远不会**从这里出去。
 */
export function modelDownloadReasonText(reason, t, params, noCodeKey = 'downloadFailed') {
  const translate = typeof t === 'function' ? t : (key) => key
  if (reason === undefined || reason === null || reason === '') return translate(noCodeKey)
  if (!isModelDownloadReason(reason)) return translate('downloadReasonUnknown')
  const i18nKey = MODEL_DOWNLOAD_REASON_KEYS[reason] ?? 'downloadReasonUnknown'
  const filled = paramsFor(reason, params)
  return Object.keys(filled).length ? translate(i18nKey, filled) : translate(i18nKey)
}
